/**
 * HTML ブロックから表だけを取り出し、許可したタグと属性の文字列へ戻す
 * エディタ状態は持たず、style と class の危険な値は htmlSanitizer に任せる
 * @file
 */
import {
	ALLOWED_HTML_TAGS,
	sanitizeClassValue,
	sanitizeStyleValue,
} from './htmlSanitizer';

// ----------------------------------------------
// 表として残すタグ
// ----------------------------------------------

/**
 * 表の構造として残すタグ名。小文字で比較する
 * インラインの許可タグは htmlSanitizer 側の集合を別に見る。実行中は変えない
 */
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

/**
 * td と th にだけ残す数値属性
 * 値は 1 より大きい整数のときだけ書き戻す。実行中は変えない
 */
const TABLE_ONLY_ATTRIBUTES = new Set(['colspan', 'rowspan']);

/**
 * コメント、タグ、それ以外のテキストへ分ける
 * タグの入れ子は見ず、断片の走査順だけを決める
 */
const TOKEN_PATTERN         = /<!--[\s\S]*?-->|<\/?[a-zA-Z][\w:-]*\b[^>]*>|[^<]+/g;

/**
 * 開始タグを、タグ名と属性部分へ分ける
 * 自己閉じの末尾スラッシュは、照合前に呼び出し側が除く
 */
const OPEN_TAG_PATTERN      = /^<\s*([a-zA-Z][\w:-]*)\s*([^>]*)>$/;

/**
 * 終了タグからタグ名を取り出す
 * 属性付きの終了タグには一致しない
 */
const CLOSE_TAG_PATTERN     = /^<\s*\/\s*([a-zA-Z][\w:-]*)\s*>$/;

/**
 * 属性名と、引用符付きまたは裸の値を取り出す
 * グローバル正規表現のため、走査の前に lastIndex を 0 へ戻す
 */
const ATTR_PATTERN          = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * 終了タグが無くても中身を持たないタグ
 * 表の中で落とす対象の入れ子深さを増やさないために使う
 */
const VOID_TAGS             = new Set(['br', 'img']);

/**
 * タグだけでなく、中身もまとめて落とすタグ名
 * script や style のテキストが表へ漏れないようにする
 */
const DROP_WITH_CONTENT     = new Set(['script', 'style', 'iframe', 'object', 'embed']);

// ----------------------------------------------
// 表ブロックの取り出し
// ----------------------------------------------

/**
 * ブロックの先頭が table 開始タグかを判定する
 * 前後の空白は無視し、タグ名の大文字は区別しない
 * @param text - 判定する HTML ブロック
 * @returns 先頭が table 開始タグなら true
 */
export function isHtmlTableBlock(text: string): boolean {
	return /^\s*<table\b/i.test(text);
}

/**
 * HTML から表だけを取り、許可したタグと属性だけを残す
 * 表が無い、またはサニタイズ後に空なら null。複数の表は改行でつなぐ
 * @param html - サニタイズ前の HTML。表の前後の文章は捨てる
 * @returns サニタイズ済みの表。取り出せなければ null
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
 * 文字列の中から、入れ子を含めた table 要素を順に取り出す
 * 閉じタグが釣り合わない表に当たったら、そこで走査を終える
 * @param html - 検索する HTML 全文
 * @returns 表ごとの HTML。1 件も無ければ空
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
 * 開始位置から、入れ子の深さが 0 に戻るまで table を読む
 * 閉じタグが文書末まで無いときは、残りの文字列を表として返す。開始タグ自体が見つからなければ null
 * @param source - 検索する HTML 全文
 * @param from - `<table` の開始位置
 * @returns html は取り出した表、end はその直後の位置。開始タグが閉じられない形なら null
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

// ----------------------------------------------
// 断片のサニタイズ
// ----------------------------------------------

/**
 * 1 つの表から、コメントと不許可の中身を除いた HTML を返す
 * 不許可タグは終了までスキップし、テキストはエスケープして残す
 * @param fragment - 1 つの table 要素の HTML
 * @returns 許可タグだけをつないだ文字列。空なら空文字
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
 * 開始タグの属性文字列を、名前から値への対応へ分ける
 * 共有の ATTR_PATTERN は lastIndex を持つため、走査前に 0 へ戻す
 * @param attributeText - タグ名より後ろの属性部分。末尾のスラッシュは無視する
 * @returns 属性名から値への対応。属性が無ければ空
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
 * 表タグに残してよい属性だけを、HTML 属性文字列へ戻す
 * colspan と rowspan は td と th の 1 より大きい整数だけを残す
 * @param tagName - 小文字のタグ名。結合属性を残すかの判定に使う
 * @param attributes - パース直後の属性。危険な style と class はここで落とす
 * @returns 先頭に空白を付けた属性列。残る属性が無ければ空文字
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

// ----------------------------------------------
// テキストのエスケープ
// ----------------------------------------------

/**
 * 表のテキストノードに残す文字列をエスケープする
 * 引用符はテキストでは変換しない
 * @param value - タグ以外のテキスト
 * @returns `&`、`<`、`>` を実体参照へ置き換えた文字列
 */
function escapeHtmlText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

/**
 * 属性値に残す文字列をエスケープする
 * テキスト用の変換に加え、二重引用符も実体参照にする
 * @param value - 引用符で囲む前の属性値
 * @returns 属性値として安全な文字列
 */
function escapeAttribute(value: string): string {
	return escapeHtmlText(value).replaceAll('"', '&quot;');
}
