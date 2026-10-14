import type { ViewMode } from '../types/app';

export const TABLE_MENU_ACTIONS = [
	'insertTable',
	'insertTableRowsBefore',
	'insertTableRowsAfter',
	'deleteTableRows',
	'moveTableRowsUp',
	'moveTableRowsDown',
	'insertTableColumnsBefore',
	'insertTableColumnsAfter',
	'deleteTableColumns',
	'moveTableColumnsLeft',
	'moveTableColumnsRight',
	'mergeTableCells',
	'unmergeTableCells',
	'alignTableCellLeft',
	'alignTableCellCenter',
	'alignTableCellRight',
	'valignTableCellTop',
	'valignTableCellMiddle',
	'valignTableCellBottom',
] as const;

export type TableMenuAction = typeof TABLE_MENU_ACTIONS[number];
export type TableMenuEnabledState = Record<TableMenuAction, boolean>;

export type TableMenuRuntimeContext = {
	hasView: boolean;
	viewMode: ViewMode;
	readOnly: boolean;
	inMarkdownTable: boolean;
	structure: {
		axis: 'row' | 'column';
		canDelete: boolean;
		canMovePrevious: boolean;
		canMoveNext: boolean;
	} | null;
	cells: {
		canMerge: boolean;
		canUnmerge: boolean;
	} | null;
};

/** 上部のテーブルメニューへ渡す活性状態を、右クリックと同じ操作可否から構築する。 */
export function buildTableMenuEnabledState(context: TableMenuRuntimeContext): TableMenuEnabledState {
	const editable = context.hasView && !context.readOnly && context.viewMode === 'live-preview';
	const rows     = editable && context.structure?.axis === 'row';
	const columns  = editable && context.structure?.axis === 'column';
	const cells    = editable && context.cells !== null;

	return {
		insertTable             : editable && !context.inMarkdownTable,
		insertTableRowsBefore   : rows,
		insertTableRowsAfter    : rows,
		deleteTableRows         : rows && context.structure?.canDelete === true,
		moveTableRowsUp         : rows && context.structure?.canMovePrevious === true,
		moveTableRowsDown       : rows && context.structure?.canMoveNext === true,
		insertTableColumnsBefore: columns,
		insertTableColumnsAfter : columns,
		deleteTableColumns      : columns && context.structure?.canDelete === true,
		moveTableColumnsLeft    : columns && context.structure?.canMovePrevious === true,
		moveTableColumnsRight   : columns && context.structure?.canMoveNext === true,
		mergeTableCells         : cells && context.cells?.canMerge === true,
		unmergeTableCells       : cells && context.cells?.canUnmerge === true,
		alignTableCellLeft      : cells,
		alignTableCellCenter    : cells,
		alignTableCellRight     : cells,
		valignTableCellTop      : cells,
		valignTableCellMiddle   : cells,
		valignTableCellBottom   : cells,
	};
}

/** ネイティブメニューから受け取った操作IDがテーブル操作か判定する。 */
export function isTableMenuAction(value: unknown): value is TableMenuAction {
	return typeof value === 'string' && (TABLE_MENU_ACTIONS as readonly string[]).includes(value);
}
