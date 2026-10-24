/**
 * タブの挿入位置と、最後のタブを失ったウィンドウを閉じるかを決める
 * DOM の移動とウィンドウの終了そのものは持たない
 * @file
 */

/**
 * タブ挿入位置の算出に使う画面上の横範囲
 * 上下は見ず、中央の X だけを境にする
 */
export type TabDropRect = {
	/** タブ左端のビューポート X。単位は CSS ピクセル */
	left: number;
	/** タブ右端のビューポート X。単位は CSS ピクセル */
	right: number;
};

/**
 * マウス位置から、ドラッグ元を除去した後のタブ挿入インデックスを返す
 * 各タブの中央より左ならそのタブの前、それ以外は末尾へ挿入する
 * @param tabRects - ドラッグ元を除くタブの横範囲。表示順
 * @param clientX - マウスのビューポート X
 * @returns 0 以上の挿入インデックス。タブが無いときは 0
 */
export function calculateTabDropIndex(tabRects: TabDropRect[], clientX: number): number {
	const index = tabRects.findIndex((rect) => clientX < (rect.left + rect.right) / 2);
	return index >= 0 ? index : tabRects.length;
}

/**
 * 最終タブを閉じた後にウィンドウも閉じるか判定する
 * タブ転送で空になったウィンドウは、通常の最終タブ終了設定にかかわらず閉じる
 * @param remainingTabCount - 閉じた後に残るタブ数。0 のときだけ閉じる候補になる
 * @param closeAppWhenLastTabClosed - 通常操作で最後のタブを閉じたときウィンドウも閉じる設定
 * @param transferred - 最後のタブを別ウィンドウへ転送して空になったか
 * @returns ウィンドウを閉じる場合 true
 */
export function shouldCloseWindowAfterTabRemoval(
	remainingTabCount: number,
	closeAppWhenLastTabClosed: boolean,
	transferred: boolean,
): boolean {
	return remainingTabCount === 0 && (closeAppWhenLastTabClosed || transferred);
}
