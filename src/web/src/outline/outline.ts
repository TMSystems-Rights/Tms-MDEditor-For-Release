/**
 * Markdown の見出しからアウトラインを作り、項目へのジャンプ後にスクロールを補正する
 * パネルの DOM は持たず、構文木とエディタビューへ渡された状態だけを読む
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { createCaretRedrawSpec } from '../editor/caretRedraw';

/**
 * アウトラインに出す 1 つの見出し
 * 階層はレベル番号で表し、木の親子は別の型が持つ
 */
export type OutlineItem = {
	/** 見出しレベル。1 が最上位、6 が最下位 */
	level: number;
	/** 記号を除いた見出し文。空の見出しは収集時に代替文へ置き換える */
	title: string;
	/** 見出しの開始位置。文書先頭からの文字数 */
	from: number;
};

/**
 * 見出しを親子に組んだ節
 * `index` は元の一覧での位置で、画面の折りたたみとは独立
 */
export type OutlineTreeNode = {
	/** この節の見出し */
	item: OutlineItem;
	/** `OutlineItem` 配列での位置。0 始まり */
	index: number;
	/** 直下の子。葉は空配列 */
	children: OutlineTreeNode[];
};

/**
 * 見出し行の画面上の縦範囲
 * スクロール補正で、上端余白との差を見る
 */
export type OutlineScrollRect = {
	/** 上端。単位は CSS ピクセル */
	top: number;
	/** 下端。単位は CSS ピクセル */
	bottom: number;
};

/**
 * 追加スクロールの量と、目標へ届いたか
 * `aligned` が true のとき `delta` は 0
 */
export type OutlineScrollCorrection = {
	/** 足すべき scrollTop。単位は CSS ピクセル。上へ動かすときは負 */
	delta: number;
	/** 上端余白へ届いた、またはそれ以上スクロールできないが見えているか */
	aligned: boolean;
};

/**
 * アウトラインからキャレットを動かす対象
 * テストでは `EditorView` 全体を渡さず、この 2 操作だけで足りる
 */
type OutlineJumpView = {
	/** エディタへフォーカスを戻す */
	focus: () => void;
	/**
	 * キャレット移動のトランザクションを適用する
	 * @param transaction - 選択とユーザイベントを含む仕様
	 */
	dispatch: (transaction: TransactionSpec) => void;
};

/**
 * 遅れて実行するスクロールを中止するか
 * true のときは、より新しいジャンプが予約を無効にしている
 */
type OutlineScrollCancelCheck = () => boolean;

/**
 * 行塊から求めた一次スクロール
 * 計測を中止したときは null
 */
type OutlineInitialScrollMeasure = {
	/** 設定する scrollTop。単位は CSS ピクセル */
	targetTop: number;
} | null;

/**
 * DOM 座標から求めた微調整
 * 再試行が不要なら `needsRetry` は false
 */
type OutlineScrollCorrectionMeasure = {
	/** 足す scrollTop。単位は CSS ピクセル */
	delta: number;
	/** まだ目標へ届かず、試行回数が残っているか */
	needsRetry: boolean;
};

/** Lezer の ATX / Setext 見出し名からレベル 1〜6 を取る正規表現 */
const HEADING_NODE_PATTERN              = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/** アウトラインからの選択であることを示す userEvent。スクロール補正の起点 */
const OUTLINE_JUMP_USER_EVENT           = 'select.outline';

/** 一次スクロールの requestMeasure を識別するキー。同じキーの計測は置き換わる */
const outlineInitialScrollKey           = {};

/** DOM 補正の requestMeasure を識別するキー。一次スクロールとは別枠 */
const outlineScrollCorrectionKey        = {};

/** 見出しをスクロール領域の上端から離す余白。単位は CSS ピクセル */
const OUTLINE_SCROLL_MARGIN_PX          = 12;

/** DOM 補正の最大試行回数。行高が遅れて確定するライブプレビュー向け */
const OUTLINE_SCROLL_FINE_ATTEMPTS      = 5;

/** ジャンプ後、行高が揃い始めるまで待つ時間。単位はミリ秒 */
const OUTLINE_SCROLL_DELAY_MS           = 35;

/** この差以内なら上端に揃ったとみなす。単位は CSS ピクセル */
const OUTLINE_SCROLL_ALIGN_TOLERANCE_PX = 4;

/**
 * Markdown 構文木からアウトラインへ表示する見出しを収集する
 * コードブロック内の # などは構文木で見出しにならないため対象外となる
 * エクスポートでは `ensureSyntaxTree` 済みの木を渡し、未完成の `syntaxTree(state)` を使わない
 * @param state - 見出しを集めるエディタ状態
 * @param tree - 走査する構文木。省略時は `syntaxTree(state)`。未完成の木は見出しを欠く
 * @returns 文書順の見出し。空の見出し文は `（無題）`
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
 * 見出し一覧を階層ツリーにする
 * 直前のより浅い見出しを親とし、レベルが飛んでも（H1 の直後が H3 など）その浅い見出しの子にする
 * @param items - 文書順の見出し
 * @returns ルート見出し。入力が空なら空配列
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
 * 子を持つ見出しの文書位置を深さ優先で返す
 * @param nodes - 折りたたみ対象を探す木
 * @returns 子を持つ見出しの `from`。葉は含まない
 */
export function collectFoldableOutlineFroms(nodes: readonly OutlineTreeNode[]): number[] {
	const froms: number[] = [];
	/**
	 * 子を持つ節の `from` を深さ優先で集める
	 * @param list - いま辿っている兄弟
	 */
	const walk            = (list: readonly OutlineTreeNode[]): void => {
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

/**
 * 現在位置が属する直前の見出しのインデックスを返す
 * どの見出しよりも前なら -1
 * @param items - 文書順の見出し
 * @param position - 文書上の位置。この値以下で最も後ろの見出しを選ぶ
 * @returns 見出し配列のインデックス。該当が無ければ -1
 */
export function findActiveOutlineItemIndex(items: readonly OutlineItem[], position: number): number {
	let activeIndex = -1;
	for (let index = 0; index < items.length; index += 1) {
		if (items[index].from > position) break;
		activeIndex = index;
	}
	return activeIndex;
}

/**
 * アクティブ見出しを内包する祖先見出しの文書位置を返す
 * @param items - 文書順の見出し
 * @param activeIndex - アクティブ見出しのインデックス。範囲外は空配列
 * @returns 外側から内側の順に並んだ祖先の `from`
 */
export function collectOutlineAncestorFroms(
	items: readonly OutlineItem[],
	activeIndex: number,
): number[] {
	if (activeIndex < 0 || activeIndex >= items.length) return [];

	const ancestors: number[] = [];
	let childLevel            = items[activeIndex].level;
	for (let index = activeIndex - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item.level >= childLevel) continue;

		ancestors.unshift(item.from);
		childLevel = item.level;
	}

	return ancestors;
}

/**
 * アクティブ項目をアウトラインの表示範囲へ収める scrollTop を返す
 * 余白の内側に収まっていれば現在の scrollTop を返す
 * @param input - 項目と一覧の縦位置。単位は CSS ピクセル。`margin` を省略すると 6
 * @returns 0 から `maxScrollTop` に収めた scrollTop
 */
export function computeOutlineListScrollTop(input: {
	itemTop: number;
	itemBottom: number;
	viewportTop: number;
	viewportBottom: number;
	scrollTop: number;
	maxScrollTop: number;
	margin?: number;
}): number {
	const margin = Math.max(0, input.margin ?? 6);
	let target   = input.scrollTop;
	if (input.itemTop < input.viewportTop + margin) {
		target += input.itemTop - input.viewportTop - margin;
	} else if (input.itemBottom > input.viewportBottom - margin) {
		target += input.itemBottom - input.viewportBottom + margin;
	}

	return Math.min(input.maxScrollTop, Math.max(0, target));
}

// ----------------------------------------------
// ジャンプ後のスクロール
// ----------------------------------------------

/**
 * アウトライン項目へフォーカスとキャレットだけを移動する
 * スクロールはライブプレビューの行高確定後に補正プラグインが行う
 * @param view - フォーカスと選択を受け取るビュー
 * @param item - 移動先の見出し。キャレットはその開始位置
 */
export function jumpToOutlineItem(view: OutlineJumpView, item: OutlineItem): void {
	view.focus();
	view.dispatch({
		selection: EditorSelection.cursor(item.from, 1),
		userEvent: OUTLINE_JUMP_USER_EVENT,
	});
}

/**
 * 左ボタンの押下でアウトライン側へフォーカスが移るのを防ぐ
 * 左ボタン以外は既定の動作に任せる
 * @param event - 押下イベント。左ボタンのときだけ `preventDefault` する
 */
export function preserveEditorFocusOnOutlineMouseDown(event: Pick<MouseEvent, 'button' | 'preventDefault'>): void {
	if (event.button === 0) event.preventDefault();
}

/**
 * 見出し行を上端余白付きで表示するための scrollTop を計算する
 * @param lineBlockTop - 見出し行の文書内上端。単位は CSS ピクセル
 * @param clientHeight - スクロール領域の高さ。単位は CSS ピクセル
 * @param scrollHeight - スクロール内容の高さ。単位は CSS ピクセル
 * @param marginPx - 上端余白。省略時は `OUTLINE_SCROLL_MARGIN_PX`
 * @returns 0 から最大 scrollTop に収めた値
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
 * 実座標とスクロール限界から、追加スクロール量と到達判定を決める
 * 文書末尾などで上端合わせできない場合は、行が見えていれば到達とみなす
 * @param rect - 見出し行の画面座標
 * @param scrollerTop - スクロール領域の上端。単位は CSS ピクセル
 * @param scrollerBottom - スクロール領域の下端。単位は CSS ピクセル
 * @param scrollTop - 現在の scrollTop
 * @param maxScrollTop - これ以上は動かせない scrollTop
 * @param marginPx - 上端余白。省略時は `OUTLINE_SCROLL_MARGIN_PX`
 * @returns 追加で動かす量と、到達したとみなすか
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
 * 描画キャレット再計測用のトランザクションを作る
 * 位置は変えず、drawSelection の cursorLayer に再計測させる
 * @param from - 再計測させるキャレット位置
 * @returns 選択を同じ位置で出し直すトランザクション仕様
 */
export function createOutlineCaretRedrawSpec(from: number): TransactionSpec {
	return createCaretRedrawSpec(EditorSelection.create([EditorSelection.cursor(from, 1)]));
}

/**
 * アウトラインジャンプ後のスクロール補正拡張を返す
 * 同じプラグインインスタンスを返す。ジャンプ以外の選択ではスクロールしない
 * @returns エディタへ渡すスクロール補正プラグイン
 */
export function createOutlineScrollExtension() {
	return outlineScrollPlugin;
}

/**
 * ATX 見出しから、開く `#` と閉じる `#` を除いた本文を返す
 * @param source - 見出しノードの原文
 * @returns 前後の空白を除いた見出し文。記号だけなら空文字
 */
function extractAtxTitle(source: string): string {
	const withoutOpeningMark = source.replace(/^ {0,3}#{1,6}(?:[\t ]+|$)/, '');
	return withoutOpeningMark.replace(/[\t ]+#+[\t ]*$/, '').trim();
}

/**
 * Setext 見出しから下線行を除いた本文を返す
 * 改行が無いときは全文の前後空白を除く
 * @param source - 見出しノードの原文。下線を含むことがある
 * @returns 1 行目の前後空白を除いた見出し文
 */
function extractSetextTitle(source: string): string {
	const newlineIndex = source.search(/\r?\n/);
	return (newlineIndex < 0 ? source : source.slice(0, newlineIndex)).trim();
}

/**
 * 選択が、ジャンプ先の位置のままか判定する
 * ユーザーが別の場所へ動かすと、遅れたスクロールは行わない
 * @param view - 選択を見るエディタ
 * @param targetFrom - ジャンプ先の文書位置
 * @returns 主選択の head が一致するとき true
 */
function isActiveOutlineScrollTarget(view: EditorView, targetFrom: number): boolean {
	return view.state.selection.main.head === targetFrom;
}

/**
 * スクロール後に描画キャレットを再計測する
 * cursorLayer は selectionSet のときだけ再描画するため、同じ位置でも選択を出し直す
 * キャンセル済み、または選択が動いていれば何もしない
 * @param view - 再描画するエディタ
 * @param targetFrom - ジャンプ先の文書位置
 * @param isCanceled - より新しいジャンプで無効なら true
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
 * キャレット位置の画面上の縦範囲を返す
 * 座標がまだ無いときは null
 * @param view - 座標を測るエディタ
 * @returns キャレット行の上端と下端。未描画なら null
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
 * 計測後の行塊座標で一次スクロールし、続けて DOM 補正する
 * スクロール領域が無い、またはキャンセル済みなら何もしない
 * @param view - スクロールするエディタ
 * @param targetFrom - ジャンプ先の文書位置
 * @param isCanceled - より新しいジャンプで無効なら true
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
		 * 計測済みの行塊から、目標の scrollTop を求める
		 * キャンセル済み、またはスクロール領域が無いときは null
		 * @param measuredView - 行塊を測るエディタ
		 * @returns 一次スクロール先。中止したときは null
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
		 * 一次スクロールを適用し、次のフレームで DOM 補正を予約する
		 * 計測結果が null、または選択が変わっていれば動かさない
		 * @param measure - 一次スクロール先。中止時は null
		 * @param measuredView - scrollTop を書くエディタ
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
 * 実 DOM 座標を使って見出し位置のスクロールを微調整する
 * 届かないあいだは `attempts` が残る限り次のフレームでやり直す
 * @param view - 微調整するエディタ
 * @param targetFrom - ジャンプ先の文書位置
 * @param isCanceled - より新しいジャンプで無効なら true
 * @param attempts - 残りの試行回数。省略時は `OUTLINE_SCROLL_FINE_ATTEMPTS`
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
		 * キャレットの実座標から、追加で動かす量を計算する
		 * 座標がまだ無ければ、試行が残るときだけ再試行にする
		 * @param measuredView - 座標を測るエディタ
		 * @returns 追加スクロール量と、再試行が要るか
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
		 * 追加スクロールを反映し、必要なら再試行してからキャレットを描き直す
		 * 1px 以内の差は動かさない
		 * @param measure - 追加量と再試行の要否
		 * @param measuredView - scrollTop を書くエディタ
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
 * アウトラインジャンプ後に、行高の確定を待ってスクロールするプラグイン
 * ジャンプ以外の選択変更では動かない
 */
const outlineScrollPlugin = ViewPlugin.define((view) => {
	let scrollGeneration                                  = 0;
	let scrollTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * 予約済みスクロールを取り消し、世代番号を進めて遅れた処理を無効にする
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
		 * アウトライン選択のあと、行高が揃うまで待ってスクロールする
		 * 別のジャンプが来たら、待っている処理は世代番号で捨てる
		 * @param update - 今回のビュー更新。アウトラインの userEvent だけを見る
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
		 * プラグインを外すとき、予約済みのスクロールを取り消す
		 */
		destroy(): void {
			cancelPendingScroll();
		},
	};
});
