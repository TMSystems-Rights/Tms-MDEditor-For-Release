import { describe, expect, it } from 'vitest';
import {
	createDefaultContextMenuSettings,
	moveContextMenuItem,
	normalizeContextMenuSettings,
} from './contextMenuSettings';

describe('contextMenuSettings', () => {
	it('未知IDと重複を除去し、欠落した既定項目を末尾へ補完する', () => {
		const defaults = createDefaultContextMenuSettings();
		const result   = normalizeContextMenuSettings({
			editorOrder : ['copy', 'unknown', 'copy'],
			editorHidden: ['copy', 'unknown', 'copy'],
			tabOrder    : [],
			tabHidden   : [],
		});

		expect(result.editorOrder[0]).toBe('copy');
		expect(result.editorOrder).toHaveLength(defaults.editorOrder.length);
		expect(result.editorHidden).toEqual(['copy']);
		expect(result.tabOrder).toEqual(defaults.tabOrder);
	});

	it('既定の表示メニューにアウトライン切替を含める', () => {
		const defaults = createDefaultContextMenuSettings();
		expect(defaults.editorOrder.indexOf('toggleOutline')).toBe(defaults.editorOrder.indexOf('toggleViewMode') + 1);
		expect(defaults.tabOrder.indexOf('toggleOutline')).toBe(defaults.tabOrder.indexOf('toggleViewMode') + 1);
	});

	it('項目を上下へ移動し、端では順序を維持する', () => {
		expect(moveContextMenuItem(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
		expect(moveContextMenuItem(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
		expect(moveContextMenuItem(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
	});
});
