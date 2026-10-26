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
const HEADING_NODE_PATTERN = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/** アウトラインからの選択であることを示す userEvent。スクロール補正の起点 */
const OUTLINE_JUMP_USER_EVENT = 'select.outline';

/** 一次スクロールの requestMeasure を識別するキー。同じキーの計測は置き換わる */
const outlineInitialScrollKey = {};

/** DOM 補正の requestMeasure を識別するキー。一次スクロールとは別枠 */
const outlineScrollCorrectionKey = {};

/** 見出しをスクロール領域の上端から離す余白。単位は CSS ピクセル */
const OUTLINE_SCROLL_MARGIN_PX = 12;

/** DOM 補正の最大試行回数。行高が遅れて確定するライブプレビュー向け */
const OUTLINE_SCROLL_FINE_ATTEMPTS = 5;

/** ジャンプ後、行高が揃い始めるまで待つ時間。単位はミリ秒 */
const OUTLINE_SCROLL_DELAY_MS = 35;

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
	// 文書順の見出し。コードブロック内の # は構文木に出ない
	const items: OutlineItem[] = [];
	// 構文木を辿るカーソル。先頭から do-while で進む
	const cursor               = tree.cursor();
	do {
		// 見出しノードのレベル番号。見出しでなければ null
		const match = HEADING_NODE_PATTERN.exec(cursor.name);
		// 見出し以外のノードは集めない
		if (!match) continue;

		// 1〜6 の見出しレベル。マッチの 1 番目が数字
		const level  = Number(match[1]);
		// 見出しノードの原文。記号を含む
		const source = state.doc.sliceString(cursor.from, cursor.to);
		// 記号を除いた見出し文。ATX と Setext で取り方が違う
		const title  = cursor.name.startsWith('ATXHeading') ? extractAtxTitle(source) : extractSetextTitle(source);
		// 1 件の見出し。空の本文は（無題）
		items.push({
			// 見出しレベル。1 が最上位
			level,
			// 記号を除いた見出し文。空なら（無題）
			title: title || '（無題）',
			// 見出しの開始位置。文書先頭からの文字数
			from: cursor.from
		});
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
	// 親を持たない見出し
	const roots: OutlineTreeNode[] = [];
	// 開いている祖先。末尾がいまの親候補
	const stack: OutlineTreeNode[] = [];

	items.forEach((item, index) => {
		// この見出しの節。子は後から足す
		const node: OutlineTreeNode = {
			// 元の見出し
			item,
			// 入力配列での位置。0 始まり
			index,
			// 直下の子。葉は空のまま
			children: []
		};
		while (stack.length > 0 && stack[stack.length - 1].item.level >= item.level) {
			stack.pop();
		}
		// より浅い見出しが残っていない。ルートになる
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
	// 子を持つ見出しの開始位置。葉は入れない
	const froms: number[] = [];
	/**
	 * 子を持つ節の `from` を深さ優先で集める
	 * @param list - いま辿っている兄弟
	 */
	const walk            = (list: readonly OutlineTreeNode[]): void => {
		for (const node of list) {
			// 子がある見出しだけ折りたたみ対象。葉は飛ばす
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
	// 位置以前で最も後ろの見出し。どの見出しより前なら -1
	let activeIndex = -1;
	for (let index = 0; index < items.length; index += 1) {
		// この見出しは位置より後ろ。これ以降は見ない
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
export function collectOutlineAncestorFroms(items: readonly OutlineItem[], activeIndex: number): number[] {
	// 範囲外のインデックス。祖先は無い
	if (activeIndex < 0 || activeIndex >= items.length) return [];

	// 外側が先になる祖先の開始位置
	const ancestors: number[] = [];
	// いま探している親より浅いレベルの上限。アクティブ見出しのレベルから始まる
	let childLevel            = items[activeIndex].level;
	for (let index = activeIndex - 1; index >= 0; index -= 1) {
		// アクティブより前の見出し
		const item = items[index];
		// 同じ深さかより深い見出しは祖先ではない
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
export function computeOutlineListScrollTop(input: { itemTop: number; itemBottom: number; viewportTop: number; viewportBottom: number; scrollTop: number; maxScrollTop: number; margin?: number }): number {
	// 上端と下端に残す余白。未指定は 6。負は 0。単位は CSS ピクセル
	const margin = Math.max(0, input.margin ?? 6);
	// 収めた後の scrollTop。まずは現在値。単位は CSS ピクセル
	let target   = input.scrollTop;
	// 項目の上が余白より上。見える位置まで scrollTop を減らす
	if (input.itemTop < input.viewportTop + margin) {
		target += input.itemTop - input.viewportTop - margin;
		// 上は収まっていて、下が余白より下。見える位置まで scrollTop を増やす
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
	// キャレットを見出し先頭へ移す。スクロールは補正プラグインが後で行う
	view.dispatch({
		// 見出し開始の空キャレット。assoc は行の内側
		selection: EditorSelection.cursor(item.from, 1),
		// 補正プラグインがこの選択だけをスクロール対象にする印
		userEvent: OUTLINE_JUMP_USER_EVENT
	});
}

/**
 * 左ボタンの押下でアウトライン側へフォーカスが移るのを防ぐ
 * 左ボタン以外は既定の動作に任せる
 * @param event - 押下イベント。左ボタンのときだけ `preventDefault` する
 */
export function preserveEditorFocusOnOutlineMouseDown(event: Pick<MouseEvent, 'button' | 'preventDefault'>): void {
	// 左ボタンだけフォーカス移動を止める。中ボタンや右ボタンは既定のまま
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
export function computeOutlineTargetScrollTop(lineBlockTop: number, clientHeight: number, scrollHeight: number, marginPx: number = OUTLINE_SCROLL_MARGIN_PX): number {
	// これ以上動かせない scrollTop。内容が高さ以下なら 0。単位は CSS ピクセル
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
export function planOutlineScrollCorrection(rect: OutlineScrollRect, scrollerTop: number, scrollerBottom: number, scrollTop: number, maxScrollTop: number, marginPx: number = OUTLINE_SCROLL_MARGIN_PX): OutlineScrollCorrection {
	// 余白を足した目標の上端。単位は CSS ピクセル
	const desiredTop       = scrollerTop + marginPx;
	// 目標までの差分。負は上へ、正は下へ動かす。単位は CSS ピクセル
	const delta            = rect.top - desiredTop;
	// 行の一部がスクロール領域に見えているか。完全に外なら false
	const visible          = rect.bottom > scrollerTop && rect.top < scrollerBottom;
	// 差が許容以内。これ以上動かさなくて揃っている
	const atStart          = Math.abs(delta) <= OUTLINE_SCROLL_ALIGN_TOLERANCE_PX;
	// 上へ動かしたいが、すでに上端。1px 以内は上端とみなす
	const cannotMoveUp     = delta < 0 && scrollTop <= 1;
	// 下へ動かしたいが、すでに下端。1px 以内は下端とみなす
	const cannotMoveDown   = delta > 0 && scrollTop >= maxScrollTop - 1;
	// 上にも下にも、これ以上は動かせない
	const cannotScrollMore = cannotMoveUp || cannotMoveDown;

	// 揃っているか、これ以上動かせず、かつ行が見えている。到達とみなす。どれか一つが欠けると入らない
	if ((atStart || cannotScrollMore) && visible) {
		// 追加スクロールは不要。到達済み
		return {
			// 動かす量は 0
			delta: 0,
			// 目標へ届いた、または見えていて限界
			aligned: true
		};
	}

	// これ以上動かせないが、行は見えていない。到達にはしない
	if (cannotScrollMore) {
		// 動けないので差分は捨てる
		return {
			// 動かす量は 0
			delta: 0,
			// 見えていないので未到達
			aligned: false
		};
	}

	// まだ動かせる差分
	return {
		// 目標までの追加量。単位は CSS ピクセル
		delta,
		// この適用だけでは到達扱いしない
		aligned: false
	};
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
	// 開きの # と直後の空白を除いた残り。閉じ # はまだ含む
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
	// 最初の改行位置。無いときは -1 で全文を見出し文にする
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
function redrawOutlineCaret(view: EditorView, targetFrom: number, isCanceled: OutlineScrollCancelCheck): void {
	// より新しいジャンプで無効、または選択がすでに動いている。どちらかなら描き直さない
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
	// 主選択。座標を測る位置
	const selection = view.state.selection.main;
	// キャレットの画面座標。assoc、反対側、位置だけの順で試し、どれも無ければ null
	const coords    = view.coordsAtPos(selection.head, selection.assoc || 1) ?? view.coordsAtPos(selection.head, -1) ?? view.coordsAtPos(selection.head);

	return coords
		? {
			// 行の上端。単位は CSS ピクセル
			top: coords.top,
			// 行の下端。単位は CSS ピクセル
			bottom: coords.bottom
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
function scrollOutlineSelectionIntoView(view: EditorView, targetFrom: number, isCanceled: OutlineScrollCancelCheck): void {
	// より新しいジャンプで無効、または選択が動いている。どちらかならスクロールしない
	if (isCanceled() || !isActiveOutlineScrollTarget(view, targetFrom)) {
		return;
	}

	// エディタのスクロール領域
	const scroller = view.scrollDOM;
	// DOM から外れている、または高さが 0。どちらかなら測れないので動かさない
	if (!scroller.isConnected || scroller.clientHeight <= 0) {
		return;
	}

	// 行塊が確定してから scrollTop を決める計測。同じキーの計測は置き換わる
	view.requestMeasure<OutlineInitialScrollMeasure>({
		// 一次スクロール用のキー。DOM 補正とは別枠
		key: outlineInitialScrollKey,
		/**
		 * 計測済みの行塊から、目標の scrollTop を求める
		 * キャンセル済み、またはスクロール領域が無いときは null
		 * @param measuredView - 行塊を測るエディタ
		 * @returns 一次スクロール先。中止したときは null
		 */
		read(measuredView) {
			// 計測の時点で無効、または選択が動いている。どちらかならスクロールしない
			if (isCanceled() || !isActiveOutlineScrollTarget(measuredView, targetFrom)) {
				return null;
			}

			// 計測時のスクロール領域
			const measuredScroller = measuredView.scrollDOM;
			// DOM から外れている、または高さが 0。どちらかなら目標を決めない
			if (!measuredScroller.isConnected || measuredScroller.clientHeight <= 0) {
				return null;
			}

			// ジャンプ先の行塊。上端が scrollTop の基準
			const lineBlock = measuredView.lineBlockAt(targetFrom);
			// 一次スクロール先
			return {
				// 余白付きの scrollTop。単位は CSS ピクセル
				targetTop: computeOutlineTargetScrollTop(lineBlock.top, measuredScroller.clientHeight, measuredScroller.scrollHeight)
			};
		},
		/**
		 * 一次スクロールを適用し、次のフレームで DOM 補正を予約する
		 * 計測結果が null、または選択が変わっていれば動かさない
		 * @param measure - 一次スクロール先。中止時は null
		 * @param measuredView - scrollTop を書くエディタ
		 */
		write(measure, measuredView) {
			// 計測が中止、無効、または選択が動いている。どれか一つでも動かさない
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
		}
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
function correctOutlineScrollFromDom(view: EditorView, targetFrom: number, isCanceled: OutlineScrollCancelCheck, attempts = OUTLINE_SCROLL_FINE_ATTEMPTS): void {
	// より新しいジャンプで無効、または選択が動いている。どちらかなら微調整しない
	if (isCanceled() || !isActiveOutlineScrollTarget(view, targetFrom)) {
		return;
	}

	// 実座標から追加量を決める計測。一次スクロールとは別キー
	view.requestMeasure<OutlineScrollCorrectionMeasure>({
		// DOM 補正用のキー。一次スクロールの計測を上書きしない
		key: outlineScrollCorrectionKey,
		/**
		 * キャレットの実座標から、追加で動かす量を計算する
		 * 座標がまだ無ければ、試行が残るときだけ再試行にする
		 * @param measuredView - 座標を測るエディタ
		 * @returns 追加スクロール量と、再試行が要るか
		 */
		read(measuredView) {
			// 計測の時点で無効、または選択が動いている。再試行もしない
			if (isCanceled() || !isActiveOutlineScrollTarget(measuredView, targetFrom)) {
				// 動かさず、やり直さない
				return {
					// 追加量は 0
					delta: 0,
					// 無効なので再試行しない
					needsRetry: false
				};
			}

			// 計測時のスクロール領域
			const scroller = measuredView.scrollDOM;
			// DOM から外れている、または高さが 0。どちらかなら微調整できない
			if (!scroller.isConnected || scroller.clientHeight <= 0) {
				// 領域が無いので動かさず、やり直さない
				return {
					// 追加量は 0
					delta: 0,
					// 領域が無いので再試行しない
					needsRetry: false
				};
			}

			// キャレット行の画面座標。未描画なら null
			const rect = getOutlineCursorRect(measuredView);
			// 座標がまだ無い。試行が残るときだけ次のフレームでやり直す
			if (!rect) {
				// まだ測れないときの結果
				return {
					// 追加量は 0
					delta: 0,
					// 残り試行が 2 回以上のときだけやり直す
					needsRetry: attempts > 1
				};
			}

			// スクロール領域の画面矩形
			const scrollerRect = scroller.getBoundingClientRect();
			// これ以上動かせない scrollTop。単位は CSS ピクセル
			const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
			// 目標までの差分と、到達とみなすか
			const planned      = planOutlineScrollCorrection(rect, scrollerRect.top, scrollerRect.bottom, scroller.scrollTop, maxScrollTop);

			// このフレームで動かす量と、次のフレームが要るか
			return {
				// 到達済みなら 0。未到達なら計画した差分。単位は CSS ピクセル
				delta: planned.aligned ? 0 : planned.delta,
				// 未到達かつ試行が残るときだけやり直す。どちらか一方ではやり直さない
				needsRetry: !planned.aligned && attempts > 1
			};
		},
		/**
		 * 追加スクロールを反映し、必要なら再試行してからキャレットを描き直す
		 * 1px 以内の差は動かさない
		 * @param measure - 追加量と再試行の要否
		 * @param measuredView - scrollTop を書くエディタ
		 */
		write(measure, measuredView) {
			// 適用の時点で無効、または選択が動いている。どちらかなら scrollTop を変えない
			if (isCanceled() || !isActiveOutlineScrollTarget(measuredView, targetFrom)) {
				return;
			}

			// 1px より大きい差だけ動かす。1px 以内は描画の揺れとして捨てる
			if (Math.abs(measure.delta) > 1) {
				measuredView.scrollDOM.scrollTop += measure.delta;
			}

			// 未到達かつ試行が残る。どちらか一方では再試行しない
			if (measure.needsRetry && attempts > 1) {
				requestAnimationFrame(() => {
					correctOutlineScrollFromDom(measuredView, targetFrom, isCanceled, attempts - 1);
				});
				return;
			}

			requestAnimationFrame(() => {
				redrawOutlineCaret(measuredView, targetFrom, isCanceled);
			});
		}
	});
}

/**
 * アウトラインジャンプ後に、行高の確定を待ってスクロールするプラグイン
 * ジャンプ以外の選択変更では動かない
 */
const outlineScrollPlugin = ViewPlugin.define((view) => {
	// ジャンプの世代。遅れた処理は番号が違えば捨てる。0 から始まる
	let scrollGeneration                                  = 0;
	// 行高を待つタイマー。予約が無ければ null
	let scrollTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * 予約済みスクロールを取り消し、世代番号を進めて遅れた処理を無効にする
	 */
	const cancelPendingScroll = (): void => {
		scrollGeneration += 1;
		// 待ちタイマーがあるときだけ取り消す。無いときは世代だけ進める
		if (scrollTimer !== null) {
			clearTimeout(scrollTimer);
			scrollTimer = null;
		}
	};

	// 選択の監視と、プラグインを外すときの取り消し
	return {
		/**
		 * アウトライン選択のあと、行高が揃うまで待ってスクロールする
		 * 別のジャンプが来たら、待っている処理は世代番号で捨てる
		 * @param update - 今回のビュー更新。アウトラインの userEvent だけを見る
		 */
		update(update: ViewUpdate): void {
			// 選択が変わっていない、またはアウトラインジャンプ以外。どちらかならスクロールしない
			if (!update.selectionSet || !update.transactions.some((transaction) => transaction.annotation(Transaction.userEvent) === OUTLINE_JUMP_USER_EVENT)) {
				return;
			}

			cancelPendingScroll();
			// このジャンプの世代。タイマー発火時に違っていれば捨てる
			const generation = scrollGeneration;
			// ジャンプ先の文書位置。タイマー中に選択が変わっても、この位置を見る
			const targetFrom = view.state.selection.main.head;
			// 行高が揃い始めるまで待ってから測る。世代が違えば中の処理は捨てる
			scrollTimer      = setTimeout(() => {
				scrollTimer = null;
				requestAnimationFrame(() => {
					scrollOutlineSelectionIntoView(view, targetFrom, () => generation !== scrollGeneration);
				});
			}, OUTLINE_SCROLL_DELAY_MS);
		},
		/**
		 * プラグインを外すとき、予約済みのスクロールを取り消す
		 */
		destroy(): void {
			cancelPendingScroll();
		}
	};
});
