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
	// blockWrappers のうち RangeSet だけ。それ以外は本番のラッパーではない
	const wrapperSets = state.facet(EditorView.blockWrappers).filter((entry): entry is RangeSet<BlockWrapper> => entry instanceof RangeSet);
	// 複数セットを文書順にたどるカーソル
	const cursor      = RangeSet.iter(wrapperSets);
	// 空行を除いたラッパー範囲。無ければ空
	const result      = [] as Array<{ from: number; to: number }>;
	while (cursor.value) {
		// 1 件のラッパー範囲。空行は拡張側で入らない
		result.push({
			// ラッパー先頭。文書オフセット
			from: cursor.from,
			// ラッパー末尾。文書オフセット。この位置は含まない
			to: cursor.to
		});
		cursor.next();
	}

	return result;
}

describe('lineWrappers', () => {
	it('空行を除く論理行を個別にラップする', () => {
		// 空行を挟む 2 行。空行にはラッパーを付けない
		const state = EditorState.create({
			// 空行を含む本文
			doc: 'first\n\nthird',
			// 行ラッパー拡張。描画高さは測らない
			extensions: createLineWrapperExtensions()
		});

		expect(collectLineWrappers(state)).toEqual([
			// 1 行目。空行の手前まで
			{
				// ラッパー先頭。文書オフセット
				from: 0,
				// ラッパー末尾。この位置は含まない
				to: 5
			},
			// 空行の次の行
			{
				// ラッパー先頭。空行の改行の直後
				from: 7,
				// ラッパー末尾
				to: 12
			}
		]);
	});

	it('IME 合成中の空行入力ではラッパーを追加しない', () => {
		// 空の文書。合成開始前はラッパーが無い
		const initial   = EditorState.create({
			// 空の本文
			doc: '',
			// 行ラッパー拡張
			extensions: createLineWrapperExtensions()
		});
		// IME 合成中にした状態。この間はラッパーを増やさない
		const composing = initial.update({
			effects: setLineWrapperCompositionEffect.of(true)
		}).state;
		// 合成中の 1 文字入力。userEvent は compose
		const typed     = composing.update({
			// 文書先頭への 1 文字。範囲の置換ではない
			changes: {
				// 挿入位置。文書先頭
				from: 0,
				// 合成中の 1 文字
				insert: 'k'
			},
			// 合成入力。通常の input.type ではない
			userEvent: 'input.type.compose'
		}).state;
		// 合成を終えた状態。ここでラッパーを作る
		const completed = typed.update({
			effects: setLineWrapperCompositionEffect.of(false)
		}).state;

		expect(collectLineWrappers(typed)).toEqual([]);
		expect(collectLineWrappers(completed)).toEqual([
			{
				// 合成完了後の 1 文字行。先頭
				from: 0,
				// ラッパー末尾。1 文字の直後
				to: 1
			}
		]);
	});

	it('文書変更後は行ラッパーを再構築する', () => {
		// 空行の無い 2 行。このあとに改行を挟む
		const initial = EditorState.create({
			// 2 行の本文
			doc: 'first\nthird',
			// 行ラッパー拡張
			extensions: createLineWrapperExtensions()
		});
		// 1 行目の直後へ改行を足した状態。ラッパーは再構築される
		const state   = initial.update({
			// 1 行目と 2 行目の境への改行
			changes: {
				// 挿入位置。1 行目の改行の直後
				from: 6,
				// 足す改行。空行ができる
				insert: '\n'
			}
		}).state;

		expect(collectLineWrappers(state)).toEqual([
			// 1 行目。空行の手前まで
			{
				// ラッパー先頭。文書オフセット
				from: 0,
				// ラッパー末尾。この位置は含まない
				to: 5
			},
			// 空行の次の行
			{
				// ラッパー先頭。空行の改行の直後
				from: 7,
				// ラッパー末尾
				to: 12
			}
		]);
	});
});
