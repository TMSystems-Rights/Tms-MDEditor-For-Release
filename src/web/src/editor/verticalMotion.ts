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

/**
 * 縦移動用の文字列ゴール（CM の goalColumn はピクセルなので使わない）
 */
export const setVerticalCharGoalEffect = StateEffect.define<number | null>();

/**
 * 縦移動で維持する文字列位置
 */
export const verticalCharGoalField = StateField.define<number | null>({
	/**
	 * @returns {null}
	 */
	create() {
		return null;
	},
	/**
	 * @param {number | null} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {number | null}
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

/**
 * ATX 見出し行頭の `#` + 空白プレフィックス長を返す（ユーザー案の (b)）
 * @param {string} lineText 行テキスト
 * @returns {number}
 */
export function headingPrefixLength(lineText: string): number {
	const match = /^(#+)\s/.exec(lineText);
	return match ? match[0].length : 0;
}

/**
 * 選択範囲の端を返す
 * @param {SelectionRange} range 範囲
 * @param {boolean} forward 方向
 * @returns {SelectionRange}
 */
function rangeEnd(range: SelectionRange, forward: boolean): SelectionRange {
	return EditorSelection.cursor(forward ? range.to : range.from);
}

/**
 * 現在位置の文字列を返す
 * @param {EditorState} state 状態
 * @param {SelectionRange} range 範囲
 * @returns {number}
 */
function characterColumnAt(state: EditorState, range: SelectionRange): number {
	const line = state.doc.lineAt(range.head);
	return countColumn(line.text.slice(0, Math.max(0, range.head - line.from)), state.tabSize);
}

/**
 * 論理行単位でカーソルを 1 行移動する（ソース文字位置 (a) を維持）
 * @param {EditorState} state 状態
 * @param {SelectionRange} range 現在範囲
 * @param {boolean} forward 下方向なら true
 * @param {number} charGoal 文字列ゴール
 * @returns {SelectionRange}
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
 * 縦移動先を決定する
 * @param {EditorView} view ビュー
 * @param {SelectionRange} range 現在範囲
 * @param {boolean} forward 下方向なら true
 * @param {number} charGoal 文字列ゴール
 * @param {boolean} extend 選択拡張（Shift）なら true
 * @returns {SelectionRange}
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
 * @param {EditorView} view ビュー
 * @param {boolean} forward 下方向なら true
 * @param {boolean} extend 選択拡張
 * @returns {boolean}
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

/**
 * 見出しなど可変行高でも飛びにくい上移動
 * @type {Command}
 */
export const cursorStableLineUp: Command = (view) => applyVerticalMove(view, false, false);

/**
 * 見出しなど可変行高でも飛びにくい下移動
 * @type {Command}
 */
export const cursorStableLineDown: Command = (view) => applyVerticalMove(view, true, false);

/**
 * 選択拡張付き上移動
 * @type {Command}
 */
export const selectStableLineUp: Command = (view) => applyVerticalMove(view, false, true);

/**
 * 選択拡張付き下移動
 * @type {Command}
 */
export const selectStableLineDown: Command = (view) => applyVerticalMove(view, true, true);

/**
 * 縦移動用拡張
 * @returns {Extension[]}
 */
export function createVerticalMotionExtensions(): Extension[] {
	return [verticalCharGoalField];
}
