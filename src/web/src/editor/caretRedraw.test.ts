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
		const state = EditorState.create({
			doc      : ['one', 'two', 'three'].join('\n'),
			selection: EditorSelection.single(2, 8),
		});

		const transaction = state.update(createCaretRedrawSpec(state.selection));

		expect(transaction.newSelection.eq(state.selection)).toBe(true);
		expect(transaction.selection).not.toBeNull();
		expect(transaction.isUserEvent('select.caret')).toBe(true);
		expect(transaction.annotation(Transaction.userEvent)).toBe('select.caret');
	});
});
