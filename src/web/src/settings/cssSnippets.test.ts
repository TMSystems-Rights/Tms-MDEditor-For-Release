import { describe, expect, it } from 'vitest';
import { getCssSnippetsReloadStatus } from './cssSnippets';

describe('getCssSnippetsReloadStatus', () => {
	it('ファイルが存在しても未有効なら有効なファイルがないことを表示する', () => {
		const status = getCssSnippetsReloadStatus({
			directoryPath : 'C:\\data\\snippets',
			snippets      : [{ name: 'my-style6.css', enabled: false, cssText: '.tms-custom-1 {}' }],
		});

		expect(status).toEqual({
			message : 'CSSスニペットを再読み込みしました（有効なファイルはありません）。',
			isError : false,
		});
	});

	it('有効なファイル数を表示する', () => {
		const status = getCssSnippetsReloadStatus({
			directoryPath : 'C:\\data\\snippets',
			snippets      : [
				{ name: 'one.css', enabled: true, cssText: '.one {}' },
				{ name: 'two.css', enabled: false, cssText: '.two {}' },
			],
		});

		expect(status.message).toBe('CSSスニペットを再読み込みしました（有効 1件）。');
		expect(status.isError).toBe(false);
	});

	it('読み込みエラー件数をエラーとして表示する', () => {
		const status = getCssSnippetsReloadStatus({
			directoryPath : 'C:\\data\\snippets',
			snippets      : [{ name: 'broken.css', enabled: true, cssText: '', error: 'read error' }],
		});

		expect(status.message).toBe('CSSスニペットを再読み込みしました（1件の読み込みエラー）。');
		expect(status.isError).toBe(true);
	});
});
