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
	// Ctrl 付き、または内容が可視幅に収まっている。片方だけでも位置は変えない
	if (event.ctrlKey || tabBar.scrollWidth <= tabBar.clientWidth) {
		return false;
	}

	// 横へ足す量。縦ホイールの方が大きければ縦の差分を使う。単位は CSS ピクセル
	const delta = getTabBarWheelScrollDelta(event);
	// 差分が 0 なら位置は変わらない
	if (delta === 0) {
		return false;
	}

	// 右端までスクロールした位置。内容幅から可視幅を引く。単位は CSS ピクセル
	const maxScroll   = tabBar.scrollWidth - tabBar.clientWidth;
	// 0 から右端までに収めた次の位置。はみ出した差分は捨てる
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
	// タブの左が容器より左。見切れを戻すため scrollLeft を減らす
	if (element.left < scroller.left) {
		return scroller.scrollLeft - (scroller.left - element.left);
	}

	// タブの右が容器より右。見切れを戻すため scrollLeft を増やす
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
	// 容器の画面上の矩形。左右の比較に使う
	const scrollerBox   = scroller.getBoundingClientRect();
	// 見せたいタブの画面上の矩形
	const elementBox    = element.getBoundingClientRect();
	scroller.scrollLeft = computeTabRevealScrollLeft(
		// 計算へ渡す容器の寸法と画面上の左右。DOM 要素そのものは渡さない
		{
			// 現在の横スクロール位置。単位は CSS ピクセル
			scrollLeft: scroller.scrollLeft,
			// 内容の全幅。単位は CSS ピクセル
			scrollWidth: scroller.scrollWidth,
			// 可視幅。単位は CSS ピクセル
			clientWidth: scroller.clientWidth,
			// 容器左端のビューポート X
			left: scrollerBox.left,
			// 容器右端のビューポート X
			right: scrollerBox.right
		},
		elementBox
	);
}
