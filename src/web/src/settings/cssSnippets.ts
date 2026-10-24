/**
 * CSS スニペットを head の style 要素へ入れ替える
 * ファイルの読み込みは持たず、渡された一覧を DOM へ反映する
 * @file
 */
import type { CssSnippetsResponse } from '../types/app';

/**
 * CSS スニペットを注入した style 要素を識別する属性
 * 再適用時はこの属性を持つ要素だけを外し、他の style は残す
 */
export const CSS_SNIPPET_STYLE_ATTRIBUTE = 'data-tms-mde-css-snippet';

/**
 * スニペット再読み込みを画面へ出す結果
 * エラー件数があるときと、一覧自体の失敗のときだけ `isError` を true にする
 */
export type CssSnippetsReloadStatus = {
	/** ステータス行に出す文言 */
	message: string;
	/** 失敗として目立たせるか。有効 0 件はエラーではない */
	isError: boolean;
};

/**
 * CSS スニペット再読み込み結果の表示文言を生成する
 * 一覧自体のエラーを優先し、次にファイルごとの読み込みエラー件数、最後に有効件数を出す
 * @param response - 読み込み結果。`error` があるときはスニペット件数を見ない
 * @returns 表示文言と、失敗として扱うか
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
 * 有効な CSS スニペットを Web UI 全体へ適用する
 * 以前に注入したスニペット style を外してから、有効かつエラーの無いものを一覧の順に head へ足す
 * @param response - 適用するスニペット一覧。無効と読み込みエラーは注入しない
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
