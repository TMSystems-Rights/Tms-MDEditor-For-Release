/**
 * Wiki リンクのエイリアス分離が、区切り文字と空ラベルをどう扱うかを検証する
 * 本番の splitWikiLinkAlias だけを呼び、エディタ状態は持たない
 * @file
 */
import { describe, expect, it } from 'vitest';
import { splitWikiLinkAlias } from './wikiLink';

describe('splitWikiLinkAlias', () => {
	it('本文の | 右側をラベルにする', () => {
		expect(splitWikiLinkAlias('docs/要望_009|要望_009')).toEqual({
			// 隠す本文側の長さ。区切りの | までを含む
			hideLength: 'docs/要望_009|'.length,
			// 表示するラベル。空ではない
			alias: '要望_009'
		});
	});

	it('表セルの \\| 右側をラベルにする', () => {
		expect(splitWikiLinkAlias('docs/要望_009\\|要望_009')).toEqual({
			// 隠す本文側の長さ。エスケープした \\| までを含む
			hideLength: 'docs/要望_009\\|'.length,
			// 表示するラベル。表セルでも | の右側
			alias: '要望_009'
		});
	});

	it('区切りが無ければページ全体を表示する', () => {
		expect(splitWikiLinkAlias('docs/要望_009')).toEqual({
			// 隠す文字は無い。ページ全体を出す
			hideLength: 0,
			// ラベルは無い。null はページ名をそのまま出す
			alias: null
		});
	});

	it('空のラベルはページ全体を表示する', () => {
		expect(splitWikiLinkAlias('docs/要望_009|')).toEqual({
			// 空ラベルは隠さない。0 はページ全体
			hideLength: 0,
			// 右側が空なのでラベルなし
			alias: null
		});
		expect(splitWikiLinkAlias('docs/要望_009\\|')).toEqual({
			// 表セルの空ラベルも隠さない
			hideLength: 0,
			// エスケープ区切りの右側が空
			alias: null
		});
	});
});
