/**
 * HTML テキストをエスケープする
 * @param {string} value 生文字列
 * @returns {string}
 */
export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/**
 * 属性値をエスケープする
 * @param {string} value 生文字列
 * @returns {string}
 */
export function escapeAttribute(value: string): string {
	return escapeHtml(value).replaceAll("'", '&#39;');
}

/**
 * インライン用にエスケープし、ソース改行を br にする
 * @param {string} value 生文字列
 * @returns {string}
 */
export function escapeInlineHtml(value: string): string {
	return escapeHtml(value).replace(/\r\n|\n|\r/g, '<br>');
}
