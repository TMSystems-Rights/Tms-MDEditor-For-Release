/**
 * ペイン上のドロップ座標から、新しい分割の向きと前後を決める
 * DOM の更新は持たない
 * @file
 */
import type { NewPanePosition } from './paneLayout';
import type { SplitDirection } from './splitView';

/** ドロップ位置に最も近いペインの辺 */
export type PaneDropZone = 'left' | 'right' | 'top' | 'bottom';

/**
 * ドロップから作る分割の配置
 * 計算のたびに作り、ドラッグ中の状態は持たない
 */
export type PaneDropPlacement = {
	/** 最も近い辺 */
	zone: PaneDropZone;
	/** 左右なら縦分割、上下なら横分割 */
	direction: SplitDirection;
	/** 新しいペインを既存ペインの前に置くか後ろに置くか */
	newPanePosition: NewPanePosition;
};

/**
 * 位置計算に使う矩形
 * DOM の `DOMRect` 全体は要らず、左上と幅高さだけを見る
 */
type RectLike = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

/**
 * ペイン内のドロップ位置に最も近い辺から分割方向を決定する
 * 幅や高さが 0 以下のときは、その軸の中央（0.5）として比較する
 * @param rect - ドロップ先ペインの画面矩形。単位は CSS ピクセル
 * @param clientX - マウスのビューポート X。ペインの左を 0 として正規化する
 * @param clientY - マウスのビューポート Y。ペインの上を 0 として正規化する
 * @returns 最も近い辺と、そこから決まる分割方向・新ペインの前後
 */
export function calculatePaneDropPlacement(rect: RectLike, clientX: number, clientY: number): PaneDropPlacement {
	// 幅・高さが異なるペインでも4辺を同じ尺度で比較できるよう0〜1へ正規化し、最も近い辺を採用する
	// 幅に対する横位置。幅が 0 以下のときは中央の 0.5。はみ出しは 0〜1 に切る
	const normalizedX                              = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0.5;
	// 高さに対する縦位置。高さが 0 以下のときは中央の 0.5
	const normalizedY                              = rect.height > 0 ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0.5;
	// 4 辺までの距離。小さい辺ほどドロップ位置に近い。単位は正規化後の割合
	const distances: Array<[PaneDropZone, number]> = [
		['left', normalizedX],
		['right', 1 - normalizedX],
		['top', normalizedY],
		['bottom', 1 - normalizedY]
	];
	// 距離が最小の辺。同じ距離のときは left から順に先へ残った方
	const zone                                     = distances.reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest))[0];

	// このドロップで作る分割。最も近い辺から向きと前後を決める
	return {
		// 採用した辺。left、right、top、bottom のいずれか
		zone,
		// 左右の辺なら縦分割、上下なら横分割
		direction: zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal',
		// 左または上なら既存ペインの前。右または下なら後ろ
		newPanePosition: zone === 'left' || zone === 'top' ? 'first' : 'second'
	};
}
