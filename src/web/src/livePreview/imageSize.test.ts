import { describe, expect, it } from 'vitest';
import {
	formatMarkdownImage,
	formatWikiEmbed,
	parseImageSizeToken,
	splitImageAlt,
	splitWikiEmbedTarget,
} from './imageSize';

describe('imageSize', () => {
	it('|幅 と |幅x高さ を解釈する', () => {
		expect(parseImageSizeToken('478')).toEqual({ width: 478, height: null });
		expect(parseImageSizeToken('300x200')).toEqual({ width: 300, height: 200 });
		expect(parseImageSizeToken('300|left')).toEqual({ width: 300, height: null });
		expect(parseImageSizeToken('')).toEqual({ width: null, height: null });
	});

	it('WikiEmbed からパスとサイズを分離する', () => {
		expect(splitWikiEmbedTarget('_添付ファイル/a.png|478')).toEqual({
			path: '_添付ファイル/a.png',
			size: { width: 478, height: null },
		});
		expect(splitWikiEmbedTarget('C:\\shots\\a.png')).toEqual({
			path: 'C:\\shots\\a.png',
			size: { width: null, height: null },
		});
	});

	it('記法へ幅を書き戻す', () => {
		expect(formatWikiEmbed('C:\\a.png', 320)).toBe('![[C:\\a.png|320]]');
		expect(formatMarkdownImage('図', './a.png', 200)).toBe('![図|200](./a.png)');
		expect(formatMarkdownImage('', './a.png', 200)).toBe('![|200](./a.png)');
	});

	it('標準画像 alt からサイズを分離する', () => {
		expect(splitImageAlt('図|120')).toEqual({
			alt : '図',
			size: { width: 120, height: null },
		});
	});
});
