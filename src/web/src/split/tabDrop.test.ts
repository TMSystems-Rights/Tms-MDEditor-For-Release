/**
 * ペイン上のドロップ座標が、分割方向と新しいペインの位置になることを検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { calculatePaneDropPlacement } from './tabDrop';

describe('calculatePaneDropPlacement', () => {
	// ドロップ判定の基準にするペイン矩形。座標はビューポート上の px
	const rect = {
		// ペイン左端。ビューポート左からの px
		left: 100,
		// ペイン上端。ビューポート上からの px
		top: 50,
		// ペイン幅。px。左右の辺を同じ尺度で比べる分母
		width: 400,
		// ペイン高さ。px。上下の辺を同じ尺度で比べる分母
		height: 300
	};

	it.each([
		[110, 200, 'left', 'vertical', 'first'],
		[490, 200, 'right', 'vertical', 'second'],
		[300, 55, 'top', 'horizontal', 'first'],
		[300, 345, 'bottom', 'horizontal', 'second']
	] as const)('座標(%s, %s)を%s分割として解決する', (clientX, clientY, zone, direction, newPanePosition) => {
		expect(calculatePaneDropPlacement(rect, clientX, clientY)).toEqual({
			// 最も近い辺。left、right、top、bottom のいずれか
			zone,
			// その辺が決める分割。左右は vertical、上下は horizontal
			direction,
			// 新しいペインを既存の前に置くか後ろに置くか
			newPanePosition
		});
	});
});
