import type { NewPanePosition } from './paneLayout';
import type { SplitDirection } from './splitView';

export type PaneDropZone = 'left' | 'right' | 'top' | 'bottom';

export type PaneDropPlacement = {
	zone: PaneDropZone;
	direction: SplitDirection;
	newPanePosition: NewPanePosition;
};

type RectLike = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

/** ペイン内のドロップ位置に最も近い辺から分割方向を決定する */
export function calculatePaneDropPlacement(rect: RectLike, clientX: number, clientY: number): PaneDropPlacement {
	// 幅・高さが異なるペインでも4辺を同じ尺度で比較できるよう0〜1へ正規化し、最も近い辺を採用する。
	const normalizedX                              = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0.5;
	const normalizedY                              = rect.height > 0 ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0.5;
	const distances: Array<[PaneDropZone, number]> = [
		['left', normalizedX],
		['right', 1 - normalizedX],
		['top', normalizedY],
		['bottom', 1 - normalizedY],
	];
	const zone                                     = distances.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest)[0];

	return {
		zone,
		direction: zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal',
		newPanePosition: zone === 'left' || zone === 'top' ? 'first' : 'second',
	};
}
