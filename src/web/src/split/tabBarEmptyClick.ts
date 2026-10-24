/**
 * タブバー空白のダブルクリックで無題タブを開くか、横スクロールバー上かを判定する
 * タブの生成は持たない
 * @file
 */

/**
 * タブバー上のダブルクリックが何に当たったか
 * いずれかが true のときは無題タブを開かない
 */
export type TabBarDoubleClickHit = {
	/** 既存タブの上か */
	onTab: boolean;
	/** 新規タブボタンの上か */
	onNewTabButton: boolean;
	/** 横スクロールバーの上か */
	inHorizontalScrollbar: boolean;
};

/**
 * 横スクロールバーの当たり判定に使う矩形
 * `clientHeight` より下かつ `bottom` までの帯をバーとみなす
 */
export type HorizontalScrollbarBoxLike = {
	/** 容器左端のビューポート X */
	left: number;
	/** 容器右端のビューポート X */
	right: number;
	/** 容器上端のビューポート Y */
	top: number;
	/** 容器下端のビューポート Y。バーはこの値まで */
	bottom: number;
	/** 内容の可視高さ。これを足した位置から下をバーとみなす */
	clientHeight: number;
};

/**
 * タブバー空白のダブルクリックで無題タブを開くべきか判定する
 * タブ、新規ボタン、横スクロールバーのいずれかに当たっていれば開かない
 * @param hit - クリック位置の当たり。すべて false のときだけ開く
 * @returns 無題タブを開く場合 true
 */
export function shouldOpenUntitledTabOnTabBarDoubleClick(hit: TabBarDoubleClickHit): boolean {
	return !hit.onTab && !hit.onNewTabButton && !hit.inHorizontalScrollbar;
}

/**
 * 点が横スクロールバー領域にあるか判定する
 * バーの帯が 0.5px 未満なら、バーは無いものとして false
 * @param box - スクロール容器の矩形と可視高さ
 * @param clientX - 判定するビューポート X
 * @param clientY - 判定するビューポート Y
 * @returns 横スクロールバー上なら true
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
