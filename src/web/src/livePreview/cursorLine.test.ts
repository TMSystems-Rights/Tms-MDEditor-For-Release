/**
 * カーソル行と選択範囲から、ソース行とプレビュー行の判定を検証する
 * EditorState は各ケースで作り、本番の状態フィールドは使わない
 * @file
 */
import { EditorState, EditorSelection } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { collectSourceLineNumbers, isPreviewLine, isSourceLine, lineNumberAtPosition, selectionIntersectsRange } from './cursorLine';

/**
 * 選択を1つだけ持つテスト用 EditorState を作る
 * 拡張は載せない。to を省略すると空のカーソルになる
 * @param doc - ドキュメント全文
 * @param from - 選択の anchor。文字位置
 * @param to - 選択の head。省略時は from と同じ空選択
 * @returns 指定の文書と選択だけを持つ状態
 */
function createState(doc: string, from: number, to: number = from): EditorState {
	return EditorState.create({
		// 行判定の対象にする本文
		doc,
		// from と to が同じときは空キャレット、違うときは範囲
		selection: {
			// 選択の起点。文字位置
			anchor: from,
			// 選択の終点。省略時は from と同じ
			head: to
		}
	});
}

describe('cursorLine', () => {
	it('collectSourceLineNumbers はカーソル行のみを返す', () => {
		// 2 文字目の空キャレット。ソース行は 2 行目だけ
		const state = createState('a\nb\nc', 2);
		expect([...collectSourceLineNumbers(state)]).toEqual([2]);
	});

	it('collectSourceLineNumbers は複数行選択を含む', () => {
		// 2 文字目から 5 文字目の範囲。2 行目と 3 行目にまたがる
		const state = createState('a\nb\nc\nd', 2, 5);
		expect([...collectSourceLineNumbers(state)].sort((a, b) => a - b)).toEqual([2, 3]);
	});

	it('isSourceLine / isPreviewLine が行種別を判定する', () => {
		// 見出し行の先頭キャレット。1 行目だけがソース行
		const state = createState('# title\nbody', 0);
		expect(isSourceLine(state, 1)).toBe(true);
		expect(isPreviewLine(state, 1)).toBe(false);
		expect(isSourceLine(state, 2)).toBe(false);
		expect(isPreviewLine(state, 2)).toBe(true);
	});

	it('lineNumberAtPosition は行先頭位置を次行として扱う', () => {
		// 行番号の基準にする文書。選択は使わない
		const doc   = createState('aa\nbb', 0).doc;
		// 2 行目。先頭位置を渡すとこの行になる
		const line2 = doc.line(2);
		expect(lineNumberAtPosition(doc, line2.from, 1)).toBe(2);
	});

	it('行末境界でも collectSourceLineNumbers はカーソル行をソース扱いする', () => {
		// 行末の位置を取る文書
		const doc   = createState('aa\nbb', 0).doc;
		// 1 行目。行末にキャレットを置く
		const line1 = doc.line(1);
		// 1 行目の行末、assoc は -1。次の行には進めない
		const state = EditorState.create({
			// 上で作った本文
			doc,
			// 行末の空キャレット。マーカーより左
			selection: EditorSelection.cursor(line1.to, -1)
		});
		expect([...collectSourceLineNumbers(state)]).toEqual([1]);
	});

	it('selectionIntersectsRange はカーソルと複数行選択の交差を判定する', () => {
		// 複数行の強調を含む本文。選択の交差を見る
		const selectionDoc   = '**太字**\n通常\n*斜体*';
		// 太字の外にある空キャレット。太字の範囲とは交差しない
		const cursorState    = createState('before **太字** after', 2);
		// 2 文字目から斜体の途中までの範囲。複数の強調に交差する
		const selectionState = createState(selectionDoc, 2, selectionDoc.indexOf('斜体') + 1);

		expect(selectionIntersectsRange(cursorState, 7, 13)).toBe(false);
		expect(selectionIntersectsRange(selectionState, 0, 6)).toBe(true);
		expect(selectionIntersectsRange(selectionState, selectionDoc.indexOf('*斜体*'), selectionDoc.length)).toBe(true);
	});
});
