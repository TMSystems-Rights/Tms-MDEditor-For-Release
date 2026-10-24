/**
 * インライン HTML の許可タグと属性を決め、危険な style と class を除く
 * 仕様 3.3 のホワイトリスト。DOM は applySanitizedAttributes に渡された要素だけを変え、解釈結果は新しいオブジェクトで返す
 * @file
 */

// ----------------------------------------------
// 許可するタグと属性
// ----------------------------------------------

/**
 * 装飾してよいタグ名。比較前に小文字化する
 * この集合に無いタグはソースのまま残す。実行中は変えない
 */
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

/**
 * 残してよい属性名。小文字で比較する
 * style と class 以外はマークへ載せない。実行中は変えない
 */
export const ALLOWED_HTML_ATTRIBUTES = new Set(['style', 'class']);

/**
 * 終了タグが無くても自己閉じとして扱うタグ名
 * 現在は br だけ。実行中は変えない
 */
export const VOID_HTML_TAGS = new Set(['br']);

/**
 * 1つの HTML タグを、閉じスラッシュ、名前、属性部分へ分ける
 * タグをまたぐ文字列には一致しない
 */
const TAG_PATTERN  = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)\s*([^>]*)>$/;

/**
 * 属性名と、引用符付きまたは裸の値を取り出す
 * グローバル正規表現のため、走査の前に lastIndex を 0 へ戻す
 */
const ATTR_PATTERN = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * style 宣言から落とす危険な記述
 * expression、スクリプト URL、binding、behavior、@import が対象
 */
const DANGEROUS_STYLE_PATTERN = /expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|@import|url\s*\(\s*['"]?\s*(?:javascript|vbscript|data)\s*:/i;

/**
 * class トークンとして残す文字
 * 英字または `_` で始まり、以降は英数字、`_`、`-` のみ
 */
const SAFE_CLASS_PATTERN      = /^[a-zA-Z_][\w-]*$/;

/**
 * HTML タグの開閉種別
 * br のように void のタグは、スラッシュが無くても selfClosing になる
 */
export type HtmlTagKind = 'open' | 'close' | 'selfClosing';

/**
 * 1つの HTML タグの解釈結果
 * 不正な文字列は作らず null を返す側に任せる。属性はまだサニタイズしていない
 */
export type ParsedHtmlTag = {
	/** 前後の空白を除いたタグ文字列 */
	raw: string;
	/** 小文字のタグ名。許可判定の前に正規化する */
	name: string;
	/** 開始、終了、自己閉じのいずれか */
	kind: HtmlTagKind;
	/** パース直後の属性。未サニタイズ。閉じタグは空 */
	attributes: Record<string, string>;
	/** タグ名が許可リストにあるなら true。属性の安全性とは別 */
	allowed: boolean;
};

/**
 * 許可属性だけを残した class と style
 * 空になった属性はプロパティ自体を置かない
 */
export type SanitizedHtmlAttributes = {
	/** 安全なクラスだけを空白区切りにしたもの。残らなければ未設定 */
	className?: string;
	/** 危険な宣言を除いた style。残らなければ未設定 */
	style?: string;
};

// ----------------------------------------------
// 許可タグの判定
// ----------------------------------------------

/**
 * タグ名が許可リストにあるかを、小文字化して判定する
 * @param name - 判定するタグ名。大文字を含んでよい
 * @returns 許可タグなら true
 */
export function isAllowedHtmlTagName(name: string): boolean {
	return ALLOWED_HTML_TAGS.has(name.toLowerCase());
}

/**
 * HTML タグ文字列が、装飾上の改行になる br かを判定する
 * 閉じタグと、許可されない名前は改行にしない
 * @param raw - 判定するタグ文字列。前後の空白は parseHtmlTag が除く
 * @returns 許可された br の開始または自己閉じなら true
 */
export function isBreakHtmlTag(raw: string): boolean {
	const parsed = parseHtmlTag(raw);
	return parsed !== null && parsed.allowed && parsed.name === 'br' && parsed.kind !== 'close';
}

// ----------------------------------------------
// 属性のサニタイズ
// ----------------------------------------------

/**
 * style 値から危険な宣言を除き、残った宣言を `; ` でつなぐ
 * 空の宣言は捨て、すべて危険なら空文字を返す
 * @param style - 生の style 属性値。セミコロン区切り
 * @returns 残した宣言。無ければ空文字
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
 * class 値を、安全なトークンだけに絞って空白区切りで返す
 * 引用符や記号を含むトークンは捨てる
 * @param classValue - 生の class 属性値
 * @returns 残したクラス名。無ければ空文字
 */
export function sanitizeClassValue(classValue: string): string {
	const tokens = classValue
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0 && SAFE_CLASS_PATTERN.test(token));
	return tokens.join(' ');
}

/**
 * 許可属性だけを残し、style と class をそれぞれサニタイズする
 * 入力のオブジェクトは変えず、空になった属性は結果に入れない
 * @param attributes - パース直後の属性。キーの大文字は小文字化して比較する
 * @returns 残った class と style。両方空なら空オブジェクト
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

// ----------------------------------------------
// タグ文字列の分解
// ----------------------------------------------

/**
 * タグ内の属性文字列を、名前から値への対応へ分ける
 * 共有の ATTR_PATTERN は lastIndex を持つため、走査前に 0 へ戻す
 * @param attributeText - タグ名より後ろの属性部分。末尾のスラッシュは無視する
 * @returns 属性名から値への対応。属性が無ければ空。値の無い属性は空文字
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
 * HTML タグ文字列を解釈する
 * タグの形でなければ null。属性の危険性はこの時点では落とさない
 * @param raw - 生タグ。例は `<span class="x">`。前後の空白は除いて判定する
 * @returns 解釈結果。タグの形でなければ null
 */
export function parseHtmlTag(raw: string): ParsedHtmlTag | null {
	const trimmed = raw.trim();
	const match   = TAG_PATTERN.exec(trimmed);
	if (!match) {
		return null;
	}

	const isClose            = match[1] === '/';
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

// ----------------------------------------------
// DOM と mark への適用
// ----------------------------------------------

/**
 * サニタイズ済みの class と style を、渡された要素へ書く
 * 未設定の属性は触らない。style はプロパティではなく属性として入れる
 * @param element - 属性を書く要素。この関数が className と style を更新する
 * @param attributes - 適用する class と style。空のプロパティは書かない
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
 * サニタイズ済み属性を、CodeMirror の mark 仕様へ移す
 * クラスは html 用の印とタグ名を必ず含め、利用者の class を後ろへ足す
 * @param tagName - mark の要素名。許可タグの小文字名
 * @param attributes - 載せる class と style。style が空なら attributes 自体を付けない
 * @returns tagName、結合した class、残った DOM 属性。style が無ければ attributes は undefined
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
