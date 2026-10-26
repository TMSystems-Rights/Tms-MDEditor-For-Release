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
// prettier-ignore
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
// prettier-ignore
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
// prettier-ignore
export function buildTableMenuEnabledState(context: TableMenuRuntimeContext): TableMenuEnabledState {
	// 表を編集できる状態。ビューがあり、読み取り専用でなく、ライブプレビューのときだけ true。どれか一つ欠けても false
	const editable = context.hasView && !context.readOnly && context.viewMode === 'live-preview';
	// 行の構造選択が編集可能なときだけ true。編集不可、列選択、構造選択が無い、のどれかなら false
	const rows     = editable && context.structure?.axis === 'row';
	// 列の構造選択が編集可能なときだけ true。編集不可、行選択、構造選択が無い、のどれかなら false
	const columns  = editable && context.structure?.axis === 'column';
	// セル範囲の選択が編集可能なときだけ true。選択が null、または編集不可なら false
	const cells    = editable && context.cells !== null;

	// 操作 ID ごとの活性。true だけメニューで選べる。編集できないときは全項目 false
	return {
		// 編集可能で、キャレットが表の外にあるときだけ新規の表を挿入できる。表の中、または編集不可では false。どちらか一方が欠けても false
		insertTable             : editable && !context.inMarkdownTable,
		// 選択行の前へ行を足せる。行の構造選択が編集可能でないときは false
		insertTableRowsBefore   : rows,
		// 選択行の後ろへ行を足せる。行の構造選択が編集可能でないときは false
		insertTableRowsAfter    : rows,
		// 選択行を削除できる。行選択かつ削除可のときだけ true。どちらか一方が欠けても false
		deleteTableRows         : rows && context.structure?.canDelete === true,
		// 選択行を上へ動かせる。行選択かつ前方向へ動けるときだけ true。どちらか一方が欠けても false
		moveTableRowsUp         : rows && context.structure?.canMovePrevious === true,
		// 選択行を下へ動かせる。行選択かつ次方向へ動けるときだけ true。どちらか一方が欠けても false
		moveTableRowsDown       : rows && context.structure?.canMoveNext === true,
		// 選択列の左へ列を足せる。列の構造選択が編集可能でないときは false
		insertTableColumnsBefore: columns,
		// 選択列の右へ列を足せる。列の構造選択が編集可能でないときは false
		insertTableColumnsAfter : columns,
		// 選択列を削除できる。列選択かつ削除可のときだけ true。どちらか一方が欠けても false
		deleteTableColumns      : columns && context.structure?.canDelete === true,
		// 選択列を左へ動かせる。列選択かつ前方向へ動けるときだけ true。どちらか一方が欠けても false
		moveTableColumnsLeft    : columns && context.structure?.canMovePrevious === true,
		// 選択列を右へ動かせる。列選択かつ次方向へ動けるときだけ true。どちらか一方が欠けても false
		moveTableColumnsRight   : columns && context.structure?.canMoveNext === true,
		// 選択セルを結合できる。セル選択かつ結合可のときだけ true。どちらか一方が欠けても false
		mergeTableCells         : cells && context.cells?.canMerge === true,
		// 結合を解除できる。セル選択かつ解除可のときだけ true。どちらか一方が欠けても false
		unmergeTableCells       : cells && context.cells?.canUnmerge === true,
		// セルを左寄せにできる。セル範囲があり編集可能なら true。結合できるかは見ない
		alignTableCellLeft      : cells,
		// セルを中央寄せにできる。セル範囲があり編集可能なら true。結合できるかは見ない
		alignTableCellCenter    : cells,
		// セルを右寄せにできる。セル範囲があり編集可能なら true。結合できるかは見ない
		alignTableCellRight     : cells,
		// セルの縦位置を上にできる。セル範囲があり編集可能なら true。結合できるかは見ない
		valignTableCellTop      : cells,
		// セルの縦位置を中央にできる。セル範囲があり編集可能なら true。結合できるかは見ない
		valignTableCellMiddle   : cells,
		// セルの縦位置を下にできる。セル範囲があり編集可能なら true。結合できるかは見ない
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
