import type { CssSnippetsResponse } from '../types/app';

/** CSSスニペットを注入した style 要素を識別する属性 */
export const CSS_SNIPPET_STYLE_ATTRIBUTE = 'data-tms-mde-css-snippet';

export type CssSnippetsReloadStatus = {
	message: string;
	isError: boolean;
};

/**
 * CSSスニペット再読み込み結果の表示文言を生成する。
 * @param {CssSnippetsResponse} response スニペット一覧
 * @returns {CssSnippetsReloadStatus} 表示文言とエラー状態
 */
export function getCssSnippetsReloadStatus(response: CssSnippetsResponse): CssSnippetsReloadStatus {
	if (response.error) {
		return { message: response.error, isError: true };
	}

	const errorCount = response.snippets.filter((snippet) => snippet.error).length;
	if (errorCount > 0) {
		return {
			message : `CSSスニペットを再読み込みしました（${errorCount}件の読み込みエラー）。`,
			isError : true,
		};
	}

	const enabledCount = response.snippets.filter((snippet) => snippet.enabled).length;
	return {
		message : enabledCount > 0
			? `CSSスニペットを再読み込みしました（有効 ${enabledCount}件）。`
			: 'CSSスニペットを再読み込みしました（有効なファイルはありません）。',
		isError : false,
	};
}

/**
 * 有効な CSS スニペットを Web UI 全体へ適用する。
 * @param {CssSnippetsResponse} response スニペット一覧
 * @returns {void}
 */
export function applyCssSnippets(response: CssSnippetsResponse): void {
	document.head.querySelectorAll(`style[${CSS_SNIPPET_STYLE_ATTRIBUTE}]`).forEach((style) => style.remove());

	response.snippets
		.filter((snippet) => snippet.enabled && !snippet.error)
		.forEach((snippet) => {
			const style        = document.createElement('style');
			style.dataset.name = snippet.name;
			style.textContent  = snippet.cssText;
			style.setAttribute(CSS_SNIPPET_STYLE_ATTRIBUTE, '');
			document.head.appendChild(style);
		});
}
