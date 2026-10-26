/**
 * スニペット再読み込みの表示文言が、有効件数とエラーを区別することを確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { getCssSnippetsReloadStatus } from './cssSnippets';

describe('getCssSnippetsReloadStatus', () => {
	it('ファイルが存在しても未有効なら有効なファイルがないことを表示する', () => {
		// ファイルはあるが有効件数が 0 の再読み込み結果
		const status = getCssSnippetsReloadStatus({
			// スニペットのディレクトリ。件数の文言には出ない
			directoryPath: 'C:\\data\\snippets',
			// 無効な 1 件だけ。有効なファイルはない
			snippets: [
				{
					// ファイル名。無効なので件数に数えない
					name: 'my-style6.css',
					// 無効。有効件数は 0
					enabled: false,
					// 中身はあるが、無効なので表示文言には使わない
					cssText: '.tms-custom-1 {}'
				}
			]
		});

		expect(status).toEqual({
			// 有効なファイルが無いときの文言
			message: 'CSSスニペットを再読み込みしました（有効なファイルはありません）。',
			// 読み込み失敗ではない
			isError: false
		});
	});

	it('有効なファイル数を表示する', () => {
		// 有効 1 件、無効 1 件。文言は有効件数だけを出す
		const status = getCssSnippetsReloadStatus({
			// スニペットのディレクトリ。文言には出ない
			directoryPath: 'C:\\data\\snippets',
			// 有効と無効が混ざる。数えるのは enabled が true の件
			snippets: [
				// 有効なスニペット。件数 1 に入る
				{
					// ファイル名
					name: 'one.css',
					// 有効。件数に含める
					enabled: true,
					// CSS 本文。文言には出さない
					cssText: '.one {}'
				},
				// 無効なスニペット。件数に含めない
				{
					// ファイル名
					name: 'two.css',
					// 無効
					enabled: false,
					// CSS 本文。無効なので表示しない
					cssText: '.two {}'
				}
			]
		});

		expect(status.message).toBe('CSSスニペットを再読み込みしました（有効 1件）。');
		expect(status.isError).toBe(false);
	});

	it('読み込みエラー件数をエラーとして表示する', () => {
		// 有効だが読み込みに失敗した 1 件。エラー文言になる
		const status = getCssSnippetsReloadStatus({
			// スニペットのディレクトリ。文言には出ない
			directoryPath: 'C:\\data\\snippets',
			// エラー付きの 1 件。有効でも本文は空
			snippets: [
				{
					// 失敗したファイル名
					name: 'broken.css',
					// 有効にしたいが、読み込みに失敗している
					enabled: true,
					// 本文は空。エラーがあるので採用しない
					cssText: '',
					// 読み込み失敗の理由。件数は 1
					error: 'read error'
				}
			]
		});

		expect(status.message).toBe('CSSスニペットを再読み込みしました（1件の読み込みエラー）。');
		expect(status.isError).toBe(true);
	});
});
