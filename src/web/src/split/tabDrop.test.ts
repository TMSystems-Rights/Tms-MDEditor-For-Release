/**
 * ペイン上のドロップ座標が、分割方向と新しいペインの位置になることを検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { calculatePaneDropPlacement } from './tabDrop';

describe('calculatePaneDropPlacement', () => {
	/** ドロップ判定の基準にするペイン矩形。座標はビューポート上の px */
	const rect = { left: 100, top: 50, width: 400, height: 300 };

	it.each([
		[110, 200, 'left', 'vertical', 'first'],
		[490, 200, 'right', 'vertical', 'second'],
		[300, 55, 'top', 'horizontal', 'first'],
		[300, 345, 'bottom', 'horizontal', 'second'],
	] as const)('座標(%s, %s)を%s分割として解決する', (clientX, clientY, zone, direction, newPanePosition) => {
		expect(calculatePaneDropPlacement(rect, clientX, clientY)).toEqual({ zone, direction, newPanePosition });
	});
});
