/**
 * 文字列上の列をゴールにして、論理行単位の上下移動を行う
 * CodeMirror の goalColumn はピクセルなので使わず、本ファイルが文字列のゴールを状態として持つ
 * 表セルへの出入りは tableWidget に任せ、本ファイルは文書上の選択とゴールだけを更新する
 * @file
 */
import {
	countColumn,
	EditorSelection,
	findColumn,
	StateEffect,
	StateField,
	type EditorState,
	type Extension,
	type SelectionRange,
} from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import {
	getTableVerticalEntryTarget,
	hasRenderedTableWidget,
	moveActiveTableCellVertically,
	restoreTableCellFocus,
	type TableVerticalEntryTarget,
} from '../livePreview/tableWidget';
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
			if (effect.is(setVerticalCharGoalEffect)) {
				return effect.value;
			}
		}

		// assoc 補正だけの normalize ではゴールを消さない
		if (transaction.isUserEvent('select.normalize')) {
			return value;
		}

		// 縦移動以外の選択変更ではクリア
		if (transaction.selection && !transaction.isUserEvent('select.vertical')) {
			return null;
		}

		return value;
	},
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
export function moveByDocumentLine(
	state: EditorState,
	range: SelectionRange,
	forward: boolean,
	charGoal: number,
): SelectionRange {
	const line         = state.doc.lineAt(range.head);
	const targetNumber = forward ? line.number + 1 : line.number - 1;
	if (targetNumber < 1 || targetNumber > state.doc.lines) {
		return range;
	}

	const target = state.doc.line(targetNumber);
	const offset = findColumn(target.text, Math.max(0, charGoal), state.tabSize);
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
function resolveVerticalMove(
	view: EditorView,
	range: SelectionRange,
	forward: boolean,
	charGoal: number,
	extend: boolean,
): SelectionRange {
	// 非拡張かつ選択あり: 端へ畳んでから 1 行移動する
	const startRange = (!range.empty && !extend)
		? rangeEnd(range, forward)
		: range;

	const fromLine = view.state.doc.lineAt(startRange.head).number;

	// 折り返し行内だけピクセル縦移動を試し、論理行を跨いだら文字列ゴールで着地する
	const moved = view.moveVertically(startRange, forward);
	if (moved.head !== startRange.head) {
		const toLine = view.state.doc.lineAt(moved.head).number;
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
	if (!extend && moveActiveTableCellVertically(view, forward)) {
		return true;
	}

	const { state }                                 = view;
	const storedGoal                                = state.field(verticalCharGoalField, false) ?? null;
	const ranges                                    = [] as SelectionRange[];
	let nextCharGoal                                = storedGoal;
	let tableEntry: TableVerticalEntryTarget | null = null;

	for (const [index, range] of state.selection.ranges.entries()) {
		const charGoal = nextCharGoal === null
			? characterColumnAt(state, range)
			: nextCharGoal;
		nextCharGoal   = charGoal;
		let next       = resolveVerticalMove(view, range, forward, charGoal, extend);
		if (!extend && index === state.selection.mainIndex && state.selection.ranges.length === 1) {
			const candidate = getTableVerticalEntryTarget(state, range.head, next.head, forward);
			if (candidate && hasRenderedTableWidget(view, candidate.tableFrom)) {
				tableEntry = candidate;
				next       = EditorSelection.cursor(tableEntry.sourceFrom);
			}
		}
		if (!extend) {
			ranges.push(next);
			continue;
		}

		ranges.push(EditorSelection.range(
			range.anchor,
			next.head,
			undefined,
			next.bidiLevel ?? undefined,
			next.assoc,
		));
	}

	const selection = EditorSelection.create(ranges, state.selection.mainIndex);
	if (selection.eq(state.selection) && storedGoal === nextCharGoal) {
		return true;
	}

	view.dispatch({
		selection,
		effects       : setVerticalCharGoalEffect.of(nextCharGoal),
		scrollIntoView: true,
		userEvent     : 'select.vertical',
	});
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
