import { EditorState, RangeSet } from '@codemirror/state';
import { BlockWrapper, EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createLineWrapperExtensions } from './lineWrappers';

/**
 * 行ラッパー範囲を配列化する。
 * @param {EditorState} state エディタ状態
 * @returns {Array<{ from: number; to: number }>} ラッパー範囲
 */
function collectLineWrappers(state: EditorState): Array<{ from: number; to: number }> {
	const wrapperSets = state.facet(EditorView.blockWrappers).filter(
		(entry): entry is RangeSet<BlockWrapper> => entry instanceof RangeSet,
	);
	const cursor      = RangeSet.iter(wrapperSets);
	const result      = [] as Array<{ from: number; to: number }>;
	while (cursor.value) {
		result.push({
			from : cursor.from,
			to   : cursor.to,
		});
		cursor.next();
	}

	return result;
}

describe('lineWrappers', () => {
	it('空行を含む全論理行を個別にラップする', () => {
		const state = EditorState.create({
			doc        : 'first\n\nthird',
			extensions: createLineWrapperExtensions(),
		});

		expect(collectLineWrappers(state)).toEqual([
			{ from: 0, to: 5 },
			{ from: 6, to: 6 },
			{ from: 7, to: 12 },
		]);
	});

	it('文書変更後は行ラッパーを再構築する', () => {
		const initial = EditorState.create({
			doc        : 'first\nthird',
			extensions: createLineWrapperExtensions(),
		});
		const state   = initial.update({
			changes: { from: 6, insert: '\n' },
		}).state;

		expect(collectLineWrappers(state)).toEqual([
			{ from: 0, to: 5 },
			{ from: 6, to: 6 },
			{ from: 7, to: 12 },
		]);
	});
});
