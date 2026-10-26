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
	// 文書末尾のオフセット（文字）。空文書は 0。選択の head はここへ置く
	const documentEnd = state.doc.length;
	return extend ? EditorSelection.single(state.selection.main.anchor, documentEnd) : EditorSelection.single(documentEnd);
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
	// 文書末尾のオフセット（文字）。空文書は 0
	const position = view.state.doc.length;
	// 末尾キャレットの表示矩形（px）。assoc 1、取れなければ -1、それでも無ければ既定。どれも取れなければ null
	const rect     = view.coordsAtPos(position, 1) ?? view.coordsAtPos(position, -1) ?? view.coordsAtPos(position);
	// 座標が取れない末尾は、表示領域に入っていないとみなす
	if (!rect) {
		return false;
	}

	// スクロールポートの表示矩形（px）。キャレットがこの上下に収まるかを見る
	const scrollerRect = view.scrollDOM.getBoundingClientRect();
	return rect.top >= scrollerRect.top - DOCUMENT_END_SCROLL_TOLERANCE_PX && rect.bottom <= scrollerRect.bottom + DOCUMENT_END_SCROLL_TOLERANCE_PX;
}

/**
 * 文書末尾への移動が、まだこの世代の補正対象かを返す
 * @param view - 世代を保持しているエディタ
 * @param generation - この補正を開始した世代番号
 * @param target - 補正開始時の文書末尾位置。キャレットがここから動いていたら無効
 * @returns 同じ世代で、キャレットがまだその末尾にあるとき true
 */
function isActiveDocumentEndScroll(view: EditorView, generation: number, target: number): boolean {
	return documentEndScrollGenerations.get(view) === generation && view.state.selection.main.head === target;
}

/**
 * スクロール確定後に同じ選択を再通知し、描画キャレットを末尾 DOM の座標へ同期する
 * フレームをまたぐのは、scrollTop の反映前に座標を測ると末尾へ戻るため
 * @param view - 再計測させるエディタ
 * @param generation - この補正の世代番号。次の末尾移動が始まっていたら描き直さない
 * @param target - 補正開始時の文書末尾位置
 */
function redrawDocumentEndCaret(view: EditorView, generation: number, target: number): void {
	// 次のフレームで、scrollTop の反映後にキャレットを描き直す。同じフレームで測ると末尾へ戻る
	requestAnimationFrame(() => {
		// 世代が変わった、またはキャレットが末尾から動いたあとのフレームでは描き直さない
		if (!isActiveDocumentEndScroll(view, generation, target)) {
			return;
		}

		view.dispatch(createCaretRedrawSpec(view.state.selection));
		// 描き直したあとも、この世代が最新なら世代を消す。途中で次の末尾移動が始まっていたら消さない
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
function stabilizeDocumentEndScroll(view: EditorView, generation: number, target: number, attempts = DOCUMENT_END_SCROLL_ATTEMPTS): void {
	// 世代が違う、またはキャレットが末尾から動いているときは、この補正を始めない
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
			// 世代が無効、またはキャレットが末尾に無いときは計測しない
			if (!isActiveDocumentEndScroll(measuredView, generation, target)) {
				return null;
			}

			// スクロール要素。未接続や高さが 0 のときは末尾位置を計算できない
			const scroller = measuredView.scrollDOM;
			// 未接続、または表示高が 0 なら計測しない。どちらか一方でも null
			if (!scroller.isConnected || scroller.clientHeight <= 0) {
				return null;
			}

			// 文書末尾を表示する scrollTop（px）。0 未満にはしない
			const targetTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
			// 末尾の scrollTop と、表示が確定したか
			return {
				// 末尾へ合わせる縦位置（px）
				targetTop,
				// 縦位置が許容以内で、かつ末尾キャレットが見えているとき true。どちらか一方だけでは未確定
				settled: Math.abs(scroller.scrollTop - targetTop) <= DOCUMENT_END_SCROLL_TOLERANCE_PX && isDocumentEndVisible(measuredView)
			};
		},
		/**
		 * 最新の scrollHeight へ scrollTop を追従させ、未確定なら次フレームでもう一度補正する
		 * @param measure - 計測結果。null のときは何もしない
		 * @param measuredView - 補正を書き込むエディタ
		 */
		write(measure, measuredView) {
			// 計測が無い、または補正世代が無効なら書かない。どちらか一方でも打ち切る
			if (!measure || !isActiveDocumentEndScroll(measuredView, generation, target)) {
				return;
			}

			// 現在の scrollTop が末尾から許容を超えてずれているときだけ書く。許容以内なら触らない
			if (Math.abs(measuredView.scrollDOM.scrollTop - measure.targetTop) > DOCUMENT_END_SCROLL_TOLERANCE_PX) {
				measuredView.scrollDOM.scrollTop = measure.targetTop;
			}
			measuredView.requestMeasure();

			// まだ末尾が見えておらず、かつ残り試行があるとき次フレームへ回す。どちらか一方だけでは描き直しへ進む
			if (!measure.settled && attempts > 1) {
				requestAnimationFrame(() => {
					stabilizeDocumentEndScroll(measuredView, generation, target, attempts - 1);
				});
				return;
			}

			redrawDocumentEndCaret(measuredView, generation, target);
		}
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
	// 補正開始時の文書末尾（文字）。この位置からキャレットが動いたら、古いフレームの補正は無効
	const target     = view.state.doc.length;
	// この末尾移動の世代。前の世代より 1 大きい。未設定のビューは 0 から始める
	const generation = (documentEndScrollGenerations.get(view) ?? 0) + 1;
	documentEndScrollGenerations.set(view, generation);

	// 末尾への選択と、初回の scrollIntoView。可変行高の追従はこのあと別計測で行う
	view.dispatch({
		// 折り畳むか、アンカーから末尾まで拡張するか
		selection: createDocumentEndSelection(view.state, extend),
		// 初回は CodeMirror の表示域追従に任せる。行高の伸びは後続の計測が追う
		scrollIntoView: true,
		// 文書末尾への選択として記録する
		userEvent: 'select.documentEnd'
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
