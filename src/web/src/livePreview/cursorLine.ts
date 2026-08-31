import type { EditorState } from '@codemirror/state';
import type { Text } from '@codemirror/state';

/**
 * ドキュメント位置が属する行番号（1始まり）を返す
 * 行境界（前行の to === 次行の from）では assoc で帰属行を決める
 * @param {Text} doc ドキュメント
 * @param {number} pos 位置
 * @param {number} [assoc] 行境界の帰属（-1: 前行, 1: 次行）
 * @returns {number}
 */
export function lineNumberAtPosition(doc: Text, pos: number, assoc: number = 1): number {
	if (pos <= 0) {
		return 1;
	}

	if (pos >= doc.length) {
		return doc.lines;
	}

	const line = doc.lineAt(pos);
	if (line.number > 1 && pos === line.from && assoc <= 0) {
		const previousLine = doc.line(line.number - 1);
		if (pos === previousLine.to) {
			return previousLine.number;
		}
	}

	return line.number;
}

/**
 * ソース表示する行番号（1始まり）を収集する
 * カーソル位置および選択範囲に含まれる行が対象
 * @param {EditorState} state エディタ状態
 * @returns {Set<number>} 行番号集合
 */
export function collectSourceLineNumbers(state: EditorState): Set<number> {
	const lines = new Set<number>();

	for (const range of state.selection.ranges) {
		const anchorLine = lineNumberAtPosition(
			state.doc,
			range.anchor,
			range.anchor === range.head ? (range.assoc ?? 1) : (range.anchor < range.head ? -1 : 1),
		);
		const headLine   = lineNumberAtPosition(
			state.doc,
			range.head,
			range.empty ? (range.assoc ?? 1) : (range.head >= range.anchor ? 1 : -1),
		);
		const start      = Math.min(anchorLine, headLine);
		const end        = Math.max(anchorLine, headLine);

		for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
			lines.add(lineNumber);
		}
	}

	return lines;
}

/**
 * 指定行がソース表示か判定する
 * @param {EditorState} state エディタ状態
 * @param {number} lineNumber 行番号（1始まり）
 * @returns {boolean}
 */
export function isSourceLine(state: EditorState, lineNumber: number): boolean {
	return collectSourceLineNumbers(state).has(lineNumber);
}

/**
 * 指定行がライブプレビュー装飾対象か判定する
 * @param {EditorState} state エディタ状態
 * @param {number} lineNumber 行番号（1始まり）
 * @returns {boolean}
 */
export function isPreviewLine(state: EditorState, lineNumber: number): boolean {
	return !isSourceLine(state, lineNumber);
}

/**
 * ソース行集合からプレビュー行か判定する
 * @param {number} lineNumber 行番号（1始まり）
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {boolean}
 */
export function isPreviewLineNumber(lineNumber: number, sourceLineNumbers: Set<number>): boolean {
	return !sourceLineNumbers.has(lineNumber);
}

/**
 * 現在のカーソルまたは選択範囲が指定範囲と交差するか判定する。
 * 空選択は範囲境界を含めず、記法の直前・直後ではプレビューを維持する。
 * @param {EditorState} state エディタ状態
 * @param {number} from 開始位置
 * @param {number} to 終了位置
 * @returns {boolean}
 */
export function selectionIntersectsRange(state: EditorState, from: number, to: number): boolean {
	if (from >= to) {
		return false;
	}

	return state.selection.ranges.some((range) => {
		if (range.empty) {
			return range.head > from && range.head < to;
		}

		const selectionFrom = Math.min(range.from, range.to);
		const selectionTo   = Math.max(range.from, range.to);
		return selectionFrom < to && selectionTo > from;
	});
}
