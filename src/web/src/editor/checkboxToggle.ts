import { syntaxTree } from '@codemirror/language';
import {
	type EditorState,
	type StateCommand,
	type TransactionSpec,
} from '@codemirror/state';

export type TaskMarkerRange = {
	from: number;
	to: number;
	checked: boolean;
};

const TASK_MARKER_PATTERN = /^\[[ xX]\]$/;

/**
 * TaskMarker 文字列がチェック済みか判定する
 * @param {string} text マーカー文字列
 * @returns {boolean}
 */
export function isTaskMarkerChecked(text: string): boolean {
	return text === '[x]' || text === '[X]';
}

/**
 * 指定位置の行にある TaskMarker を探す
 * @param {EditorState} state エディタ状態
 * @param {number} pos 位置
 * @returns {TaskMarkerRange | null}
 */
export function findTaskMarkerAt(state: EditorState, pos: number): TaskMarkerRange | null {
	const line                        = state.doc.lineAt(pos);
	let found: TaskMarkerRange | null = null;

	syntaxTree(state).iterate({
		from: line.from,
		to  : line.to,
		/**
		 * TaskMarker を収集する
		 * @param {{ name: string; from: number; to: number }} node ノード
		 * @returns {boolean | void}
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
 * TaskMarker をトグルするトランザクション仕様を生成する
 * @param {EditorState} state エディタ状態
 * @param {number} pos 対象位置
 * @returns {TransactionSpec | null}
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
 * カーソル行のチェックボックスをトグルする
 * @param {{ state: EditorState; dispatch: (tr: import('@codemirror/state').Transaction) => void }} view コマンド対象
 * @returns {boolean}
 */
export const toggleCheckboxCommand: StateCommand = ({ state, dispatch }) => {
	const spec = buildToggleTaskMarkerTransaction(state, state.selection.main.head);
	if (!spec) {
		return false;
	}

	dispatch(state.update(spec));
	return true;
};
