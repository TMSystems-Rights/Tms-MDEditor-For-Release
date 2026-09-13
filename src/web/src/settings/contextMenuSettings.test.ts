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

	it('既定のエディタメニューにプレーンテキスト貼り付けを含める', () => {
		const defaults = createDefaultContextMenuSettings();
		expect(defaults.editorOrder.indexOf('pastePlain')).toBe(defaults.editorOrder.indexOf('paste') + 1);
	});

	it('欠落したプレーンテキスト貼り付けを貼り付けの次へ補完する', () => {
		const defaults = createDefaultContextMenuSettings();
		const result   = normalizeContextMenuSettings({
			editorOrder : defaults.editorOrder.filter((itemId) => itemId !== 'pastePlain'),
			editorHidden: [],
			tabOrder    : [],
			tabHidden   : [],
		});

		expect(result.editorOrder.indexOf('pastePlain')).toBe(result.editorOrder.indexOf('paste') + 1);
	});

	it('既定順の末尾へ付いたプレーンテキスト貼り付けを貼り付けの次へ移す', () => {
		const defaults = createDefaultContextMenuSettings();
		const result   = normalizeContextMenuSettings({
			editorOrder : [...defaults.editorOrder.filter((itemId) => itemId !== 'pastePlain'), 'pastePlain'],
			editorHidden: [],
			tabOrder    : [],
			tabHidden   : [],
		});

		expect(result.editorOrder.indexOf('pastePlain')).toBe(result.editorOrder.indexOf('paste') + 1);
		expect(result.editorOrder).toEqual(defaults.editorOrder);
	});

	it('独自順のプレーンテキスト貼り付け位置は維持する', () => {
		const result = normalizeContextMenuSettings({
			editorOrder : ['copy', 'paste', 'selectAll', 'pastePlain'],
			editorHidden: [],
			tabOrder    : [],
			tabHidden   : [],
		});

		expect(result.editorOrder.indexOf('pastePlain')).toBe(result.editorOrder.indexOf('selectAll') + 1);
	});

	it('既定のエディタメニューに表セル結合を含める', () => {
		const defaults = createDefaultContextMenuSettings();
		expect(defaults.editorOrder.indexOf('mergeTableCells')).toBe(
			defaults.editorOrder.indexOf('toggleCheckbox') + 1,
		);
		expect(defaults.editorOrder.indexOf('unmergeTableCells')).toBe(
			defaults.editorOrder.indexOf('mergeTableCells') + 1,
		);
		expect(defaults.editorOrder.indexOf('alignTableCellLeft')).toBe(
			defaults.editorOrder.indexOf('unmergeTableCells') + 1,
		);
		expect(defaults.editorOrder.indexOf('valignTableCellBottom')).toBe(
			defaults.editorOrder.indexOf('valignTableCellMiddle') + 1,
		);
	});

	it('欠落した表セル結合をチェックボックスの次へ補完する', () => {
		const defaults = createDefaultContextMenuSettings();
		const result   = normalizeContextMenuSettings({
			editorOrder : defaults.editorOrder.filter(
				(itemId) => itemId !== 'mergeTableCells' && itemId !== 'unmergeTableCells',
			),
			editorHidden: [],
			tabOrder    : [],
			tabHidden   : [],
		});

		expect(result.editorOrder.indexOf('mergeTableCells')).toBe(
			result.editorOrder.indexOf('toggleCheckbox') + 1,
		);
		expect(result.editorOrder.indexOf('unmergeTableCells')).toBe(
			result.editorOrder.indexOf('mergeTableCells') + 1,
		);
	});

	it('欠落した表セル配置を結合解除の次へ補完する', () => {
		const defaults = createDefaultContextMenuSettings();
		const result   = normalizeContextMenuSettings({
			editorOrder : defaults.editorOrder.filter(
				(itemId) => !itemId.startsWith('alignTableCell') && !itemId.startsWith('valignTableCell'),
			),
			editorHidden: [],
			tabOrder    : [],
			tabHidden   : [],
		});

		expect(result.editorOrder.indexOf('alignTableCellLeft')).toBe(
			result.editorOrder.indexOf('unmergeTableCells') + 1,
		);
		expect(result.editorOrder.slice(
			result.editorOrder.indexOf('alignTableCellLeft'),
			result.editorOrder.indexOf('valignTableCellBottom') + 1,
		)).toEqual([
			'alignTableCellLeft',
			'alignTableCellCenter',
			'alignTableCellRight',
			'valignTableCellTop',
			'valignTableCellMiddle',
			'valignTableCellBottom',
		]);
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
