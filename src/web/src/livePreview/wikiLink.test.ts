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
			hideLength: 'docs/要望_009|'.length,
			alias     : '要望_009',
		});
	});

	it('表セルの \\| 右側をラベルにする', () => {
		expect(splitWikiLinkAlias('docs/要望_009\\|要望_009')).toEqual({
			hideLength: 'docs/要望_009\\|'.length,
			alias     : '要望_009',
		});
	});

	it('区切りが無ければページ全体を表示する', () => {
		expect(splitWikiLinkAlias('docs/要望_009')).toEqual({
			hideLength: 0,
			alias     : null,
		});
	});

	it('空のラベルはページ全体を表示する', () => {
		expect(splitWikiLinkAlias('docs/要望_009|')).toEqual({
			hideLength: 0,
			alias     : null,
		});
		expect(splitWikiLinkAlias('docs/要望_009\\|')).toEqual({
			hideLength: 0,
			alias     : null,
		});
	});
});
