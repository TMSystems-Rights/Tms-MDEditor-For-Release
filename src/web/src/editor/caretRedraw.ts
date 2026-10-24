/**
 * 選択位置を変えずに、描画キャレットの再計測を指示するトランザクションを作る
 * 選択の更新自体は呼び出し側が行い、本ファイルは userEvent の契約だけを持つ
 * @file
 */
import type { EditorSelection, TransactionSpec } from '@codemirror/state';

/** drawSelection に再計測させるユーザーイベント名。選択内容の変更を意味しない */
export const CARET_REDRAW_USER_EVENT = 'select.caret';

/**
 * 選択位置を維持したまま、drawSelection の cursorLayer を再計測させるトランザクションを作る
 * @param selection - 維持する選択範囲。位置は変えない
 * @returns 同じ選択と再計測用 userEvent を持つスペック
 */
export function createCaretRedrawSpec(selection: EditorSelection): TransactionSpec {
	return {
		selection,
		userEvent: CARET_REDRAW_USER_EVENT,
	};
}
