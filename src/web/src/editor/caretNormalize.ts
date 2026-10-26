/**
 * 空のキャレットを行の内容へ収め、行末では描画上の EOL より左へ付ける
 * 選択の更新は呼び出し側が行い、本ファイルは正規化後の範囲を返すだけである。変更が無いときは null を返す
 * @file
 */
import { EditorSelection, type EditorState, type SelectionRange } from '@codemirror/state';

/**
 * 空の選択範囲を、行の内容の内側へ収める
 * 行末では描画上の EOL より左に付ける（案2）。goalColumn は縦移動の列記憶なので、行長より大きくても保持する（案1）
 * @param state - 正規化の対象となる文書。行境界の判定に使う
 * @param range - 対象の選択範囲。空でないときは変更しない
 * @returns 正規化後の範囲。位置も assoc も元と同じなら null
 */
export function normalizeCaretRange(state: EditorState, range: SelectionRange): SelectionRange | null {
	// 範囲選択は折り畳まない。空のキャレットだけを行の内側へ収める
	if (!range.empty) {
		return null;
	}

	// 文書内へ収めた head（文字）。負や文書長超えは端へ寄せ、行の判定材料にする
	const safeHead = Math.min(Math.max(range.head, 0), state.doc.length);
	// safeHead がある論理行。キャレットはこの行の from から to までに収める
	const line     = state.doc.lineAt(safeHead);
	// 行内へ収めたキャレット位置（文字）。行頭より前と行末より後は、その行の端になる
	const head     = Math.max(line.from, Math.min(safeHead, line.to));

	// 描画でどちら側の文字へ付けるか。行頭と行末だけ書き換え、途中は元の assoc を残す
	let assoc = range.assoc;
	// 行頭では次の文字側へ付ける。前の行の末尾に描かれないようにする
	if (head <= line.from) {
		assoc = 1;
		// 行末では手前の文字側へ付ける。描画上の EOL より右へ出さない
	} else if (head >= line.to) {
		assoc = -1;
	}

	// 位置も assoc も元と同じなら、選択を作り直さない
	if (head === range.head && assoc === range.assoc) {
		return null;
	}

	// 収めた位置と assoc の空キャレット。bidi と goalColumn は元の範囲から引き継ぐ
	return EditorSelection.cursor(head, assoc === 1 || assoc === -1 ? assoc : -1, range.bidiLevel ?? undefined, range.goalColumn);
}

/**
 * 選択中の全範囲を正規化する
 * IME の composition 開始中は、変換中のキャレットを動かさない
 * @param state - 正規化の対象となる文書
 * @param compositionStarted - IME の composition が開始しているか。未指定時は false で、通常どおり正規化する
 * @returns 1 つでも範囲が変わったときの選択。変更が無いか composition 中は null
 */
export function normalizeCaretSelection(state: EditorState, compositionStarted = false): EditorSelection | null {
	// 変換中はキャレットを動かさない。位置を直すと IME の未確定文字がずれる
	if (compositionStarted) {
		return null;
	}

	// 1 つでも範囲が変わったとき true。すべて元のままなら false で、選択を作り直さない
	let changed  = false;
	// 各範囲を正規化した結果。変わらなかった範囲は元のオブジェクトのまま
	const ranges = state.selection.ranges.map((range) => {
		// この範囲の正規化結果。空でない、または位置も assoc も同じなら null
		const next = normalizeCaretRange(state, range);
		// 変更が無い範囲は元を残す。changed も立てない
		if (!next) {
			return range;
		}

		// この範囲は位置か assoc が変わった。1 つでも true なら選択全体を返す
		changed = true;
		return next;
	});

	// どの範囲も変わっていなければ、選択の更新は不要
	if (!changed) {
		return null;
	}

	return EditorSelection.create(ranges, state.selection.mainIndex);
}
