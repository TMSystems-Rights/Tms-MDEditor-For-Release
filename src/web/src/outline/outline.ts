import { syntaxTree } from '@codemirror/language';
import { EditorSelection, Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Tree } from '@lezer/common';

export type OutlineItem = {
	level: number;
	title: string;
	from: number;
};

export type OutlineTreeNode = {
	item: OutlineItem;
	index: number;
	children: OutlineTreeNode[];
};

export type OutlineScrollRect = {
	top: number;
	bottom: number;
};

export type OutlineScrollCorrection = {
	delta: number;
	aligned: boolean;
};

type OutlineJumpView = {
	focus: () => void;
	dispatch: (transaction: TransactionSpec) => void;
};

type OutlineScrollCancelCheck = () => boolean;

type OutlineInitialScrollMeasure = {
	targetTop: number;
} | null;

type OutlineScrollCorrectionMeasure = {
	delta: number;
	needsRetry: boolean;
};

const HEADING_NODE_PATTERN              = /^(?:ATXHeading|SetextHeading)([1-6])$/;
const OUTLINE_JUMP_USER_EVENT           = 'select.outline';
const OUTLINE_CARET_REDRAW_USER_EVENT   = 'select.caret';
const outlineInitialScrollKey           = {};
const outlineScrollCorrectionKey        = {};
const OUTLINE_SCROLL_MARGIN_PX          = 12;
const OUTLINE_SCROLL_FINE_ATTEMPTS      = 5;
const OUTLINE_SCROLL_DELAY_MS           = 35;
const OUTLINE_SCROLL_ALIGN_TOLERANCE_PX = 4;

/**
 * Markdown 構文木からアウトラインへ表示する見出しを収集する。
 * コードブロック内の # などは構文木で見出しにならないため対象外となる。
 * エクスポートでは `ensureSyntaxTree` 済みの木を渡し、未完成の `syntaxTree(state)` を使わない。
 * @param {EditorState} state エディタ状態
 * @param {Tree} [tree] 走査する構文木。省略時は `syntaxTree(state)`
 * @returns {OutlineItem[]} 見出し一覧
 */
export function collectOutlineItems(state: EditorState, tree: Tree = syntaxTree(state)): OutlineItem[] {
	const items: OutlineItem[] = [];
	const cursor               = tree.cursor();
	do {
		const match = HEADING_NODE_PATTERN.exec(cursor.name);
		if (!match) continue;

		const level  = Number(match[1]);
		const source = state.doc.sliceString(cursor.from, cursor.to);
		const title  = cursor.name.startsWith('ATXHeading')
			? extractAtxTitle(source)
			: extractSetextTitle(source);
		items.push({ level, title: title || '（無題）', from: cursor.from });
	} while (cursor.next());

	return items;
}

/**
 * 見出し一覧を階層ツリーにする。
 * 直前のより浅い見出しを親とし、レベルが飛んでも（H1 の直後が H3 など）その浅い見出しの子にする。
 * @param {readonly OutlineItem[]} items 文書順の見出し
 * @returns {OutlineTreeNode[]} ルート見出し
 */
export function buildOutlineTree(items: readonly OutlineItem[]): OutlineTreeNode[] {
	const roots: OutlineTreeNode[] = [];
	const stack: OutlineTreeNode[] = [];

	items.forEach((item, index) => {
		const node: OutlineTreeNode = { item, index, children: [] };
		while (stack.length > 0 && stack[stack.length - 1].item.level >= item.level) {
			stack.pop();
		}
		if (stack.length === 0) {
			roots.push(node);
		} else {
			stack[stack.length - 1].children.push(node);
		}
		stack.push(node);
	});

	return roots;
}

/**
 * 子を持つ見出しの文書位置を深さ優先で返す。
 * @param {readonly OutlineTreeNode[]} nodes ツリー
 * @returns {number[]} `from` の一覧
 */
export function collectFoldableOutlineFroms(nodes: readonly OutlineTreeNode[]): number[] {
	const froms: number[] = [];
	/**
	 * @param {readonly OutlineTreeNode[]} list ノード
	 * @returns {void}
	 */
	const walk = (list: readonly OutlineTreeNode[]): void => {
		for (const node of list) {
			if (node.children.length > 0) {
				froms.push(node.item.from);
				walk(node.children);
			}
		}
	};
	walk(nodes);
	return froms;
}

/** 現在位置が属する直前の見出しを返す。 */
export function findActiveOutlineItemIndex(items: readonly OutlineItem[], position: number): number {
	let activeIndex = -1;
	for (let index = 0; index < items.length; index += 1) {
		if (items[index].from > position) break;
		activeIndex = index;
	}
	return activeIndex;
}

/**
 * アウトライン項目へフォーカスとキャレットだけを移動する。
 * スクロールはライブプレビューの行高確定後に補正プラグインが行う。
 */
export function jumpToOutlineItem(view: OutlineJumpView, item: OutlineItem): void {
	view.focus();
	view.dispatch({
		selection: EditorSelection.cursor(item.from, 1),
		userEvent: OUTLINE_JUMP_USER_EVENT,
	});
}

/** マウスクリックでアウトラインボタンへフォーカスが移るのを防ぐ。 */
export function preserveEditorFocusOnOutlineMouseDown(event: Pick<MouseEvent, 'button' | 'preventDefault'>): void {
	if (event.button === 0) event.preventDefault();
}

/**
 * 見出し行を上端余白付きで表示するための scrollTop を計算する。
 * @param {number} lineBlockTop 見出し行のドキュメント座標
 * @param {number} clientHeight スクロール領域の高さ
 * @param {number} scrollHeight スクロール内容の高さ
 * @param {number} marginPx 上端余白
 * @returns {number} 設定する scrollTop
 */
export function computeOutlineTargetScrollTop(
	lineBlockTop: number,
	clientHeight: number,
	scrollHeight: number,
	marginPx: number = OUTLINE_SCROLL_MARGIN_PX,
): number {
	const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
	return Math.min(Math.max(0, lineBlockTop - marginPx), maxScrollTop);
}

/**
 * 実座標とスクロール限界から、追加スクロール量と到達判定を決める。
 * 文書末尾などで上端合わせできない場合は、行が見えていれば到達とみなす。
 * @param {OutlineScrollRect} rect 見出し行の画面座標
 * @param {number} scrollerTop スクロール領域上端
 * @param {number} scrollerBottom スクロール領域下端
 * @param {number} scrollTop 現在の scrollTop
 * @param {number} maxScrollTop 最大 scrollTop
 * @param {number} marginPx 上端余白
 * @returns {OutlineScrollCorrection} 補正結果
 */
export function planOutlineScrollCorrection(
	rect: OutlineScrollRect,
	scrollerTop: number,
	scrollerBottom: number,
	scrollTop: number,
	maxScrollTop: number,
	marginPx: number = OUTLINE_SCROLL_MARGIN_PX,
): OutlineScrollCorrection {
	const desiredTop       = scrollerTop + marginPx;
	const delta            = rect.top - desiredTop;
	const visible          = rect.bottom > scrollerTop && rect.top < scrollerBottom;
	const atStart          = Math.abs(delta) <= OUTLINE_SCROLL_ALIGN_TOLERANCE_PX;
	const cannotMoveUp     = delta < 0 && scrollTop <= 1;
	const cannotMoveDown   = delta > 0 && scrollTop >= maxScrollTop - 1;
	const cannotScrollMore = cannotMoveUp || cannotMoveDown;

	if ((atStart || cannotScrollMore) && visible) {
		return { delta: 0, aligned: true };
	}

	if (cannotScrollMore) {
		return { delta: 0, aligned: false };
	}

	return { delta, aligned: false };
}

/**
 * 描画キャレット再計測用のトランザクションを作る。
 * 位置は変えず、drawSelection の cursorLayer に再計測させる。
 * @param {number} from キャレット位置
 * @returns {TransactionSpec} 再描画用スペック
 */
export function createOutlineCaretRedrawSpec(from: number): TransactionSpec {
	return {
		selection: EditorSelection.cursor(from, 1),
		userEvent: OUTLINE_CARET_REDRAW_USER_EVENT,
	};
}

/**
 * アウトラインジャンプ後のスクロール補正拡張を返す。
 * @returns {ReturnType<typeof ViewPlugin.define>} 補正プラグイン
 */
export function createOutlineScrollExtension() {
	return outlineScrollPlugin;
}

/** ATX 見出しから構造用の # を除去する。 */
function extractAtxTitle(source: string): string {
	const withoutOpeningMark = source.replace(/^ {0,3}#{1,6}(?:[\t ]+|$)/, '');
	return withoutOpeningMark.replace(/[\t ]+#+[\t ]*$/, '').trim();
}

/** Setext 見出しから下線を除去する。 */
function extractSetextTitle(source: string): string {
	const newlineIndex = source.search(/\r?\n/);
	return (newlineIndex < 0 ? source : source.slice(0, newlineIndex)).trim();
}

/**
 * 現在選択がジャンプ対象のままか判定する。
 * @param {EditorView} view エディタビュー
 * @param {number} targetFrom ジャンプ先位置
 * @returns {boolean} 対象が有効なら true
 */
function isActiveOutlineScrollTarget(view: EditorView, targetFrom: number): boolean {
	return view.state.selection.main.head === targetFrom;
}

/**
 * スクロール後に描画キャレットを再計測する。
 * cursorLayer は selectionSet のときだけ再描画するため、同じ位置でも selection を再指定する。
 * @param {EditorView} view エディタビュー
 * @param {number} targetFrom ジャンプ先位置
 * @param {OutlineScrollCancelCheck} isCanceled キャンセル判定
 * @returns {void}
 */
function redrawOutlineCaret(
	view: EditorView,
	targetFrom: number,
	isCanceled: OutlineScrollCancelCheck,
): void {
	if (isCanceled() || !isActiveOutlineScrollTarget(view, targetFrom)) {
		return;
	}

	view.dispatch(createOutlineCaretRedrawSpec(targetFrom));
}

/**
 * キャレット位置の実 DOM 座標を取得する。
 * @param {EditorView} view エディタビュー
 * @returns {OutlineScrollRect | null} 座標。未描画なら null
 */
function getOutlineCursorRect(view: EditorView): OutlineScrollRect | null {
	const selection = view.state.selection.main;
	const coords    = view.coordsAtPos(selection.head, selection.assoc || 1)
		?? view.coordsAtPos(selection.head, -1)
		?? view.coordsAtPos(selection.head);

	return coords
		? {
			top   : coords.top,
			bottom: coords.bottom,
		}
		: null;
}

/**
 * 計測後の行塊座標で一次スクロールし、続けて DOM 補正する。
 * @param {EditorView} view エディタビュー
 * @param {number} targetFrom ジャンプ先位置
 * @param {OutlineScrollCancelCheck} isCanceled キャンセル判定
 * @returns {void}
 */
function scrollOutlineSelectionIntoView(
	view: EditorView,
	targetFrom: number,
	isCanceled: OutlineScrollCancelCheck,
): void {
	if (isCanceled() || !isActiveOutlineScrollTarget(view, targetFrom)) {
		return;
	}

	const scroller = view.scrollDOM;
	if (!scroller.isConnected || scroller.clientHeight <= 0) {
		return;
	}

	view.requestMeasure<OutlineInitialScrollMeasure>({
		key: outlineInitialScrollKey,
		/**
		 * 計測済み行塊から目標 scrollTop を求める。
		 * @param {EditorView} measuredView エディタビュー
		 * @returns {OutlineInitialScrollMeasure} 一次スクロール情報
		 */
		read(measuredView) {
			if (isCanceled() || !isActiveOutlineScrollTarget(measuredView, targetFrom)) {
				return null;
			}

			const measuredScroller = measuredView.scrollDOM;
			if (!measuredScroller.isConnected || measuredScroller.clientHeight <= 0) {
				return null;
			}

			const lineBlock = measuredView.lineBlockAt(targetFrom);
			return {
				targetTop: computeOutlineTargetScrollTop(
					lineBlock.top,
					measuredScroller.clientHeight,
					measuredScroller.scrollHeight,
				),
			};
		},
		/**
		 * 一次スクロールを適用し、DOM 補正を予約する。
		 * @param {OutlineInitialScrollMeasure} measure 一次スクロール情報
		 * @param {EditorView} measuredView エディタビュー
		 * @returns {void}
		 */
		write(measure, measuredView) {
			if (!measure || isCanceled() || !isActiveOutlineScrollTarget(measuredView, targetFrom)) {
				return;
			}

			measuredView.scrollDOM.scrollTop = measure.targetTop;
			measuredView.requestMeasure();
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					correctOutlineScrollFromDom(measuredView, targetFrom, isCanceled);
				});
			});
		},
	});
}

/**
 * 実 DOM 座標を使って見出し位置のスクロールを微調整する。
 * @param {EditorView} view エディタビュー
 * @param {number} targetFrom ジャンプ先位置
 * @param {OutlineScrollCancelCheck} isCanceled キャンセル判定
 * @param {number} attempts 残り試行回数
 * @returns {void}
 */
function correctOutlineScrollFromDom(
	view: EditorView,
	targetFrom: number,
	isCanceled: OutlineScrollCancelCheck,
	attempts = OUTLINE_SCROLL_FINE_ATTEMPTS,
): void {
	if (isCanceled() || !isActiveOutlineScrollTarget(view, targetFrom)) {
		return;
	}

	view.requestMeasure<OutlineScrollCorrectionMeasure>({
		key: outlineScrollCorrectionKey,
		/**
		 * キャレット実座標から追加スクロール量を計算する。
		 * @param {EditorView} measuredView エディタビュー
		 * @returns {OutlineScrollCorrectionMeasure} 補正情報
		 */
		read(measuredView) {
			if (isCanceled() || !isActiveOutlineScrollTarget(measuredView, targetFrom)) {
				return { delta: 0, needsRetry: false };
			}

			const scroller = measuredView.scrollDOM;
			if (!scroller.isConnected || scroller.clientHeight <= 0) {
				return { delta: 0, needsRetry: false };
			}

			const rect = getOutlineCursorRect(measuredView);
			if (!rect) {
				return { delta: 0, needsRetry: attempts > 1 };
			}

			const scrollerRect = scroller.getBoundingClientRect();
			const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
			const planned      = planOutlineScrollCorrection(
				rect,
				scrollerRect.top,
				scrollerRect.bottom,
				scroller.scrollTop,
				maxScrollTop,
			);

			return {
				delta     : planned.aligned ? 0 : planned.delta,
				needsRetry: !planned.aligned && attempts > 1,
			};
		},
		/**
		 * 追加スクロール量を反映する。
		 * @param {OutlineScrollCorrectionMeasure} measure 補正情報
		 * @param {EditorView} measuredView エディタビュー
		 * @returns {void}
		 */
		write(measure, measuredView) {
			if (isCanceled() || !isActiveOutlineScrollTarget(measuredView, targetFrom)) {
				return;
			}

			if (Math.abs(measure.delta) > 1) {
				measuredView.scrollDOM.scrollTop += measure.delta;
			}

			if (measure.needsRetry && attempts > 1) {
				requestAnimationFrame(() => {
					correctOutlineScrollFromDom(measuredView, targetFrom, isCanceled, attempts - 1);
				});
				return;
			}

			requestAnimationFrame(() => {
				redrawOutlineCaret(measuredView, targetFrom, isCanceled);
			});
		},
	});
}

/**
 * アウトラインジャンプ後のスクロール補正プラグイン。
 */
const outlineScrollPlugin = ViewPlugin.define((view) => {
	let scrollGeneration                                  = 0;
	let scrollTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * 予約済みスクロールを取り消す。
	 * @returns {void}
	 */
	const cancelPendingScroll = (): void => {
		scrollGeneration += 1;
		if (scrollTimer !== null) {
			clearTimeout(scrollTimer);
			scrollTimer = null;
		}
	};

	return {
		/**
		 * アウトライン選択後に行高確定を待ってスクロールする。
		 * @param {ViewUpdate} update 更新情報
		 * @returns {void}
		 */
		update(update: ViewUpdate): void {
			if (
				!update.selectionSet
				|| !update.transactions.some((transaction) => transaction.annotation(Transaction.userEvent) === OUTLINE_JUMP_USER_EVENT)
			) {
				return;
			}

			cancelPendingScroll();
			const generation = scrollGeneration;
			const targetFrom = view.state.selection.main.head;
			scrollTimer      = setTimeout(() => {
				scrollTimer = null;
				requestAnimationFrame(() => {
					scrollOutlineSelectionIntoView(
						view,
						targetFrom,
						() => generation !== scrollGeneration,
					);
				});
			}, OUTLINE_SCROLL_DELAY_MS);
		},
		/**
		 * プラグイン破棄時に予約済みスクロールを取り消す。
		 * @returns {void}
		 */
		destroy(): void {
			cancelPendingScroll();
		},
	};
});
