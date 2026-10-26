/**
 * 分割比率の制限と、本文変更だけを別ペインへ写すことを確認する
 * @file
 */
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { calculateSplitRatio, createSynchronizedTransaction, splitSynchronization } from './splitView';

describe('splitView', () => {
	it('境界位置を 20%〜80% に制限する', () => {
		expect(calculateSplitRatio(50, 0, 1000)).toBe(0.2);
		expect(calculateSplitRatio(500, 0, 1000)).toBe(0.5);
		expect(calculateSplitRatio(950, 0, 1000)).toBe(0.8);
		expect(calculateSplitRatio(100, 0, 0)).toBe(0.5);
	});

	it('本文変更だけを同期し、同期先の選択位置は独立してマップする', () => {
		// 同期元。本文は同期先と同じで、選択は先頭のまま
		const sourceState       = EditorState.create({ doc: 'alpha\nbeta' });
		// 同期先。同じ本文で、キャレットは 2 行目にある
		const targetState       = EditorState.create({
			// 同期元と同じ本文
			doc: 'alpha\nbeta',
			// 同期先のキャレット。本文挿入の分だけ後ろへずれる
			selection: EditorSelection.cursor(8)
		});
		// 先頭へ 1 文字足す更新。選択だけの変更ではない
		const sourceTransaction = sourceState.update({
			// 文書先頭への挿入。範囲の置換ではない
			changes: {
				// 挿入位置。文書先頭
				from: 0,
				// 足す 1 文字
				insert: 'X'
			}
		});
		// 同期先へ写した更新。選択変更だけなら null
		const synchronized      = createSynchronizedTransaction(sourceTransaction, targetState);

		expect(synchronized).not.toBeNull();
		expect(synchronized?.newDoc.toString()).toBe('Xalpha\nbeta');
		expect(synchronized?.newSelection.main.head).toBe(9);
		expect(synchronized?.annotation(splitSynchronization)).toBe(true);
		expect(synchronized?.annotation(Transaction.addToHistory)).toBe(false);
	});

	it('選択変更だけのトランザクションは同期しない', () => {
		// 本文を変えない比較用の状態
		const state         = EditorState.create({ doc: 'text' });
		// キャレットだけを動かす更新。同期の対象外
		const selectionOnly = state.update({
			selection: EditorSelection.cursor(2)
		});

		expect(createSynchronizedTransaction(selectionOnly, state)).toBeNull();
	});
});
