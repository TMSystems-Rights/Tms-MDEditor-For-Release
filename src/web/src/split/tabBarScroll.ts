/**
 * タブバーのホイールと、見切れたタブを見える位置へ戻す横スクロールを計算する
 * タブの並び替えは持たない
 * @file
 */

/**
 * ホイールイベントから使う差分
 * Ctrl 付きは UI ズームに譲るため、横スクロールへは使わない
 */
export type WheelDeltaLike = {
	/** 横方向のホイール差分。正は右 */
	deltaX: number;
	/** 縦方向のホイール差分。横より大きいときはこちらを横スクロール量にする */
	deltaY: number;
	/** Ctrl が押されているか。true のときはスクロールしない */
	ctrlKey: boolean;
};

/**
 * 画面上の横範囲
 * タブや容器の左端・右端を、同じ座標系で比べる
 */
export type HorizontalBoxLike = {
	/** 左端。単位は CSS ピクセル */
	left: number;
	/** 右端。単位は CSS ピクセル */
	right: number;
};

/**
 * 横スクロール位置の計算に使う寸法
 * DOM 要素そのものではなく、必要な数値だけを持つ
 */
export type ScrollMetricsLike = {
	/** 現在の横スクロール位置。単位は CSS ピクセル */
	scrollLeft: number;
	/** 内容の全幅。単位は CSS ピクセル */
	scrollWidth: number;
	/** 可視幅。単位は CSS ピクセル。これ以上広がらないときはスクロールしない */
	clientWidth: number;
};

/** スクロール容器の寸法と画面上の横範囲 */
export type HorizontalScrollerLike = ScrollMetricsLike & HorizontalBoxLike;

/**
 * タブバーのホイール操作を横スクロール量へ変換する
 * 絶対値が大きい軸を採用する。縦ホイールしか無い環境でも横へ流すため
 * @param event - ホイール差分。Ctrl の有無はこの関数では見ない
 * @returns 横方向へ足すスクロール量。正は右
 */
export function getTabBarWheelScrollDelta(event: WheelDeltaLike): number {
	return Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
}

/**
 * タブバーへホイール差分を横スクロールとして適用する
 * Ctrl 付き、溢れていない、差分 0 のときは `scrollLeft` を変えず false
 * @param tabBar - 更新するスクロール寸法。適用できたときは `scrollLeft` を書き換える
 * @param event - ホイール差分
 * @returns スクロール位置を変えた場合 true
 */
export function applyTabBarWheelScroll(tabBar: ScrollMetricsLike, event: WheelDeltaLike): boolean {
	if (event.ctrlKey || tabBar.scrollWidth <= tabBar.clientWidth) {
		return false;
	}

	const delta = getTabBarWheelScrollDelta(event);
	if (delta === 0) {
		return false;
	}

	const maxScroll   = tabBar.scrollWidth - tabBar.clientWidth;
	const nextScroll  = Math.min(maxScroll, Math.max(0, tabBar.scrollLeft + delta));
	tabBar.scrollLeft = nextScroll;
	return true;
}

/**
 * 要素が横スクロール領域内に収まる scrollLeft を計算する
 * すでに見えていれば現在値を返す。左にはみ出すときは左へ、右にはみ出すときは右へ動かす
 * @param scroller - 容器の寸法と画面上の左右
 * @param element - 見せたい要素の画面上の左右
 * @returns 適用すべき `scrollLeft`。単位は CSS ピクセル
 */
export function computeTabRevealScrollLeft(scroller: HorizontalScrollerLike, element: HorizontalBoxLike): number {
	if (element.left < scroller.left) {
		return scroller.scrollLeft - (scroller.left - element.left);
	}

	if (element.right > scroller.right) {
		return scroller.scrollLeft + (element.right - scroller.right);
	}

	return scroller.scrollLeft;
}

/**
 * 指定要素がタブバーの可視範囲に入るよう横スクロールする
 * 現在の矩形を測り、`computeTabRevealScrollLeft` の結果を `scrollLeft` へ書く
 * @param scroller - スクロールするタブバー
 * @param element - 表示したいタブ
 */
export function revealElementInHorizontalScroller(scroller: HTMLElement, element: HTMLElement): void {
	const scrollerBox   = scroller.getBoundingClientRect();
	const elementBox    = element.getBoundingClientRect();
	scroller.scrollLeft = computeTabRevealScrollLeft(
		{
			scrollLeft : scroller.scrollLeft,
			scrollWidth: scroller.scrollWidth,
			clientWidth: scroller.clientWidth,
			left       : scrollerBox.left,
			right      : scrollerBox.right
		},
		elementBox
	);
}
