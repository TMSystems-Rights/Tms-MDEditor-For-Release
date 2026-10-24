/**
 * 行ラッパーが空行を除き、IME 合成中は増やさず、文書変更後に再構築されることを検証する
 * 画面の高さは測らず、blockWrappers の範囲だけを見る
 * @file
 */
import { EditorState, RangeSet } from '@codemirror/state';
import { BlockWrapper, EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createLineWrapperExtensions, setLineWrapperCompositionEffect } from './lineWrappers';

/**
 * blockWrappers に載っているラッパー範囲を、文書順の配列にする
 * RangeSet 以外の facet 値は本番のラッパーではないので含めない
 * @param state - ラッパー拡張を有効にした状態
 * @returns 空行を含まないラッパーの from と to。ラッパーが無いときは空配列
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
	it('空行を除く論理行を個別にラップする', () => {
		const state = EditorState.create({
			doc        : 'first\n\nthird',
			extensions: createLineWrapperExtensions(),
		});

		expect(collectLineWrappers(state)).toEqual([
			{ from: 0, to: 5 },
			{ from: 7, to: 12 },
		]);
	});

	it('IME 合成中の空行入力ではラッパーを追加しない', () => {
		const initial   = EditorState.create({
			doc        : '',
			extensions: createLineWrapperExtensions(),
		});
		const composing = initial.update({
			effects: setLineWrapperCompositionEffect.of(true),
		}).state;
		const typed     = composing.update({
			changes  : { from: 0, insert: 'k' },
			userEvent: 'input.type.compose',
		}).state;
		const completed = typed.update({
			effects: setLineWrapperCompositionEffect.of(false),
		}).state;

		expect(collectLineWrappers(typed)).toEqual([]);
		expect(collectLineWrappers(completed)).toEqual([{ from: 0, to: 1 }]);
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
			{ from: 7, to: 12 },
		]);
	});
});
