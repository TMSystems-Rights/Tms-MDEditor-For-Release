/**
 * カーソル行の GFM タスクマーカーを、`[ ]` と `[x]` の間で入れ替える
 * 構文木の探索とトランザクションの組み立てだけを持ち、適用はコマンドの dispatch に渡す
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type StateCommand, type TransactionSpec } from '@codemirror/state';

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
	// pos がある論理行。探索はこの行の from から to までに限る
	const line                        = state.doc.lineAt(pos);
	// 最初に見つかった有効なマーカー。行内に無ければ null のまま
	let found: TaskMarkerRange | null = null;

	syntaxTree(state).iterate({
		// 探索の開始（文書オフセット、含む）。この行の先頭
		from: line.from,
		// 探索の終了（文書オフセット、含まない）。この行の末尾で、次の行へは出ない
		to: line.to,
		/**
		 * 行内の最初の有効な TaskMarker を見つけたら探索を止める
		 * @param node - 走査中の構文ノード
		 * @param node.name - Lezer のノード名。TaskMarker 以外は無視する
		 * @param node.from - ノード先頭の文書オフセット（含む）
		 * @param node.to - ノード末尾の文書オフセット（含まない）
		 * @returns 有効なマーカーを見つけたとき false。それ以外は未指定で探索を続ける
		 */
		enter(node) {
			// TaskMarker 以外は見ない。リスト記号や本文では探索を続ける
			if (node.name !== 'TaskMarker') {
				return;
			}

			// ノードの文字列。パターンに合うものだけをチェック状態の判定に使う
			const text = state.doc.sliceString(node.from, node.to);
			// `[ ]`、`[x]`、`[X]` 以外の TaskMarker は対象にしない
			if (!TASK_MARKER_PATTERN.test(text)) {
				return;
			}

			// この行で採用するマーカー。最初の一つで探索を止める
			found = {
				// マーカー先頭（文書オフセット、含む）
				from: node.from,
				// マーカー末尾（文書オフセット、含まない）
				to: node.to,
				// `[x]` または `[X]` なら true。`[ ]` は false で、次のトグル先は `[x]`
				checked: isTaskMarkerChecked(text)
			};
			return false;
		}
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
export function buildToggleTaskMarkerTransaction(state: EditorState, pos: number): TransactionSpec | null {
	// 読み取り専用ではマーカーを書き換えない
	if (state.readOnly) {
		return null;
	}

	// カーソル行の最初の有効なマーカー。タスク行でなければ null
	const marker = findTaskMarkerAt(state, pos);
	// マーカーが無い行はトグルしない
	if (!marker) {
		return null;
	}

	// 置き換えるマーカー文字列。チェック済みは未チェックへ、未チェックは `[x]` へ戻す
	const insert = marker.checked ? '[ ]' : '[x]';
	// マーカー範囲だけを置き換える変更。選択位置はスペックに含めない
	return {
		// マーカーの from から to までを、反転した文字列で置き換える
		changes: {
			// 置換の開始（文書オフセット、含む）。マーカーの先頭
			from: marker.from,
			// 置換の終了（文書オフセット、含まない）。マーカーの末尾
			to: marker.to,
			// チェックを反転したマーカー。チェック済みなら `[ ]`、未チェックなら `[x]`
			insert
		},
		// チェックボックスの切り替えとして記録する。通常の文字入力とは分ける
		userEvent: 'input.toggleCheckbox'
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
	// 主カーソル行のトグル。読み取り専用か、マーカーが無いときは null
	const spec = buildToggleTaskMarkerTransaction(state, state.selection.main.head);
	// 適用できる変更が無いときは dispatch しない
	if (!spec) {
		return false;
	}

	dispatch(state.update(spec));
	return true;
};
