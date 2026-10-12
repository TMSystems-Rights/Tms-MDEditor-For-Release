export const DEFAULT_OUTLINE_WIDTH        = 300;
export const MIN_OUTLINE_WIDTH            = 180;
export const MIN_EDITOR_WIDTH             = 240;
export const OUTLINE_KEYBOARD_RESIZE_STEP = 10;

export type OutlineResizeSide = 'left' | 'right';

/**
 * ポインター位置からアウトライン幅を求め、本文の最低幅を残す。
 * @param {number} pointerClientX ポインターのX座標
 * @param {number} containerLeft ワークスペース左端
 * @param {number} containerWidth ワークスペース幅
 * @param {OutlineResizeSide} side アウトラインの配置
 * @returns {number} 調整後のアウトライン幅
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
 * アウトライン幅を操作可能な範囲へ収める。
 * @param {number} width 幅
 * @param {number} containerWidth ワークスペース幅
 * @returns {number} 調整後の幅
 */
export function clampOutlineWidth(width: number, containerWidth: number): number {
	const maxWidth = Math.max(MIN_OUTLINE_WIDTH, Math.floor(containerWidth - MIN_EDITOR_WIDTH));
	return Math.round(Math.min(maxWidth, Math.max(MIN_OUTLINE_WIDTH, width)));
}
