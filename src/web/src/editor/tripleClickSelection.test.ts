import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import {
	selectionForTripleClick,
	selectionRangeForLine,
	tripleClickMouseSelectionStyle,
} from './tripleClickSelection';

const SAMPLE = ['alpha', 'beta', 'gamma'].join('\n');

/**
 * 文書位置を clientX として返すビューを作る
 * @param {string} doc 文書
 * @param {number} [head] 初期キャレット
 * @returns {EditorView} テスト用ビュー
 */
function createView(doc: string, head = 0): EditorView {
	const state = EditorState.create({
		doc,
		selection: EditorSelection.cursor(head),
	});
	return {
		state,
		/**
		 *
		 */
		posAndSideAtCoords(coords: { x: number }): { pos: number; assoc: 1 } {
			return { pos: coords.x, assoc: 1 };
		},
	} as unknown as EditorView;
}

describe('tripleClickSelection', () => {
	it('論理行の内容だけを選択し、キャレットを行末へ置く', () => {
		const state = EditorState.create({ doc: SAMPLE });
		const line  = state.doc.line(2);
		const range = selectionRangeForLine(state, line.from + 1);

		expect(range.anchor).toBe(line.from);
		expect(range.head).toBe(line.to);
		expect(range.assoc).toBe(-1);
		expect(state.sliceDoc(range.from, range.to)).toBe('beta');
		expect(state.sliceDoc(range.to, range.to + 1)).toBe('\n');
	});

	it('最終行に改行が無いときは文書末尾までを選択する', () => {
		const state = EditorState.create({ doc: SAMPLE });
		const line  = state.doc.line(3);
		const range = selectionRangeForLine(state, line.to);

		expect(range.from).toBe(line.from);
		expect(range.to).toBe(state.doc.length);
		expect(state.sliceDoc(range.from, range.to)).toBe('gamma');
	});

	it('行区切りが正規化されても選択範囲に改行を含めない', () => {
		const state = EditorState.create({ doc: 'alpha\r\nbeta' });
		const line  = state.doc.line(1);
		const range = selectionRangeForLine(state, 1);

		expect(state.sliceDoc(range.from, range.to)).toBe('alpha');
		expect(range.to).toBe(line.to);
		expect(state.sliceDoc(line.to, state.doc.line(2).from)).toBe('\n');
	});

	it('空行のトリプルクリックは次行へキャレットを移さない', () => {
		const state = EditorState.create({ doc: 'alpha\n\ngamma' });
		const line  = state.doc.line(2);
		const range = selectionRangeForLine(state, line.from);

		expect(range.empty).toBe(true);
		expect(range.head).toBe(line.from);
		expect(range.assoc).toBe(1);
		expect(state.doc.lineAt(range.head).number).toBe(2);
	});

	it('同一行で位置がずれてもキャレットは行末のまま', () => {
		const state = EditorState.create({ doc: SAMPLE });
		const line  = state.doc.line(1);
		const range = selectionForTripleClick(state, line.from + 4, line.from + 1);

		expect(range.anchor).toBe(line.from);
		expect(range.head).toBe(line.to);
		expect(state.sliceDoc(range.from, range.to)).toBe('alpha');
	});

	it('下方向のドラッグは最終行の改行を含めない', () => {
		const state = EditorState.create({ doc: SAMPLE });
		const first = state.doc.line(1);
		const last  = state.doc.line(3);
		const range = selectionForTripleClick(state, first.from, last.from);

		expect(range.anchor).toBe(first.from);
		expect(range.head).toBe(last.to);
		expect(state.sliceDoc(range.from, range.to)).toBe(SAMPLE);
	});

	it('上方向のドラッグは開始行の改行を含めない', () => {
		const state  = EditorState.create({ doc: SAMPLE });
		const first  = state.doc.line(1);
		const second = state.doc.line(2);
		const range  = selectionForTripleClick(state, second.from + 1, first.from);
		const copied = state.sliceDoc(range.from, range.to);

		expect(range.head).toBe(first.from);
		expect(range.anchor).toBe(second.to);
		expect(copied).toBe('alpha\nbeta');
		expect(copied.endsWith('\n')).toBe(false);
	});

	it('単クリックとダブルクリックは行選択にしない', () => {
		const view = createView(SAMPLE);
		expect(tripleClickMouseSelectionStyle(view, { button: 0, detail: 1 } as MouseEvent)).toBeNull();
		expect(tripleClickMouseSelectionStyle(view, { button: 0, detail: 2 } as MouseEvent)).toBeNull();
		expect(tripleClickMouseSelectionStyle(view, { button: 2, detail: 3 } as MouseEvent)).toBeNull();
	});

	it('トリプルクリックの選択テキストに行末改行を含めない', () => {
		const view      = createView(SAMPLE);
		const line      = view.state.doc.line(2);
		const style     = tripleClickMouseSelectionStyle(view, {
			button : 0,
			detail : 3,
			clientX: line.from + 2,
			clientY: 0,
		} as MouseEvent);
		const selection = style?.get({ clientX: line.from + 2, clientY: 0 } as MouseEvent, false, false);

		expect(selection?.main.head).toBe(line.to);
		expect(view.state.sliceDoc(selection!.main.from, selection!.main.to)).toBe('beta');
	});

	it('Shift+トリプルクリックはクリック行の改行を含めずに拡張する', () => {
		const view      = createView(SAMPLE, 1);
		const line      = view.state.doc.line(2);
		const style     = tripleClickMouseSelectionStyle(view, {
			button : 0,
			detail : 3,
			clientX: line.from,
			clientY: 0,
		} as MouseEvent);
		const selection = style?.get({ clientX: line.from, clientY: 0 } as MouseEvent, true, false);

		expect(selection?.main.anchor).toBe(1);
		expect(selection?.main.head).toBe(line.to);
		expect(view.state.sliceDoc(selection!.main.from, selection!.main.to)).toBe('lpha\nbeta');
	});
});
