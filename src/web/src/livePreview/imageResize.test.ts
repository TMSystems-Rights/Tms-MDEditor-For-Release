import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import {
	applyImageDisplayWidth,
	applyImageWidthByPath,
	applyImageWidthOnDocumentLine,
	findImageMarkupAt,
	replaceImageWidthInCellText,
} from './imageResize';
import { bindImageWrapEditorView, persistImageResizeWidth } from './imageWidget';

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

	it('表セル内では \\|幅 を書き戻す', () => {
		const view = createView('|   |\n|---|\n|![[C:\\\\shots\\\\a.png]]|\n');
		const pos  = view.state.doc.toString().indexOf('![[');
		expect(applyImageDisplayWidth(view, pos, 160)).toBe(true);
		expect(view.state.doc.toString()).toContain('![[C:\\\\shots\\\\a.png\\|160]]');
	});

	it('複数列表でも行スキャンで画像記法を見つけ \\|幅 を書き戻す', () => {
		const doc  = '| a | 画像 | b |\n| --- | --- | --- |\n| 1 | ![[C:\\\\shots\\\\a.png]] | 2 |\n';
		const view = createView(doc);
		const pos  = view.state.doc.toString().indexOf('![[');
		const end  = view.state.doc.toString().indexOf(']]', pos) + 2;
		expect(findImageMarkupAt(view.state, pos, end)?.kind).toBe('WikiEmbed');
		expect(applyImageDisplayWidth(view, pos, 72, end)).toBe(true);
		expect(view.state.doc.toString()).toContain('![[C:\\\\shots\\\\a.png\\|72]]');
	});

	it('検証表4行目の Windows パスを探して表用 \\|幅 を書く', () => {
		const princess = '|プリンセス|ユイ(プリンセス)|プリユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png]]|光|';
		const doc      = [
			'|   |   |   |   |   |',
			'|---|---|---|---|---|',
			'|クリスマス|ユイ(クリスマス)|クリユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png]]|火|',
			'|サマー|ユイ(サマー)|水ユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image002.png]]|水|',
			'|ニューイヤー|ユイ(ニューイヤー)|正月ユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image003.png]]|光|',
			princess,
		].join('\n');
		const view     = createView(doc);
		const path     = 'C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png';
		expect(applyImageWidthByPath(view, path, 430)).toBe(true);
		expect(view.state.doc.toString()).toContain(
			'![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png\\|430]]',
		);
		expect(view.state.doc.toString()).toContain('|光|');
		expect(view.state.doc.toString()).not.toContain('png|430]]|光|');
		expect(view.state.doc.toString()).toContain('clip_image003.png]]');
	});

	it('Windows 絶対パスの表行でも行テキストへ \\|幅 を書く', () => {
		const doc  = [
			'|   |   |   |   |   |',
			'|---|---|---|---|---|',
			'|クリスマス|ユイ(クリスマス)|クリユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png]]|火|',
		].join('\n');
		const view = createView(doc);
		const pos  = view.state.doc.toString().indexOf('![[');
		expect(applyImageWidthOnDocumentLine(view, pos, 96)).toBe(true);
		expect(view.state.doc.toString()).toContain(
			'![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png\\|96]]',
		);
		expect(view.state.doc.toString()).toContain('|火|');
	});

	it('セル文字列の画像へ \\|幅 を書き込む', () => {
		expect(replaceImageWidthInCellText('![[C:\\shots\\a.png]]', 88)).toBe('![[C:\\shots\\a.png\\|88]]');
		expect(replaceImageWidthInCellText('![[C:\\shots\\a.png\\|40]]', 88)).toBe('![[C:\\shots\\a.png\\|88]]');
		expect(replaceImageWidthInCellText('図なし', 88)).toBeNull();
	});

	it('findFromDOM が無くても束縛した view へ表用 \\|幅 を書く', () => {
		const path = 'C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png';
		const view = createView(`|プリンセス|ユイ(プリンセス)|プリユイ|![[${path}]]|光|`);
		const wrap = {
			dataset: { imagePath: path.replaceAll('\\', '/') },
			/**
			 * @returns {null}
			 */
			closest() {
				return null;
			},
			/**
			 * @returns {boolean}
			 */
			dispatchEvent() {
				return true;
			},
		} as unknown as HTMLElement;
		bindImageWrapEditorView(wrap, view);
		expect(persistImageResizeWidth(wrap, 430)).toBe(true);
		expect(view.state.doc.toString()).toContain(
			'![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png\\|430]]',
		);
		expect(view.state.doc.toString()).toContain('|光|');
		expect(view.state.doc.toString()).not.toContain('png|430]]|光|');
	});
});
