import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
	calculateSplitRatio,
	createSynchronizedTransaction,
	splitSynchronization,
} from './splitView';

describe('splitView', () => {
	it('境界位置を 20%〜80% に制限する', () => {
		expect(calculateSplitRatio(50, 0, 1000)).toBe(0.2);
		expect(calculateSplitRatio(500, 0, 1000)).toBe(0.5);
		expect(calculateSplitRatio(950, 0, 1000)).toBe(0.8);
		expect(calculateSplitRatio(100, 0, 0)).toBe(0.5);
	});

	it('本文変更だけを同期し、同期先の選択位置は独立してマップする', () => {
		const sourceState       = EditorState.create({ doc: 'alpha\nbeta' });
		const targetState       = EditorState.create({
			doc: 'alpha\nbeta',
			selection: EditorSelection.cursor(8),
		});
		const sourceTransaction = sourceState.update({
			changes: { from: 0, insert: 'X' },
		});
		const synchronized      = createSynchronizedTransaction(sourceTransaction, targetState);

		expect(synchronized).not.toBeNull();
		expect(synchronized?.newDoc.toString()).toBe('Xalpha\nbeta');
		expect(synchronized?.newSelection.main.head).toBe(9);
		expect(synchronized?.annotation(splitSynchronization)).toBe(true);
		expect(synchronized?.annotation(Transaction.addToHistory)).toBe(false);
	});

	it('選択変更だけのトランザクションは同期しない', () => {
		const state         = EditorState.create({ doc: 'text' });
		const selectionOnly = state.update({
			selection: EditorSelection.cursor(2),
		});

		expect(createSynchronizedTransaction(selectionOnly, state)).toBeNull();
	});
});
