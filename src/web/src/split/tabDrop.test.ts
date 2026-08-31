import { describe, expect, it } from 'vitest';
import { calculatePaneDropPlacement } from './tabDrop';

describe('calculatePaneDropPlacement', () => {
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
