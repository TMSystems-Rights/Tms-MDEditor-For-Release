/**
 * 画像サイズの解釈と、記法へ幅を書き戻す結果を検証する
 * 本番の純粋関数だけを呼び、画像の読み込みや DOM は使わない
 * @file
 */
import { describe, expect, it } from 'vitest';
import { formatMarkdownImage, formatWikiEmbed, parseImageSizeToken, splitImageAlt, splitWikiEmbedTarget } from './imageSize';

describe('imageSize', () => {
	it('|幅 と |幅x高さ を解釈する', () => {
		// 幅だけ。高さは指定なし
		expect(parseImageSizeToken('478')).toEqual({
			// 幅。px
			width: 478,
			// 高さ。null は指定なし
			height: null
		});
		// 幅と高さの両方
		expect(parseImageSizeToken('300x200')).toEqual({
			// 幅。px
			width: 300,
			// 高さ。px
			height: 200
		});
		// 幅の後ろの配置はサイズにしない
		expect(parseImageSizeToken('300|left')).toEqual({
			// 幅。px。配置より前
			width: 300,
			// 高さ。null は指定なし
			height: null
		});
		// 空文字は幅も高さも指定なし
		expect(parseImageSizeToken('')).toEqual({
			// 幅。null は指定なし
			width: null,
			// 高さ。null は指定なし
			height: null
		});
	});

	it('WikiEmbed からパスとサイズを分離する', () => {
		// パスと幅。高さは指定なし
		expect(splitWikiEmbedTarget('_添付ファイル/a.png|478')).toEqual({
			// サイズ区切りより前のパス
			path: '_添付ファイル/a.png',
			// 幅だけ
			size: {
				// 幅。px
				width: 478,
				// 高さ。null は指定なし
				height: null
			}
		});
		// サイズ区切りが無いパス。幅も高さも指定なし
		expect(splitWikiEmbedTarget('C:\\shots\\a.png')).toEqual({
			// 区切りが無いので全体がパス
			path: 'C:\\shots\\a.png',
			// 指定なし
			size: {
				// 幅。null は指定なし
				width: null,
				// 高さ。null は指定なし
				height: null
			}
		});
	});

	it('記法へ幅を書き戻す', () => {
		expect(formatWikiEmbed('C:\\a.png', 320)).toBe('![[C:\\a.png|320]]');
		expect(formatWikiEmbed('C:\\a.png', 320, { escapePipe: true })).toBe('![[C:\\a.png\\|320]]');
		expect(formatMarkdownImage('図', './a.png', 200)).toBe('![図|200](./a.png)');
		expect(formatMarkdownImage('図', './a.png', 200, { escapePipe: true })).toBe('![図\\|200](./a.png)');
		expect(formatMarkdownImage('', './a.png', 200)).toBe('![|200](./a.png)');
	});

	it('表セル用の \\|幅 を解釈する', () => {
		// 表セルのエスケープした区切り。幅だけ
		expect(splitWikiEmbedTarget('C:\\shots\\a.png\\|320')).toEqual({
			// エスケープした区切りより前のパス
			path: 'C:\\shots\\a.png',
			// 幅だけ
			size: {
				// 幅。px
				width: 320,
				// 高さ。null は指定なし
				height: null
			}
		});
		// alt と、エスケープした区切りの幅
		expect(splitImageAlt('図\\|180')).toEqual({
			// 区切りより前の alt
			alt: '図',
			// 幅だけ
			size: {
				// 幅。px
				width: 180,
				// 高さ。null は指定なし
				height: null
			}
		});
	});

	it('標準画像 alt からサイズを分離する', () => {
		// alt と幅。高さは指定なし
		expect(splitImageAlt('図|120')).toEqual({
			// 区切りより前の alt
			alt: '図',
			// 幅だけ
			size: {
				// 幅。px
				width: 120,
				// 高さ。null は指定なし
				height: null
			}
		});
	});
});
