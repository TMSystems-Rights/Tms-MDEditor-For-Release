import { EditorState, EditorSelection } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { collectSourceLineNumbers, isPreviewLine, isSourceLine, lineNumberAtPosition, selectionIntersectsRange } from './cursorLine';

/**
 * テスト用 EditorState を生成する
 * @param {string} doc ドキュメント
 * @param {number} from 選択開始
 * @param {number} to 選択終了
 * @returns {EditorState}
 */
function createState(doc: string, from: number, to: number = from): EditorState {
	return EditorState.create({
		doc,
		selection: { anchor: from, head: to },
	});
}

describe('cursorLine', () => {
	it('collectSourceLineNumbers はカーソル行のみを返す', () => {
		const state = createState('a\nb\nc', 2);
		expect([...collectSourceLineNumbers(state)]).toEqual([2]);
	});

	it('collectSourceLineNumbers は複数行選択を含む', () => {
		const state = createState('a\nb\nc\nd', 2, 5);
		expect([...collectSourceLineNumbers(state)].sort((a, b) => a - b)).toEqual([2, 3]);
	});

	it('isSourceLine / isPreviewLine が行種別を判定する', () => {
		const state = createState('# title\nbody', 0);
		expect(isSourceLine(state, 1)).toBe(true);
		expect(isPreviewLine(state, 1)).toBe(false);
		expect(isSourceLine(state, 2)).toBe(false);
		expect(isPreviewLine(state, 2)).toBe(true);
	});

	it('lineNumberAtPosition は行先頭位置を次行として扱う', () => {
		const doc   = createState('aa\nbb', 0).doc;
		const line2 = doc.line(2);
		expect(lineNumberAtPosition(doc, line2.from, 1)).toBe(2);
	});

	it('行末境界でも collectSourceLineNumbers はカーソル行をソース扱いする', () => {
		const doc   = createState('aa\nbb', 0).doc;
		const line1 = doc.line(1);
		const state = EditorState.create({
			doc,
			selection: EditorSelection.cursor(line1.to, -1),
		});
		expect([...collectSourceLineNumbers(state)]).toEqual([1]);
	});

	it('selectionIntersectsRange はカーソルと複数行選択の交差を判定する', () => {
		const selectionDoc   = '**太字**\n通常\n*斜体*';
		const cursorState    = createState('before **太字** after', 2);
		const selectionState = createState(selectionDoc, 2, selectionDoc.indexOf('斜体') + 1);

		expect(selectionIntersectsRange(cursorState, 7, 13)).toBe(false);
		expect(selectionIntersectsRange(selectionState, 0, 6)).toBe(true);
		expect(selectionIntersectsRange(selectionState, selectionDoc.indexOf('*斜体*'), selectionDoc.length)).toBe(true);
	});
});
