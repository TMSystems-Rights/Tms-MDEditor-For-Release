/**
 * 文字列上の列をゴールにして、論理行単位の上下移動を行う
 * CodeMirror の goalColumn はピクセルなので使わず、本ファイルが文字列のゴールを状態として持つ
 * 表セルへの出入りは tableWidget に任せ、本ファイルは文書上の選択とゴールだけを更新する
 * @file
 */
import { countColumn, EditorSelection, findColumn, StateEffect, StateField, type EditorState, type Extension, type SelectionRange } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import { getTableVerticalEntryTarget, hasRenderedTableWidget, moveActiveTableCellVertically, restoreTableCellFocus, type TableVerticalEntryTarget } from '../livePreview/tableWidget';
import { normalizeCaretRange } from './caretNormalize';

// ==============================================
// 文字列ゴール
// ==============================================

/**
 * 縦移動用の文字列ゴールを更新する Effect
 * CodeMirror の goalColumn はピクセルなので使わない。null はゴールを消す
 */
export const setVerticalCharGoalEffect = StateEffect.define<number | null>();

/**
 * 縦移動で維持する文字列上の列
 * 縦移動以外の選択変更で消え、select.normalize だけの更新では残す
 */
export const verticalCharGoalField = StateField.define<number | null>({
	/**
	 * ゴールの初期値は未設定にする
	 * 最初の縦移動で、その時点の文字列から決める
	 * @returns まだ縦移動していないことを示す null
	 */
	create() {
		return null;
	},
	/**
	 * 縦移動の Effect があればその列を保持し、それ以外の選択変更では消す
	 * @param value - 更新前の文字列ゴール。条件に当てはまらなければこのまま返す
	 * @param transaction - 今回のトランザクション。Effect と userEvent を見る
	 * @returns 維持する列。ゴールを消すときは null
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			// 縦移動がゴール列を明示したとき、その値で置き換える。null の Effect はゴールを消す意味で、そのまま返す
			if (effect.is(setVerticalCharGoalEffect)) {
				return effect.value;
			}
		}

		// assoc 補正だけの normalize ではゴールを消さない
		if (transaction.isUserEvent('select.normalize')) {
			return value;
		}

		// 選択が変わり、かつ縦移動ではないときゴールを消す。選択変更が無い、または縦移動なら、この分岐には入らない
		if (transaction.selection && !transaction.isUserEvent('select.vertical')) {
			return null;
		}

		return value;
	}
});

// ==============================================
// 論理行の移動
// ==============================================

/**
 * ATX 見出し行頭の `#` と、その直後の空白までの長さを返す（ユーザー案の (b)）
 * @param lineText - 1 行のテキスト。`#` の連続のあとに空白が無いときは見出し接頭辞としない
 * @returns 接頭辞の文字数。見出しでなければ 0
 */
export function headingPrefixLength(lineText: string): number {
	// `#` の連続と直後の空白。空白が無い行は見出し接頭辞にせず、一致しなければ null
	const match = /^(#+)\s/.exec(lineText);
	return match ? match[0].length : 0;
}

/**
 * 選択範囲の、移動方向にある端を空のキャレットにして返す
 * @param range - 折り畳す範囲。空のときは from と to が同じ
 * @param forward - true で末尾、false で先頭
 * @returns 端に置いた空の選択
 */
function rangeEnd(range: SelectionRange, forward: boolean): SelectionRange {
	return EditorSelection.cursor(forward ? range.to : range.from);
}

/**
 * キャレット位置の文字列上の列を返す
 * @param state - 列を数える文書。タブ幅は state.tabSize
 * @param range - head の位置を見る範囲
 * @returns 行頭から head までの列。タブは tabSize で数える
 */
function characterColumnAt(state: EditorState, range: SelectionRange): number {
	// head がある論理行。列はこの行のテキストだけで数え、タブは tabSize で広げる
	const line = state.doc.lineAt(range.head);
	return countColumn(line.text.slice(0, Math.max(0, range.head - line.from)), state.tabSize);
}

/**
 * 論理行単位でカーソルを 1 行移動する（ソース文字位置 (a) を維持）
 * 文書の端では範囲を変えない。着地後はキャレット正規化を通す
 * @param state - 移動元の文書
 * @param range - 現在の選択。head の行から 1 行進む
 * @param forward - true で次の行、false で前の行
 * @param charGoal - 着地させたい文字列上の列。タブは tabSize で数える。負の値は 0 として扱う
 * @returns 移動後の空選択。端で動けないときは range
 */
export function moveByDocumentLine(state: EditorState, range: SelectionRange, forward: boolean, charGoal: number): SelectionRange {
	// head がある論理行。次に進む行番号の基準
	const line         = state.doc.lineAt(range.head);
	// 移動先の行番号（1 始まり）。前へは 1 減らす。文書の外になり得る
	const targetNumber = forward ? line.number + 1 : line.number - 1;
	// 先頭より前、または最終行より後なら移動しない。どちらか一方でも範囲は変えない
	if (targetNumber < 1 || targetNumber > state.doc.lines) {
		return range;
	}

	// 着地する論理行。行番号は文書内に収まったものだけ
	const target = state.doc.line(targetNumber);
	// 着地行での文字位置。行が短いときは行末。負のゴールは 0 として数える
	const offset = findColumn(target.text, Math.max(0, charGoal), state.tabSize);
	// 着地位置の空キャレット。行末の assoc は、このあと正規化が付ける
	const next   = EditorSelection.cursor(target.from + Math.max(0, offset));
	return normalizeCaretRange(state, next) ?? next;
}

/**
 * 縦移動先を決める
 * 折り返し行の中だけピクセル移動を使い、論理行を跨ぐときは文字列ゴールで着地する
 * @param view - ピクセル移動を試すエディタ
 * @param range - 移動前の範囲
 * @param forward - true で下、false で上
 * @param charGoal - 論理行を跨いだときの着地列
 * @param extend - true のとき選択を拡張する。false で範囲選択中なら、先に移動方向の端へ折り畳む
 * @returns 移動後の範囲。ピクセル移動が同じ論理行に留まったときはその結果
 */
function resolveVerticalMove(view: EditorView, range: SelectionRange, forward: boolean, charGoal: number, extend: boolean): SelectionRange {
	// 非拡張かつ選択あり: 端へ畳んでから 1 行移動する
	const startRange = !range.empty && !extend ? rangeEnd(range, forward) : range;

	// 開始位置の論理行番号（1 始まり）。ピクセル移動が同じ行に留まったかの比較に使う
	const fromLine = view.state.doc.lineAt(startRange.head).number;

	// 折り返し行内だけピクセル縦移動を試し、論理行を跨いだら文字列ゴールで着地する
	const moved = view.moveVertically(startRange, forward);
	// ピクセル移動で位置が変わったときだけ、同じ論理行に留まったかを見る。動かないときは文字列ゴールへ進む
	if (moved.head !== startRange.head) {
		// ピクセル移動後の論理行番号。開始行と同じなら折り返しの途中
		const toLine = view.state.doc.lineAt(moved.head).number;
		// 同じ論理行の折り返し内ならピクセル移動の結果を使う。行を跨いだ結果は捨てる
		if (toLine === fromLine) {
			return moved;
		}
	}

	// ※ moveToLineBoundary は使わない（上移動失敗時に行頭へ落ちるため）
	return moveByDocumentLine(view.state, startRange, forward, charGoal);
}

/**
 * 選択を縦移動で更新する
 * 拡張でない単一選択で、移動先に描画済みの表があるときはセルへ入る
 * @param view - 移動対象のエディタ
 * @param forward - true で下、false で上
 * @param extend - true のときアンカーを維持して head だけ動かす。表セル移動はしない
 * @returns 移動または表セル移動を処理したとき true。選択もゴールも変わらないときも true
 */
function applyVerticalMove(view: EditorView, forward: boolean, extend: boolean): boolean {
	// 選択を拡張しておらず、かつ表セル内の縦移動が処理できたときだけここで終わる。拡張中はセル移動をせず、セルが無いときは文書の選択へ進む
	if (!extend && moveActiveTableCellVertically(view, forward)) {
		return true;
	}

	// 移動開始時の文書と選択。ループ中はこのスナップショットの範囲を走査する
	const { state }                                 = view;
	// 前回の縦移動で残している列。フィールドが無い、または縦移動以外で消えていれば null で、今回の head から取り直す
	const storedGoal                                = state.field(verticalCharGoalField, false) ?? null;
	// 各選択範囲の移動結果。範囲が 0 件のときだけ空のまま終わる
	const ranges                                    = [] as SelectionRange[];
	// この移動で維持する列。最初の範囲で決まり、複数選択でも同じ列を使う。未設定のままなら null
	let nextCharGoal                                = storedGoal;
	// 単一選択で入る表セル。表が無い、複数選択、拡張のときは null のまま
	let tableEntry: TableVerticalEntryTarget | null = null;

	for (const [index, range] of state.selection.ranges.entries()) {
		// この範囲の着地列。保存済みが null のときだけ、今の head の列を使う。0 は行頭であり、未設定ではない
		const charGoal = nextCharGoal === null ? characterColumnAt(state, range) : nextCharGoal;
		// 最初の範囲で決めた列を、残りの範囲でも使う
		nextCharGoal   = charGoal;
		// この範囲の移動後。表へ入るときは、あとでセルのソース位置へ差し替える
		let next       = resolveVerticalMove(view, range, forward, charGoal, extend);
		// 拡張でなく、主選択で、かつ範囲が 1 つだけのとき表の入り口を探す。拡張、主選択以外、複数選択のどれかなら表へ入らない
		if (!extend && index === state.selection.mainIndex && state.selection.ranges.length === 1) {
			// 移動前後の head から決めた表の入り口。表を跨がない移動では null
			const candidate = getTableVerticalEntryTarget(state, range.head, next.head, forward);
			// 入り口があり、かつその表が描画済みのときだけセルへ入る。入り口だけ、または未描画だけでは文書上の移動のまま
			if (candidate && hasRenderedTableWidget(view, candidate.tableFrom)) {
				// あとでフォーカスを戻すセル。この移動で入る表は 1 つ
				tableEntry = candidate;
				// 選択はセル内ではなく、表ウィジェットのソース位置へ置く
				next       = EditorSelection.cursor(tableEntry.sourceFrom);
			}
		}
		// 拡張しないときは移動後の範囲をそのまま積む。拡張時はアンカーを維持して head だけ動かす
		if (!extend) {
			ranges.push(next);
			continue;
		}

		ranges.push(EditorSelection.range(range.anchor, next.head, undefined, next.bidiLevel ?? undefined, next.assoc));
	}

	// 全範囲を移したあとの選択。主選択のインデックスは維持する
	const selection = EditorSelection.create(ranges, state.selection.mainIndex);
	// 選択もゴール列も変わらないときは dispatch しない。どちらか一方が変わっていれば送る。戻りは処理済みの true
	if (selection.eq(state.selection) && storedGoal === nextCharGoal) {
		return true;
	}

	// 選択と文字列ゴールを同時に更新する。縦移動以外の選択変更でゴールが消えないよう userEvent を付ける
	view.dispatch({
		// 移動後の全範囲
		selection,
		// この移動で維持する列。null のままならゴールを消す
		effects: setVerticalCharGoalEffect.of(nextCharGoal),
		// 移動先を表示域へ入れる
		scrollIntoView: true,
		// 縦移動として記録する。ゴールを消す選択変更とは区別する
		userEvent: 'select.vertical'
	});
	// 表セルへ入る移動だったとき、描画済みセルへフォーカスを戻す。表へ入らないときは選択の更新だけで終わる
	if (tableEntry) {
		restoreTableCellFocus(view, tableEntry.tableFrom, tableEntry.position, 0, false);
	}
	return true;
}

// ==============================================
// 移動コマンド
// ==============================================

/**
 * 見出しなど可変行高でも飛びにくい上移動コマンド
 * 文字列上の列をゴールとして維持し、表ウィジェットがあるときはセル移動を優先する
 * @param view - 移動対象のエディタ
 * @returns 移動を処理したとき true
 */
export const cursorStableLineUp: Command = (view) => applyVerticalMove(view, false, false);

/**
 * 見出しなど可変行高でも飛びにくい下移動コマンド
 * 文字列上の列をゴールとして維持し、表ウィジェットがあるときはセル移動を優先する
 * @param view - 移動対象のエディタ
 * @returns 移動を処理したとき true
 */
export const cursorStableLineDown: Command = (view) => applyVerticalMove(view, true, false);

/**
 * 選択を拡張しながら 1 行上へ移動するコマンド
 * 表セルへは入らない
 * @param view - 移動対象のエディタ
 * @returns 移動を処理したとき true
 */
export const selectStableLineUp: Command = (view) => applyVerticalMove(view, false, true);

/**
 * 選択を拡張しながら 1 行下へ移動するコマンド
 * 表セルへは入らない
 * @param view - 移動対象のエディタ
 * @returns 移動を処理したとき true
 */
export const selectStableLineDown: Command = (view) => applyVerticalMove(view, true, true);

/**
 * 縦移動の文字列ゴールを保持する Extension を返す
 * 移動コマンド自体はキーマップ側が束ねる
 * @returns verticalCharGoalField だけを含む配列
 */
export function createVerticalMotionExtensions(): Extension[] {
	return [verticalCharGoalField];
}
