import {
	EditorSelection,
	type EditorState,
	type SelectionRange,
} from '@codemirror/state';

/**
 * キャレットを行内容に収め、行末では EOL より左に付ける（案2）
 * goalColumn は縦移動用の記憶として行長より大きくても保持する（案1）
 * @param {EditorState} state 状態
 * @param {SelectionRange} range 範囲
 * @returns {SelectionRange | null} 変更不要なら null
 */
export function normalizeCaretRange(state: EditorState, range: SelectionRange): SelectionRange | null {
	if (!range.empty) {
		return null;
	}

	const safeHead = Math.min(Math.max(range.head, 0), state.doc.length);
	const line     = state.doc.lineAt(safeHead);
	const head     = Math.max(line.from, Math.min(safeHead, line.to));

	let assoc = range.assoc;
	if (head <= line.from) {
		assoc = 1;
	} else if (head >= line.to) {
		assoc = -1;
	}

	if (head === range.head && assoc === range.assoc) {
		return null;
	}

	return EditorSelection.cursor(
		head,
		assoc === 1 || assoc === -1 ? assoc : -1,
		range.bidiLevel ?? undefined,
		range.goalColumn,
	);
}

/**
 * 選択全体を正規化する
 * @param {EditorState} state 状態
 * @returns {EditorSelection | null}
 */
export function normalizeCaretSelection(state: EditorState): EditorSelection | null {
	let changed  = false;
	const ranges = state.selection.ranges.map((range) => {
		const next = normalizeCaretRange(state, range);
		if (!next) {
			return range;
		}

		changed = true;
		return next;
	});

	if (!changed) {
		return null;
	}

	return EditorSelection.create(ranges, state.selection.mainIndex);
}
