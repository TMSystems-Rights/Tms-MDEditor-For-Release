import {
	ALLOWED_HTML_TAGS,
	sanitizeClassValue,
	sanitizeStyleValue,
} from './htmlSanitizer';

const TABLE_TAGS = new Set([
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'th',
	'td',
	'caption',
]);

const TABLE_ONLY_ATTRIBUTES = new Set(['colspan', 'rowspan']);
const TOKEN_PATTERN         = /<!--[\s\S]*?-->|<\/?[a-zA-Z][\w:-]*\b[^>]*>|[^<]+/g;
const OPEN_TAG_PATTERN      = /^<\s*([a-zA-Z][\w:-]*)\s*([^>]*)>$/;
const CLOSE_TAG_PATTERN     = /^<\s*\/\s*([a-zA-Z][\w:-]*)\s*>$/;
const ATTR_PATTERN          = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const VOID_TAGS             = new Set(['br', 'img']);
const DROP_WITH_CONTENT     = new Set(['script', 'style', 'iframe', 'object', 'embed']);

/**
 * ブロックが HTML 表か。
 * @param {string} text HTML ブロック
 * @returns {boolean}
 */
export function isHtmlTableBlock(text: string): boolean {
	return /^\s*<table\b/i.test(text);
}

/**
 * HTML から表だけを取り、許可タグ・属性だけ残す。
 * @param {string} html 生 HTML
 * @returns {string | null}
 */
export function sanitizeHtmlTable(html: string): string | null {
	const tables = extractTableFragments(html);
	if (tables.length === 0) {
		return null;
	}

	const sanitized = tables
		.map((fragment) => sanitizeTableFragment(fragment))
		.filter((fragment) => fragment.length > 0);
	return sanitized.length > 0 ? sanitized.join('\n') : null;
}

/**
 * @param {string} html 生 HTML
 * @returns {string[]}
 */
function extractTableFragments(html: string): string[] {
	const fragments: string[] = [];
	const source              = html;
	let cursor                = 0;
	while (cursor < source.length) {
		const start = source.slice(cursor).search(/<table\b/i);
		if (start < 0) {
			break;
		}

		const from      = cursor + start;
		const extracted = readBalancedTable(source, from);
		if (!extracted) {
			break;
		}

		fragments.push(extracted.html);
		cursor = extracted.end;
	}

	return fragments;
}

/**
 * @param {string} source HTML
 * @param {number} from `<table` の位置
 * @returns {{ html: string; end: number } | null}
 */
function readBalancedTable(source: string, from: number): { html: string; end: number } | null {
	let depth  = 0;
	let cursor = from;
	while (cursor < source.length) {
		const next = source.slice(cursor).search(/<\/?table\b/i);
		if (next < 0) {
			return depth > 0 ? { html: source.slice(from), end: source.length } : null;
		}

		const index   = cursor + next;
		const isClose = /^<\s*\//.test(source.slice(index));
		const tagEnd  = source.indexOf('>', index);
		if (tagEnd < 0) {
			return { html: source.slice(from), end: source.length };
		}

		if (isClose) {
			depth -= 1;
			cursor = tagEnd + 1;
			if (depth <= 0) {
				return { html: source.slice(from, cursor), end: cursor };
			}
		} else {
			depth += 1;
			cursor = tagEnd + 1;
		}
	}

	return { html: source.slice(from), end: source.length };
}

/**
 * @param {string} fragment 1 表
 * @returns {string}
 */
function sanitizeTableFragment(fragment: string): string {
	const tokens              = fragment.match(TOKEN_PATTERN) ?? [];
	const parts: string[]     = [];
	const skipStack: string[] = [];

	for (const token of tokens) {
		if (token.startsWith('<!--')) {
			continue;
		}

		const close = CLOSE_TAG_PATTERN.exec(token.trim());
		if (close) {
			const name = close[1]!.toLowerCase();
			if (skipStack.length > 0) {
				if (skipStack[skipStack.length - 1] === name) {
					skipStack.pop();
				}

				continue;
			}

			if (TABLE_TAGS.has(name) || ALLOWED_HTML_TAGS.has(name)) {
				parts.push(`</${name}>`);
			}

			continue;
		}

		const open = OPEN_TAG_PATTERN.exec(token.trim().replace(/\/\s*>$/, '>'));
		if (open) {
			const name = open[1]!.toLowerCase();
			if (skipStack.length > 0) {
				if (!VOID_TAGS.has(name) && !token.trim().endsWith('/>')) {
					skipStack.push(name);
				}

				continue;
			}

			if (DROP_WITH_CONTENT.has(name)) {
				if (!VOID_TAGS.has(name) && !token.trim().endsWith('/>')) {
					skipStack.push(name);
				}

				continue;
			}

			if (!TABLE_TAGS.has(name) && !ALLOWED_HTML_TAGS.has(name)) {
				if (!VOID_TAGS.has(name) && !token.trim().endsWith('/>')) {
					skipStack.push(name);
				}

				continue;
			}

			const attrs = sanitizeTableAttributes(name, parseAttributes(open[2] ?? ''));
			const slash = VOID_TAGS.has(name) || token.trim().endsWith('/>') ? '' : '';
			parts.push(`<${name}${attrs}${slash}>`);
			continue;
		}

		if (skipStack.length === 0) {
			parts.push(escapeHtmlText(token));
		}
	}

	return parts.join('').trim();
}

/**
 * @param {string} attributeText 属性
 * @returns {Record<string, string>}
 */
function parseAttributes(attributeText: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const text                               = attributeText.trim().replace(/\/\s*$/, '');
	ATTR_PATTERN.lastIndex                   = 0;
	let match: RegExpExecArray | null        = ATTR_PATTERN.exec(text);
	while (match) {
		const name = match[1];
		if (name && name !== '/') {
			attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
		}

		match = ATTR_PATTERN.exec(text);
	}

	return attributes;
}

/**
 * @param {string} tagName タグ
 * @param {Record<string, string>} attributes 属性
 * @returns {string}
 */
function sanitizeTableAttributes(tagName: string, attributes: Record<string, string>): string {
	const parts: string[] = [];
	for (const [rawName, rawValue] of Object.entries(attributes)) {
		const name = rawName.toLowerCase();
		if (name === 'style') {
			const style = sanitizeStyleValue(rawValue);
			if (style) {
				parts.push(` style="${escapeAttribute(style)}"`);
			}

			continue;
		}

		if (name === 'class') {
			const className = sanitizeClassValue(rawValue);
			if (className) {
				parts.push(` class="${escapeAttribute(className)}"`);
			}

			continue;
		}

		if (TABLE_ONLY_ATTRIBUTES.has(name) && (tagName === 'td' || tagName === 'th')) {
			const value = Number.parseInt(rawValue, 10);
			if (Number.isFinite(value) && value > 1) {
				parts.push(` ${name}="${value}"`);
			}
		}
	}

	return parts.join('');
}

/**
 * @param {string} value テキスト
 * @returns {string}
 */
function escapeHtmlText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

/**
 * @param {string} value 属性
 * @returns {string}
 */
function escapeAttribute(value: string): string {
	return escapeHtmlText(value).replaceAll('"', '&quot;');
}
