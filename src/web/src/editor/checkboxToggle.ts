/**
 * カーソル行の GFM タスクマーカーを、`[ ]` と `[x]` の間で入れ替える
 * 構文木の探索とトランザクションの組み立てだけを持ち、適用はコマンドの dispatch に渡す
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import {
	type EditorState,
	type StateCommand,
	type TransactionSpec,
} from '@codemirror/state';

/**
 * 行内にあるタスクマーカーの範囲と、チェック状態
 * `[ ]`、`[x]`、`[X]` に一致する TaskMarker だけを表す
 */
export type TaskMarkerRange = {
	/** マーカー先頭の文書オフセット（含む） */
	from: number;
	/** マーカー末尾の文書オフセット（含まない） */
	to: number;
	/** `[x]` または `[X]` のとき true。`[ ]` は false */
	checked: boolean;
};

/** `[ ]`、`[x]`、`[X]` だけをタスクマーカーとして認めるパターン */
const TASK_MARKER_PATTERN = /^\[[ xX]\]$/;

/**
 * タスクマーカーの文字列がチェック済みかを判定する
 * @param text - マーカー全体。`[x]` と `[X]` だけをチェック済みとする
 * @returns チェック済みのとき true
 */
export function isTaskMarkerChecked(text: string): boolean {
	return text === '[x]' || text === '[X]';
}

/**
 * 指定位置の行にある、最初の有効なタスクマーカーを探す
 * @param state - 構文木を持つ文書
 * @param pos - 行を特定する文書オフセット。行内のどこでも、その行のマーカーを探す
 * @returns 見つけたマーカー。タスク行でないときは null
 */
export function findTaskMarkerAt(state: EditorState, pos: number): TaskMarkerRange | null {
	const line                        = state.doc.lineAt(pos);
	let found: TaskMarkerRange | null = null;

	syntaxTree(state).iterate({
		from: line.from,
		to  : line.to,
		/**
		 * 行内の最初の有効な TaskMarker を見つけたら探索を止める
		 * @param node - 走査中の構文ノード
		 * @param node.name - Lezer のノード名。TaskMarker 以外は無視する
		 * @param node.from - ノード先頭の文書オフセット（含む）
		 * @param node.to - ノード末尾の文書オフセット（含まない）
		 * @returns 有効なマーカーを見つけたとき false。それ以外は未指定で探索を続ける
		 */
		enter(node) {
			if (node.name !== 'TaskMarker') {
				return;
			}

			const text = state.doc.sliceString(node.from, node.to);
			if (!TASK_MARKER_PATTERN.test(text)) {
				return;
			}

			found = {
				from   : node.from,
				to     : node.to,
				checked: isTaskMarkerChecked(text),
			};
			return false;
		},
	});

	return found;
}

/**
 * タスクマーカーをトグルするトランザクションを作る
 * チェック済みは `[ ]` へ、未チェックは `[x]` へ置き換える
 * @param state - 対象文書。読み取り専用のときは作らない
 * @param pos - マーカーを探す文書オフセット
 * @returns 置換トランザクション。マーカーが無い、または読み取り専用のときは null
 */
export function buildToggleTaskMarkerTransaction(
	state: EditorState,
	pos: number,
): TransactionSpec | null {
	if (state.readOnly) {
		return null;
	}

	const marker = findTaskMarkerAt(state, pos);
	if (!marker) {
		return null;
	}

	const insert = marker.checked ? '[ ]' : '[x]';
	return {
		changes  : { from: marker.from, to: marker.to, insert },
		userEvent: 'input.toggleCheckbox',
	};
}

/**
 * 主カーソル行のタスクマーカーをトグルするコマンド
 * @param view - コマンド対象。主カーソルの位置を使う
 * @param view.state - トグル対象の文書
 * @param view.dispatch - トランザクションの適用先。マーカーが無いときは呼ばない
 * @returns トグルしたとき true。対象が無いときは false
 */
export const toggleCheckboxCommand: StateCommand = ({ state, dispatch }) => {
	const spec = buildToggleTaskMarkerTransaction(state, state.selection.main.head);
	if (!spec) {
		return false;
	}

	dispatch(state.update(spec));
	return true;
};
