/* eslint-disable jsdoc/require-jsdoc */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
	findMarkdownLinkElement,
	findMarkdownLinkUrlAtPosition,
	isSupportedExternalLinkUrl,
	shouldNormalizeCaretAfterUpdate,
} from './livePreviewPlugin';

describe('livePreviewPlugin', () => {
	it('isSupportedExternalLinkUrl は http/https の絶対URLだけを許可する', () => {
		expect(isSupportedExternalLinkUrl('https://tm-systems.jp/')).toBe(true);
		expect(isSupportedExternalLinkUrl('http://example.com/path')).toBe(true);
		expect(isSupportedExternalLinkUrl('mailto:test@example.com')).toBe(false);
		expect(isSupportedExternalLinkUrl('docs/readme.md')).toBe(false);
		expect(isSupportedExternalLinkUrl('C:\\temp\\readme.md')).toBe(false);
	});

	it('本文変更またはIME composition中にはキャレット補正を行わない', () => {
		expect(shouldNormalizeCaretAfterUpdate(true, true, false)).toBe(false);
		expect(shouldNormalizeCaretAfterUpdate(false, true, true)).toBe(false);
		expect(shouldNormalizeCaretAfterUpdate(false, false, false)).toBe(false);
		expect(shouldNormalizeCaretAfterUpdate(false, true, false)).toBe(true);
	});

	it('findMarkdownLinkElement はテキストノード相当の target から親リンクを取得する', () => {
		const link   = {
			dataset: { href: 'https://tm-systems.jp/' },
		} as unknown as HTMLElement;
		const parent = {
			closest: (selector: string) => selector === '.cm-md-link' ? link : null,
		};
		const target = {
			parentElement: parent,
		} as unknown as EventTarget;

		expect(findMarkdownLinkElement(target)).toBe(link);
	});

	it('findMarkdownLinkUrlAtPosition はリンクテキスト位置から URL を取得する', () => {
		const doc   = 'リンク：[りんく](https://tm-systems.jp/)';
		const state = EditorState.create({
			doc,
			extensions: [markdown({ base: markdownLanguage })],
		});

		expect(findMarkdownLinkUrlAtPosition(state, doc.indexOf('りんく') + 1)).toBe('https://tm-systems.jp/');
	});
});
