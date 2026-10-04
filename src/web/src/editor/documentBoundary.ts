import { EditorSelection, type EditorState } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import { createCaretRedrawSpec } from './caretRedraw';

type DocumentEndScrollMeasure = {
	targetTop: number;
	settled: boolean;
} | null;

const DOCUMENT_END_SCROLL_ATTEMPTS     = 8;
const DOCUMENT_END_SCROLL_TOLERANCE_PX = 1;

const documentEndScrollMeasureKey  = {};
const documentEndScrollGenerations = new WeakMap<EditorView, number>();

/**
 * 文書末尾へ移動する選択範囲を生成する。
 * @param {EditorState} state 現在のエディタ状態
 * @param {boolean} extend 現在のアンカーから選択を拡張するか
 * @returns {EditorSelection} 文書末尾の選択範囲
 */
export function createDocumentEndSelection(state: EditorState, extend: boolean): EditorSelection {
	const documentEnd = state.doc.length;
	return extend
		? EditorSelection.single(state.selection.main.anchor, documentEnd)
		: EditorSelection.single(documentEnd);
}

/**
 * 文書末尾のキャレットが実 DOM 上で表示領域内にあるかを返す。
 * @param {EditorView} view エディタビュー
 * @returns {boolean} 表示領域内なら true
 */
function isDocumentEndVisible(view: EditorView): boolean {
	const position = view.state.doc.length;
	const rect     = view.coordsAtPos(position, 1)
		?? view.coordsAtPos(position, -1)
		?? view.coordsAtPos(position);
	if (!rect) {
		return false;
	}

	const scrollerRect = view.scrollDOM.getBoundingClientRect();
	return rect.top >= scrollerRect.top - DOCUMENT_END_SCROLL_TOLERANCE_PX
		&& rect.bottom <= scrollerRect.bottom + DOCUMENT_END_SCROLL_TOLERANCE_PX;
}

/**
 * 文書末尾への移動がまだ有効かを返す。
 * @param {EditorView} view エディタビュー
 * @param {number} generation 補正世代
 * @param {number} target 文書末尾位置
 * @returns {boolean} 補正を継続できるなら true
 */
function isActiveDocumentEndScroll(view: EditorView, generation: number, target: number): boolean {
	return documentEndScrollGenerations.get(view) === generation
		&& view.state.selection.main.head === target;
}

/**
 * スクロール確定後に同じ選択を再通知し、描画キャレットを末尾 DOM の座標へ同期する。
 * @param {EditorView} view エディタビュー
 * @param {number} generation 補正世代
 * @param {number} target 文書末尾位置
 * @returns {void}
 */
function redrawDocumentEndCaret(view: EditorView, generation: number, target: number): void {
	requestAnimationFrame(() => {
		if (!isActiveDocumentEndScroll(view, generation, target)) {
			return;
		}

		view.dispatch(createCaretRedrawSpec(view.state.selection));
		if (documentEndScrollGenerations.get(view) === generation) {
			documentEndScrollGenerations.delete(view);
		}
	});
}

/**
 * 可変行高の再計測で scrollHeight が変わる間、実際の文書末尾へスクロールを追従させる。
 * @param {EditorView} view エディタビュー
 * @param {number} generation 補正世代
 * @param {number} target 文書末尾位置
 * @param {number} attempts 残り試行回数
 * @returns {void}
 */
function stabilizeDocumentEndScroll(
	view: EditorView,
	generation: number,
	target: number,
	attempts = DOCUMENT_END_SCROLL_ATTEMPTS,
): void {
	if (!isActiveDocumentEndScroll(view, generation, target)) {
		return;
	}

	view.requestMeasure<DocumentEndScrollMeasure>({
		key: documentEndScrollMeasureKey,
		/**
		 * 現在の実スクロール範囲と末尾キャレットの描画状態を計測する。
		 * @param {EditorView} measuredView エディタビュー
		 * @returns {DocumentEndScrollMeasure} 末尾補正情報
		 */
		read(measuredView) {
			if (!isActiveDocumentEndScroll(measuredView, generation, target)) {
				return null;
			}

			const scroller = measuredView.scrollDOM;
			if (!scroller.isConnected || scroller.clientHeight <= 0) {
				return null;
			}

			const targetTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
			return {
				targetTop,
				settled: Math.abs(scroller.scrollTop - targetTop) <= DOCUMENT_END_SCROLL_TOLERANCE_PX
					&& isDocumentEndVisible(measuredView),
			};
		},
		/**
		 * 最新の scrollHeight に追従し、未描画なら次フレームでもう一度補正する。
		 * @param {DocumentEndScrollMeasure} measure 末尾補正情報
		 * @param {EditorView} measuredView エディタビュー
		 * @returns {void}
		 */
		write(measure, measuredView) {
			if (!measure || !isActiveDocumentEndScroll(measuredView, generation, target)) {
				return;
			}

			if (Math.abs(measuredView.scrollDOM.scrollTop - measure.targetTop) > DOCUMENT_END_SCROLL_TOLERANCE_PX) {
				measuredView.scrollDOM.scrollTop = measure.targetTop;
			}
			measuredView.requestMeasure();

			if (!measure.settled && attempts > 1) {
				requestAnimationFrame(() => {
					stabilizeDocumentEndScroll(measuredView, generation, target, attempts - 1);
				});
				return;
			}

			redrawDocumentEndCaret(measuredView, generation, target);
		},
	});
}

/**
 * 文書末尾へ選択を移動し、可変行高の初回計測後も末尾表示を維持する。
 * @param {EditorView} view エディタビュー
 * @param {boolean} extend 現在のアンカーから選択を拡張するか
 * @returns {boolean} コマンド処理済み
 */
function moveToStableDocumentEnd(view: EditorView, extend: boolean): boolean {
	const target     = view.state.doc.length;
	const generation = (documentEndScrollGenerations.get(view) ?? 0) + 1;
	documentEndScrollGenerations.set(view, generation);

	view.dispatch({
		selection     : createDocumentEndSelection(view.state, extend),
		scrollIntoView: true,
		userEvent     : 'select.documentEnd',
	});
	stabilizeDocumentEndScroll(view, generation, target);
	return true;
}

/** 可変行高でも描画位置を同期する文書末尾移動 */
export const cursorStableDocEnd: Command = (view) => moveToStableDocumentEnd(view, false);

/** 選択拡張付きの文書末尾移動 */
export const selectStableDocEnd: Command = (view) => moveToStableDocumentEnd(view, true);
