/**
 * 文書末尾への選択移動が、折り畳みと拡張でアンカーの扱いを分けることを検証する
 * キー入力は持たず、EditorState から作った選択だけを見る
 * @file
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createDocumentEndSelection } from './documentBoundary';

describe('documentBoundary', () => {
	it('Ctrl+End 用の選択は文書末尾へ折り畳む', () => {
		// 範囲選択を持つ 3 行の文書。末尾で anchor と head が揃うことを見る
		const state = EditorState.create({
			// 行をまたぐ本文。改行は LF
			doc: ['one', 'two', 'three'].join('\n'),
			// 1 文字目から 6 文字目までの範囲。末尾ではない
			selection: EditorSelection.range(1, 6)
		});

		// 拡張しない末尾選択。anchor は元の位置を保たない
		const selection = createDocumentEndSelection(state, false);

		expect(selection.main.anchor).toBe(state.doc.length);
		expect(selection.main.head).toBe(state.doc.length);
		expect(state.doc.lineAt(selection.main.head).number).toBe(3);
	});

	it('Ctrl+Shift+End 用の選択はアンカーを維持して文書末尾まで拡張する', () => {
		// 2 文字目に空のキャレットがある 3 行の文書
		const state = EditorState.create({
			// 行をまたぐ本文。改行は LF
			doc: ['one', 'two', 'three'].join('\n'),
			// 拡張の起点。anchor はこの位置のまま残る
			selection: EditorSelection.cursor(2)
		});

		// 拡張する末尾選択。head だけが文書長へ動く
		const selection = createDocumentEndSelection(state, true);

		expect(selection.main.anchor).toBe(2);
		expect(selection.main.head).toBe(state.doc.length);
	});
});
