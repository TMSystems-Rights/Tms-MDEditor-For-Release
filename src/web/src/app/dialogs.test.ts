import { describe, expect, it } from 'vitest';
import { calculateContextMenuPosition, compactContextMenuEntries } from './dialogs';

describe('calculateContextMenuPosition', () => {
	it('places the menu below the anchor when it fits', () => {
		expect(calculateContextMenuPosition(
			{ left: 20, right: 80, top: 100, bottom: 124 },
			{ width: 220, height: 120 },
			{ width: 800, height: 600 }
		)).toEqual({ left: 20, top: 128 });
	});

	it('places the menu above the anchor when the bottom side would overflow', () => {
		expect(calculateContextMenuPosition(
			{ left: 20, right: 80, top: 560, bottom: 584 },
			{ width: 220, height: 120 },
			{ width: 800, height: 600 }
		)).toEqual({ left: 20, top: 436 });
	});

	it('keeps the menu inside the right edge of the viewport', () => {
		expect(calculateContextMenuPosition(
			{ left: 700, right: 760, top: 100, bottom: 124 },
			{ width: 220, height: 120 },
			{ width: 800, height: 600 }
		)).toEqual({ left: 576, top: 128 });
	});
});

describe('compactContextMenuEntries', () => {
	it('removes hidden items and redundant separators', () => {
		expect(compactContextMenuEntries([
			{ id: 'leading', separator: true },
			{ id: 'copy', label: 'コピー' },
			{ id: 'hidden', label: '非表示', hidden: true },
			{ id: 'separator1', separator: true },
			{ id: 'separator2', separator: true },
			{ id: 'paste', label: '貼り付け' },
			{ id: 'trailing', separator: true },
		]).map((item) => item.id)).toEqual(['copy', 'separator1', 'paste']);
	});
});
