/**
 * 書き出し HTML に埋め込む文字列をエスケープする
 * タグの許可判定は持たず、渡された文字を置換するだけである
 * @file
 */

/**
 * HTML のテキストノードに入れる文字列をエスケープする
 * `&` `<` `>` `"` を実体参照にする。単一引用符はそのまま残す
 * @param value - エスケープ前の文字列
 * @returns テキストとして安全な文字列
 */
export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;') // & は実体参照にする
		.replaceAll('<', '&lt;') // < は実体参照にする
		.replaceAll('>', '&gt;') // > は実体参照にする
		.replaceAll('"', '&quot;'); // " は実体参照にする
}

/**
 * HTML 属性値に入れる文字列をエスケープする
 * テキスト用の置換に加え、単一引用符を `&#39;` にする
 * @param value - エスケープ前の属性値
 * @returns 引用符で囲んでも属性を閉じない文字列
 */
export function escapeAttribute(value: string): string {
	return escapeHtml(value).replaceAll("'", '&#39;');
}

/**
 * インライン用にエスケープし、ソースの改行を `br` にする
 * CR、LF、CRLF は区別せず、いずれも 1 つの `br` にする
 * @param value - 改行を含みうる生文字列
 * @returns 改行が `br` になった HTML 断片
 */
export function escapeInlineHtml(value: string): string {
	return escapeHtml(value).replace(/\r\n|\n|\r/g, '<br>');
}
