import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { applyImageDisplayWidth } from './imageResize';

/**
 * DOM なしで dispatch できるビュー相当を作る
 * @param {string} doc 本文
 * @returns {EditorView}
 */
function createView(doc: string): EditorView {
	let state = EditorState.create({
		doc,
		extensions: [createTmsMarkdownSupport()],
	});
	return {
		/**
		 * @returns {EditorState}
		 */
		get state() {
			return state;
		},
		/**
		 * @param {TransactionSpec} spec 更新
		 * @returns {void}
		 */
		dispatch(spec: TransactionSpec) {
			state = state.update(spec).state;
		},
	} as EditorView;
}

describe('imageResize', () => {
	it('WikiEmbed へ |幅 を書き戻す', () => {
		const view = createView('![[C:\\shots\\a.png]]');
		expect(applyImageDisplayWidth(view, 0, 320)).toBe(true);
		expect(view.state.doc.toString()).toBe('![[C:\\shots\\a.png|320]]');
	});

	it('標準画像の alt へ |幅 を書き戻す', () => {
		const view = createView('![図](./a.png)');
		expect(applyImageDisplayWidth(view, 0, 180)).toBe(true);
		expect(view.state.doc.toString()).toBe('![図|180](./a.png)');
	});
});
