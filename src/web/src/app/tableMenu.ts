/**
 * 上部テーブルメニューの活性を、右クリックと同じ操作可否から決める
 * メニューの描画と表の書き換えは持たない
 * @file
 */
import type { ViewMode } from '../types/app';

/**
 * ネイティブのテーブルメニューが送る操作 ID
 * 並びはメニュー側の対応表であり、実行中には変えない
 */
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

/** `TABLE_MENU_ACTIONS` のいずれか。未知の文字列はメニュー操作として扱わない */
export type TableMenuAction = typeof TABLE_MENU_ACTIONS[number];

/** 各テーブル操作を有効にするか。キーは操作 ID、値 true が選択可能 */
export type TableMenuEnabledState = Record<TableMenuAction, boolean>;

/**
 * テーブルメニューの活性を決める、その時点の編集位置
 * メニューを開くたびに作り、保持しない
 */
export type TableMenuRuntimeContext = {
	/** エディタビューがあるか。無いときは全操作を無効にする */
	hasView: boolean;
	/** アクティブタブの表示モード。ライブプレビュー以外は編集操作を出さない */
	viewMode: ViewMode;
	/** 読み取り専用か。true のときは全操作を無効にする */
	readOnly: boolean;
	/** キャレットが Markdown の表の中にあるか。表の外では新規挿入だけを検討する */
	inMarkdownTable: boolean;
	/**
	 * 行または列をまとめて選んでいるときの可否
	 * 構造選択が無いときは null
	 */
	structure: {
		/** 操作対象。`row` は行、`column` は列 */
		axis: 'row' | 'column';
		/** 対象の行または列を削除できるか */
		canDelete: boolean;
		/** 前方向（上または左）へ移動できるか */
		canMovePrevious: boolean;
		/** 次方向（下または右）へ移動できるか */
		canMoveNext: boolean;
	} | null;
	/**
	 * セル範囲を選んでいるときの結合可否
	 * セル選択が無いときは null。配置の変更は選択があるだけで有効にする
	 */
	cells: {
		/** 選択セルを結合できるか */
		canMerge: boolean;
		/** 結合を解除できるか */
		canUnmerge: boolean;
	} | null;
};

/**
 * 上部のテーブルメニューへ渡す活性状態を、右クリックと同じ操作可否から構築する
 * 編集可能なライブプレビュー以外では全項目を無効にする
 * @param context - 現在のビューと表選択。呼び出しのたびに評価し、保持しない
 * @returns 操作 ID ごとの活性。true がその項目を選べる
 */
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

/**
 * ネイティブメニューから受け取った操作 ID がテーブル操作か判定する
 * 文字列でない値と未知の ID は false
 * @param value - メニューが渡した値。型は実行時まで分からない
 * @returns テーブル操作なら true。そのとき `value` は `TableMenuAction` に狭まる
 */
export function isTableMenuAction(value: unknown): value is TableMenuAction {
	return typeof value === 'string' && (TABLE_MENU_ACTIONS as readonly string[]).includes(value);
}
