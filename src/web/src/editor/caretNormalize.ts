/**
 * 空のキャレットを行の内容へ収め、行末では描画上の EOL より左へ付ける
 * 選択の更新は呼び出し側が行い、本ファイルは正規化後の範囲を返すだけである。変更が無いときは null を返す
 * @file
 */
import {
	EditorSelection,
	type EditorState,
	type SelectionRange,
} from '@codemirror/state';

/**
 * 空の選択範囲を、行の内容の内側へ収める
 * 行末では描画上の EOL より左に付ける（案2）。goalColumn は縦移動の列記憶なので、行長より大きくても保持する（案1）
 * @param state - 正規化の対象となる文書。行境界の判定に使う
 * @param range - 対象の選択範囲。空でないときは変更しない
 * @returns 正規化後の範囲。位置も assoc も元と同じなら null
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
 * 選択中の全範囲を正規化する
 * IME の composition 開始中は、変換中のキャレットを動かさない
 * @param state - 正規化の対象となる文書
 * @param compositionStarted - IME の composition が開始しているか。未指定時は false で、通常どおり正規化する
 * @returns 1 つでも範囲が変わったときの選択。変更が無いか composition 中は null
 */
export function normalizeCaretSelection(
	state: EditorState,
	compositionStarted = false,
): EditorSelection | null {
	if (compositionStarted) {
		return null;
	}

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
