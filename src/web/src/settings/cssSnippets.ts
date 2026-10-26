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
	// 一覧自体の失敗。件数は見ずにその文言を失敗として出す
	if (response.error) {
		// 一覧取得の失敗。スニペット件数は使わない
		return {
			// ステータス行。ホストが返したエラー文言
			message: response.error,
			// 失敗として目立たせる
			isError: true
		};
	}

	// ファイルごとの読み込みエラー件数。0 なら有効件数の文言へ進む
	const errorCount = response.snippets.filter((snippet) => snippet.error).length;
	// 1 件でも読めなかったファイルがある。再読み込み自体は終わっている
	if (errorCount > 0) {
		// 部分失敗。有効件数よりエラー件数を優先する
		return {
			// ステータス行。エラー件数を含む
			message: `CSSスニペットを再読み込みしました（${errorCount}件の読み込みエラー）。`,
			// 読めないファイルがあるので失敗表示
			isError: true
		};
	}

	// 有効なスニペット件数。0 なら有効ファイル無しの文言
	const enabledCount = response.snippets.filter((snippet) => snippet.enabled).length;
	// エラーの無い再読み込み結果。有効 0 件は失敗にしない
	return {
		// ステータス行。有効件数があるときと無いときで文言が分かれる
		message: enabledCount > 0 ? `CSSスニペットを再読み込みしました（有効 ${enabledCount}件）。` : 'CSSスニペットを再読み込みしました（有効なファイルはありません）。',
		// 失敗表示にはしない
		isError: false
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
			// 1 件分の style。無効と読み込みエラーは filter で除いてある
			const style        = document.createElement('style');
			style.dataset.name = snippet.name;
			style.textContent  = snippet.cssText;
			style.setAttribute(CSS_SNIPPET_STYLE_ATTRIBUTE, '');
			document.head.appendChild(style);
		});
}
