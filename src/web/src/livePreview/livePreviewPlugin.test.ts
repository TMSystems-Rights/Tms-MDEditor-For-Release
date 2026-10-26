/**
 * 外部リンクの許可判定と、キャレット補正を避ける条件を検証する
 * リンク要素の探索は最小のモックを使い、プラグインの装飾状態は持たない
 * @file
 */
/* eslint-disable jsdoc/require-jsdoc */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { findMarkdownLinkElement, findMarkdownLinkUrlAtPosition, isSupportedExternalLinkUrl, shouldNormalizeCaretAfterUpdate } from './livePreviewPlugin';

describe('livePreviewPlugin', () => {
	it('isSupportedExternalLinkUrl は http/https の絶対URLだけを許可する', () => {
		expect(isSupportedExternalLinkUrl('https://tm-systems.jp/')).toBe(true);
		expect(isSupportedExternalLinkUrl('http://example.com/path')).toBe(true);
		expect(isSupportedExternalLinkUrl('mailto:test@example.com')).toBe(false);
		expect(isSupportedExternalLinkUrl('docs/readme.md')).toBe(false);
		expect(isSupportedExternalLinkUrl('C:\\temp\\readme.md')).toBe(false);
	});

	it('本文変更またはIME composition中にはキャレット補正を行わない', () => {
		// 引数は本文変更、選択の更新、IME 開始。本文変更があると補正しない
		expect(shouldNormalizeCaretAfterUpdate(true, true, false)).toBe(false);
		// 選択は更新されたが IME が始まっている。補正しない
		expect(shouldNormalizeCaretAfterUpdate(false, true, true)).toBe(false);
		// 本文も選択も変わっていない。補正する更新が無い
		expect(shouldNormalizeCaretAfterUpdate(false, false, false)).toBe(false);
		// 本文は変わらず、選択だけ更新され、IME も始まっていない
		expect(shouldNormalizeCaretAfterUpdate(false, true, false)).toBe(true);
	});

	it('findMarkdownLinkElement はテキストノード相当の target から親リンクを取得する', () => {
		// リンク要素のモック。href だけを持つ
		const link   = {
			dataset: { href: 'https://tm-systems.jp/' }
		} as unknown as HTMLElement;
		// テキストノードの親。リンクのセレクタのときだけ link を返す
		const parent = {
			closest: (selector: string) => (selector === '.cm-md-link' ? link : null)
		};
		// クリック対象。parentElement 以外の DOM は持たない
		const target = {
			parentElement: parent
		} as unknown as EventTarget;

		expect(findMarkdownLinkElement(target)).toBe(link);
	});

	it('findMarkdownLinkUrlAtPosition はリンクテキスト位置から URL を取得する', () => {
		// リンクテキストを含む 1 行。URL の取得位置を indexOf で取る
		const doc   = 'リンク：[りんく](https://tm-systems.jp/)';
		// Markdown 構文木付きの状態。ライブプレビューの装飾は載せない
		const state = EditorState.create({
			// 上で作った本文
			doc,
			// リンクノードを得るための言語サポートだけ
			extensions: [markdown({ base: markdownLanguage })]
		});

		expect(findMarkdownLinkUrlAtPosition(state, doc.indexOf('りんく') + 1)).toBe('https://tm-systems.jp/');
	});
});
