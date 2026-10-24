/**
 * 文書末尾への選択移動と、可変行高でも末尾が見えるまでのスクロール追従を持つ
 * 呼び出し側はコマンドを受け取るだけで、世代番号と計測のやり直しは本ファイルがビューごとに持つ
 * @file
 */
import { EditorSelection, type EditorState } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import { createCaretRedrawSpec } from './caretRedraw';

/**
 * 文書末尾へスクロールを追従させるための計測結果
 * 補正が無効、またはスクロール領域が無いときは null
 */
type DocumentEndScrollMeasure = {
	/** 文書末尾を表示する scrollTop（px）。0 未満にはしない */
	targetTop: number;
	/** 末尾が見え、scrollTop が許容誤差以内なら true */
	settled: boolean;
} | null;

/** 可変行高の再計測を追う上限回数。超えたら最後の位置でキャレットを描き直す */
const DOCUMENT_END_SCROLL_ATTEMPTS     = 8;
/** 末尾表示とみなす scrollTop と矩形の許容誤差（px） */
const DOCUMENT_END_SCROLL_TOLERANCE_PX = 1;

/** requestMeasure の同一キー。連続する末尾補正を 1 本の計測にまとめる */
const documentEndScrollMeasureKey  = {};
/** ビューごとの補正世代。新しい末尾移動が、古いフレームの補正を無効にする */
const documentEndScrollGenerations = new WeakMap<EditorView, number>();

// ==============================================
// 文書末尾の選択
// ==============================================

/**
 * 文書末尾へ移動する選択範囲を生成する
 * @param state - 現在の文書。末尾位置と、拡張時のアンカーを読む
 * @param extend - true のとき現在のアンカーから末尾まで拡張する。false のときは末尾へ折り畳む
 * @returns 文書末尾を head とする選択
 */
export function createDocumentEndSelection(state: EditorState, extend: boolean): EditorSelection {
	const documentEnd = state.doc.length;
	return extend
		? EditorSelection.single(state.selection.main.anchor, documentEnd)
		: EditorSelection.single(documentEnd);
}

// ==============================================
// 末尾表示の追従
// ==============================================

/**
 * 文書末尾のキャレットが、実 DOM の表示領域に入っているかを返す
 * @param view - 座標を測るエディタ。coordsAtPos が取れないときは表示されていないとみなす
 * @returns キャレット矩形がスクロール領域の上下に収まっているとき true
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
 * 文書末尾への移動が、まだこの世代の補正対象かを返す
 * @param view - 世代を保持しているエディタ
 * @param generation - この補正を開始した世代番号
 * @param target - 補正開始時の文書末尾位置。キャレットがここから動いていたら無効
 * @returns 同じ世代で、キャレットがまだその末尾にあるとき true
 */
function isActiveDocumentEndScroll(view: EditorView, generation: number, target: number): boolean {
	return documentEndScrollGenerations.get(view) === generation
		&& view.state.selection.main.head === target;
}

/**
 * スクロール確定後に同じ選択を再通知し、描画キャレットを末尾 DOM の座標へ同期する
 * フレームをまたぐのは、scrollTop の反映前に座標を測ると末尾へ戻るため
 * @param view - 再計測させるエディタ
 * @param generation - この補正の世代番号。次の末尾移動が始まっていたら描き直さない
 * @param target - 補正開始時の文書末尾位置
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
 * 可変行高の再計測で scrollHeight が変わる間、実際の文書末尾へスクロールを追従させる
 * @param view - 追従させるエディタ
 * @param generation - この補正の世代番号
 * @param target - 補正開始時の文書末尾位置
 * @param attempts - 残りの試行回数。未指定時は DOCUMENT_END_SCROLL_ATTEMPTS。1 のときは次フレームへ回さない
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
		 * 現在の実スクロール範囲と、末尾キャレットが見えているかを計測する
		 * @param measuredView - 計測対象のエディタ。補正世代が無効なら計測しない
		 * @returns 末尾の scrollTop と、表示が確定したか。補正を続ける条件を満たさないときは null
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
		 * 最新の scrollHeight へ scrollTop を追従させ、未確定なら次フレームでもう一度補正する
		 * @param measure - 計測結果。null のときは何もしない
		 * @param measuredView - 補正を書き込むエディタ
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
 * 文書末尾へ選択を移動し、可変行高の初回計測後も末尾表示を維持する
 * 世代を進めてから選択を移す。古いフレームの補正は、世代不一致で捨てる
 * @param view - 移動対象のエディタ
 * @param extend - true のとき現在のアンカーから末尾まで拡張する。false のときは末尾へ折り畳む
 * @returns コマンドを処理したことを示す true
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

/**
 * 選択を折り畳んで文書末尾へ移動するコマンド
 * 可変行高の初回計測後も、末尾表示と描画キャレットを追従させる
 * @param view - 移動対象のエディタ
 * @returns コマンドを処理したとき true
 */
export const cursorStableDocEnd: Command = (view) => moveToStableDocumentEnd(view, false);

/**
 * アンカーを維持したまま、選択を文書末尾まで拡張するコマンド
 * 末尾表示の追従は、折り畳み移動と同じ補正を使う
 * @param view - 拡張対象のエディタ
 * @returns コマンドを処理したとき true
 */
export const selectStableDocEnd: Command = (view) => moveToStableDocumentEnd(view, true);
