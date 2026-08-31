export type WheelDeltaLike = {
	deltaX: number;
	deltaY: number;
	ctrlKey: boolean;
};

export type HorizontalBoxLike = {
	left: number;
	right: number;
};

export type ScrollMetricsLike = {
	scrollLeft: number;
	scrollWidth: number;
	clientWidth: number;
};

export type HorizontalScrollerLike = ScrollMetricsLike & HorizontalBoxLike;

/**
 * タブバーのホイール操作を横スクロール量へ変換する
 * @param {WheelDeltaLike} event ホイール差分
 * @returns {number} 横方向のスクロール量
 */
export function getTabBarWheelScrollDelta(event: WheelDeltaLike): number {
	return Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
}

/**
 * タブバーへホイール差分を横スクロールとして適用する
 * @param {ScrollMetricsLike} tabBar タブバー
 * @param {WheelDeltaLike} event ホイール差分
 * @returns {boolean} スクロールを適用した場合 true
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
 * @param {HorizontalScrollerLike} scroller スクロール容器
 * @param {HorizontalBoxLike} element 対象要素の矩形
 * @returns {number} 適用すべき scrollLeft
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
 * @param {HTMLElement} scroller タブバー
 * @param {HTMLElement} element 表示したいタブ
 * @returns {void}
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
