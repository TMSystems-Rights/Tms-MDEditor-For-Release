import type { EditorSelection, TransactionSpec } from '@codemirror/state';

/** 描画キャレット再計測用のユーザーイベント */
export const CARET_REDRAW_USER_EVENT = 'select.caret';

/**
 * 選択位置を変えず、drawSelection の cursorLayer に再計測させるトランザクションを作る。
 * @param {EditorSelection} selection 維持する選択範囲
 * @returns {TransactionSpec} 再描画用スペック
 */
export function createCaretRedrawSpec(selection: EditorSelection): TransactionSpec {
	return {
		selection,
		userEvent: CARET_REDRAW_USER_EVENT,
	};
}
