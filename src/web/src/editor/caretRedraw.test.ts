/**
 * 再計測用トランザクションが、選択を変えずに select.caret を付けることを検証する
 * 描画レイヤは持たず、Transaction の選択と userEvent だけを見る
 * @file
 */
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createCaretRedrawSpec } from './caretRedraw';

describe('caretRedraw', () => {
	it('選択範囲を変えずに描画キャレットの再計測を指示する', () => {
		// 範囲選択を持つ 3 行の文書。再計測後もこの選択と等しいことを見る
		const state = EditorState.create({
			// 行をまたぐ本文。改行は LF
			doc: ['one', 'two', 'three'].join('\n'),
			// 2 文字目から 8 文字目までの範囲。空のキャレットではない
			selection: EditorSelection.single(2, 8)
		});

		// 再計測の指示だけを載せた更新。本文と選択は変えない
		const transaction = state.update(createCaretRedrawSpec(state.selection));

		expect(transaction.newSelection.eq(state.selection)).toBe(true);
		expect(transaction.selection).not.toBeNull();
		expect(transaction.isUserEvent('select.caret')).toBe(true);
		expect(transaction.annotation(Transaction.userEvent)).toBe('select.caret');
	});
});
