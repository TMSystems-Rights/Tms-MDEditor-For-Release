/**
 * 表メニューの有効状態が、カーソル位置と編集可否で変わることを検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { buildTableMenuEnabledState, type TableMenuRuntimeContext } from './tableMenu';

/** 表の外にいるライブプレビューのカーソル。各テストが必要な項目だけ上書きする */
const base: TableMenuRuntimeContext = {
	hasView       : true,
	viewMode      : 'live-preview',
	readOnly      : false,
	inMarkdownTable: false,
	structure     : null,
	cells         : null,
};

describe('buildTableMenuEnabledState', () => {
	it('表外のライブプレビューでは新規表だけを有効にする', () => {
		const state = buildTableMenuEnabledState(base);
		expect(state.insertTable).toBe(true);
		expect(state.insertTableRowsBefore).toBe(false);
		expect(state.alignTableCellLeft).toBe(false);
	});

	it('選択行の境界条件を行メニューへ反映する', () => {
		const state = buildTableMenuEnabledState({
			...base,
			inMarkdownTable: true,
			structure: {
				axis            : 'row',
				canDelete       : true,
				canMovePrevious : false,
				canMoveNext     : true,
			},
		});
		expect(state.insertTable).toBe(false);
		expect(state.insertTableRowsBefore).toBe(true);
		expect(state.deleteTableRows).toBe(true);
		expect(state.moveTableRowsUp).toBe(false);
		expect(state.moveTableRowsDown).toBe(true);
		expect(state.insertTableColumnsBefore).toBe(false);
	});

	it('セル範囲では配置と可能な結合操作を有効にする', () => {
		const state = buildTableMenuEnabledState({
			...base,
			inMarkdownTable: true,
			cells: { canMerge: true, canUnmerge: false },
		});
		expect(state.mergeTableCells).toBe(true);
		expect(state.unmergeTableCells).toBe(false);
		expect(state.alignTableCellCenter).toBe(true);
		expect(state.valignTableCellBottom).toBe(true);
	});

	it.each([
		{ viewMode: 'source' as const, readOnly: false },
		{ viewMode: 'live-preview' as const, readOnly: true },
	])('編集不能時は全項目を無効にする: $viewMode readOnly=$readOnly', ({ viewMode, readOnly }) => {
		const state = buildTableMenuEnabledState({
			...base,
			viewMode,
			readOnly,
			structure: { axis: 'column', canDelete: true, canMovePrevious: true, canMoveNext: true },
			cells    : { canMerge: true, canUnmerge: true },
		});
		expect(Object.values(state).every((enabled) => !enabled)).toBe(true);
	});
});
