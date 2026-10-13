/** タブ挿入位置の算出に使う画面上の横範囲。 */
export type TabDropRect = {
	left: number;
	right: number;
};

/**
 * マウス位置から、ドラッグ元を除去した後のタブ挿入インデックスを返す。
 * 各タブの中央より左ならそのタブの前、それ以外は末尾へ挿入する。
 * @param {TabDropRect[]} tabRects ドラッグ元を除くタブの横範囲
 * @param {number} clientX マウスのクライアントX座標
 * @returns {number} 挿入インデックス
 */
export function calculateTabDropIndex(tabRects: TabDropRect[], clientX: number): number {
	const index = tabRects.findIndex((rect) => clientX < (rect.left + rect.right) / 2);
	return index >= 0 ? index : tabRects.length;
}

/**
 * 最終タブを閉じた後にウィンドウも閉じるか判定する。
 * タブ転送で空になったウィンドウは、通常の最終タブ終了設定にかかわらず閉じる。
 * @param {number} remainingTabCount 残りのタブ数
 * @param {boolean} closeAppWhenLastTabClosed 通常の最終タブ終了設定
 * @param {boolean} transferred 最終タブを別ウィンドウへ転送したか
 * @returns {boolean} ウィンドウを閉じる場合true
 */
export function shouldCloseWindowAfterTabRemoval(
	remainingTabCount: number,
	closeAppWhenLastTabClosed: boolean,
	transferred: boolean,
): boolean {
	return remainingTabCount === 0 && (closeAppWhenLastTabClosed || transferred);
}
