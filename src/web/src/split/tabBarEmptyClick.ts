export type TabBarDoubleClickHit = {
	onTab: boolean;
	onNewTabButton: boolean;
	inHorizontalScrollbar: boolean;
};

export type HorizontalScrollbarBoxLike = {
	left: number;
	right: number;
	top: number;
	bottom: number;
	clientHeight: number;
};

/**
 * タブバー空白のダブルクリックで無題タブを開くべきか判定する
 * @param {TabBarDoubleClickHit} hit ヒット位置
 * @returns {boolean} 開く場合 true
 */
export function shouldOpenUntitledTabOnTabBarDoubleClick(hit: TabBarDoubleClickHit): boolean {
	return !hit.onTab && !hit.onNewTabButton && !hit.inHorizontalScrollbar;
}

/**
 * 点が横スクロールバー領域にあるか判定する
 * @param {HorizontalScrollbarBoxLike} box スクロール容器
 * @param {number} clientX クライアントX
 * @param {number} clientY クライアントY
 * @returns {boolean} スクロールバー上なら true
 */
export function isPointInHorizontalScrollbar(
	box: HorizontalScrollbarBoxLike,
	clientX: number,
	clientY: number
): boolean {
	const scrollbarTop = box.top + box.clientHeight;
	if (scrollbarTop >= box.bottom - 0.5) {
		return false;
	}

	return clientX >= box.left
		&& clientX <= box.right
		&& clientY >= scrollbarTop
		&& clientY <= box.bottom;
}
