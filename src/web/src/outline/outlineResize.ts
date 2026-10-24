/**
 * アウトライン幅を、ポインター位置と本文の最低幅から決める
 * ペインの配置そのものは持たない
 * @file
 */

/** アウトラインの初期幅。単位は CSS ピクセル */
export const DEFAULT_OUTLINE_WIDTH        = 300;

/** アウトライン幅の下限。単位は CSS ピクセル */
export const MIN_OUTLINE_WIDTH            = 180;

/** リサイズ後も本文側に残す最低幅。単位は CSS ピクセル */
export const MIN_EDITOR_WIDTH             = 240;

/** キーボードで幅を変えるときの 1 ステップ。単位は CSS ピクセル */
export const OUTLINE_KEYBOARD_RESIZE_STEP = 10;

/**
 * アウトラインをワークスペースのどちらに置くか
 * 左ならポインターより左が幅、右ならポインターより右が幅になる
 */
export type OutlineResizeSide = 'left' | 'right';

/**
 * ポインター位置からアウトライン幅を求め、本文の最低幅を残す
 * 結果は `clampOutlineWidth` と同じ範囲に丸める
 * @param pointerClientX - ポインターのビューポート X
 * @param containerLeft - ワークスペース左端のビューポート X
 * @param containerWidth - ワークスペース幅。単位は CSS ピクセル
 * @param side - アウトラインの配置。左端起点か右端起点かを決める
 * @returns 下限と本文の最低幅を満たすアウトライン幅。単位は CSS ピクセル
 */
export function calculateOutlineWidth(
	pointerClientX: number,
	containerLeft: number,
	containerWidth: number,
	side: OutlineResizeSide,
): number {
	const rawWidth = side === 'left'
		? pointerClientX - containerLeft
		: containerLeft + containerWidth - pointerClientX;
	return clampOutlineWidth(rawWidth, containerWidth);
}

/**
 * アウトライン幅を操作可能な範囲へ収める
 * 下限は `MIN_OUTLINE_WIDTH`、上限は容器幅から本文の最低幅を引いた値（下限より小さくはしない）
 * @param width - 収めたい幅。単位は CSS ピクセル
 * @param containerWidth - ワークスペース幅。単位は CSS ピクセル
 * @returns 整数に丸めた幅。単位は CSS ピクセル
 */
export function clampOutlineWidth(width: number, containerWidth: number): number {
	const maxWidth = Math.max(MIN_OUTLINE_WIDTH, Math.floor(containerWidth - MIN_EDITOR_WIDTH));
	return Math.round(Math.min(maxWidth, Math.max(MIN_OUTLINE_WIDTH, width)));
}
