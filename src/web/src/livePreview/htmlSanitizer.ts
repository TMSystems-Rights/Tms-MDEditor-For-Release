/**
 * インライン HTML のホワイトリスト・サニタイズ（仕様 3.3）
 */

/** 許可タグ（小文字） */
export const ALLOWED_HTML_TAGS = new Set([
	'u',
	'b',
	'i',
	'em',
	'strong',
	'mark',
	'sub',
	'sup',
	'span',
	'br',
]);

/** 許可属性（小文字） */
export const ALLOWED_HTML_ATTRIBUTES = new Set(['style', 'class']);

/** 自己閉じとして扱う void タグ */
export const VOID_HTML_TAGS = new Set(['br']);

const TAG_PATTERN  = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)\s*([^>]*)>$/;
const ATTR_PATTERN = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const DANGEROUS_STYLE_PATTERN = /expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|@import|url\s*\(\s*['"]?\s*(?:javascript|vbscript|data)\s*:/i;
const SAFE_CLASS_PATTERN      = /^[a-zA-Z_][\w-]*$/;

export type HtmlTagKind = 'open' | 'close' | 'selfClosing';

export type ParsedHtmlTag = {
	raw: string;
	name: string;
	kind: HtmlTagKind;
	/** パース直後の属性（未サニタイズ） */
	attributes: Record<string, string>;
	allowed: boolean;
};

export type SanitizedHtmlAttributes = {
	className?: string;
	style?: string;
};

/**
 * タグ名が許可リストにあるか
 * @param {string} name タグ名
 * @returns {boolean}
 */
export function isAllowedHtmlTagName(name: string): boolean {
	return ALLOWED_HTML_TAGS.has(name.toLowerCase());
}

/**
 * HTMLTag 生文字列が br 系か
 * @param {string} raw タグ文字列
 * @returns {boolean}
 */
export function isBreakHtmlTag(raw: string): boolean {
	const parsed = parseHtmlTag(raw);
	return parsed !== null && parsed.allowed && parsed.name === 'br' && parsed.kind !== 'close';
}

/**
 * style 値から危険な記述を除去する
 * @param {string} style 生 style
 * @returns {string}
 */
export function sanitizeStyleValue(style: string): string {
	const safeParts: string[] = [];
	for (const part of style.split(';')) {
		const declaration = part.trim();
		if (!declaration) {
			continue;
		}

		if (DANGEROUS_STYLE_PATTERN.test(declaration)) {
			continue;
		}

		safeParts.push(declaration);
	}

	return safeParts.join('; ');
}

/**
 * class 値を安全なトークンだけに絞る
 * @param {string} classValue 生 class
 * @returns {string}
 */
export function sanitizeClassValue(classValue: string): string {
	const tokens = classValue
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0 && SAFE_CLASS_PATTERN.test(token));
	return tokens.join(' ');
}

/**
 * 許可属性のみを残してサニタイズする
 * @param {Record<string, string>} attributes 生属性
 * @returns {SanitizedHtmlAttributes}
 */
export function sanitizeHtmlAttributes(
	attributes: Record<string, string>,
): SanitizedHtmlAttributes {
	const result: SanitizedHtmlAttributes = {};

	for (const [rawName, rawValue] of Object.entries(attributes)) {
		const name = rawName.toLowerCase();
		if (!ALLOWED_HTML_ATTRIBUTES.has(name)) {
			continue;
		}

		if (name === 'style') {
			const style = sanitizeStyleValue(rawValue);
			if (style) {
				result.style = style;
			}
			continue;
		}

		if (name === 'class') {
			const className = sanitizeClassValue(rawValue);
			if (className) {
				result.className = className;
			}
		}
	}

	return result;
}

/**
 * 属性文字列を辞書へパースする
 * @param {string} attributeText タグ内の属性部分
 * @returns {Record<string, string>}
 */
function parseAttributeText(attributeText: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const text                               = attributeText.trim().replace(/\/\s*$/, '');
	if (!text) {
		return attributes;
	}

	ATTR_PATTERN.lastIndex            = 0;
	let match: RegExpExecArray | null = ATTR_PATTERN.exec(text);
	while (match) {
		const name = match[1];
		if (name && name !== '/') {
			const value      = match[2] ?? match[3] ?? match[4] ?? '';
			attributes[name] = value;
		}

		match = ATTR_PATTERN.exec(text);
	}

	return attributes;
}

/**
 * HTML タグ文字列をパースする。不正なら null
 * @param {string} raw 生タグ（例: `<span class="x">`）
 * @returns {ParsedHtmlTag | null}
 */
export function parseHtmlTag(raw: string): ParsedHtmlTag | null {
	const trimmed = raw.trim();
	const match   = TAG_PATTERN.exec(trimmed);
	if (!match) {
		return null;
	}

	const isClose = match[1] === '/';
	const name               = (match[2] ?? '').toLowerCase();
	const attributeText      = match[3] ?? '';
	const selfClosingBySlash = /\/\s*$/.test(attributeText.trim()) || /\/\s*>$/.test(trimmed);
	const attributes         = isClose ? {} : parseAttributeText(attributeText);

	let kind: HtmlTagKind = 'open';
	if (isClose) {
		kind = 'close';
	} else if (selfClosingBySlash || VOID_HTML_TAGS.has(name)) {
		kind = 'selfClosing';
	}

	return {
		raw    : trimmed,
		name,
		kind,
		attributes,
		allowed: isAllowedHtmlTagName(name),
	};
}

/**
 * サニタイズ済み属性を DOM へ適用する
 * @param {HTMLElement} element 要素
 * @param {SanitizedHtmlAttributes} attributes 属性
 * @returns {void}
 */
export function applySanitizedAttributes(
	element: HTMLElement,
	attributes: SanitizedHtmlAttributes,
): void {
	if (attributes.className) {
		element.className = attributes.className;
	}

	if (attributes.style) {
		element.setAttribute('style', attributes.style);
	}
}

/**
 * CodeMirror mark 用の属性オブジェクトを作る
 * @param {string} tagName タグ名
 * @param {SanitizedHtmlAttributes} attributes サニタイズ済み属性
 * @returns {{ tagName: string; class?: string; attributes?: Record<string, string> }}
 */
export function buildHtmlMarkSpec(
	tagName: string,
	attributes: SanitizedHtmlAttributes,
): { tagName: string; class?: string; attributes?: Record<string, string> } {
	const domAttributes: Record<string, string> = {};
	if (attributes.style) {
		domAttributes.style = attributes.style;
	}

	const classParts = ['cm-md-html', `cm-md-html-${tagName}`];
	if (attributes.className) {
		classParts.push(attributes.className);
	}

	return {
		tagName,
		class     : classParts.join(' '),
		attributes: Object.keys(domAttributes).length > 0 ? domAttributes : undefined,
	};
}
