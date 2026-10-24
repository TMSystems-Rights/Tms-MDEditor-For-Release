/**
 * エディタとタブの右クリックメニューの並びと非表示を正規化する
 * メニューの描画は持たず、設定オブジェクトだけを返す
 * @file
 */
import type { ContextMenuSettings } from '../types/app';

/**
 * 並びを正規化するメニューの種類
 * エディタ本文とタブで項目の集合が違う
 */
export type ContextMenuKind = 'editor' | 'tab';

/**
 * エディタ右クリックの既定順
 * 区切り線の ID も含む。実行中には変えない
 */
export const DEFAULT_EDITOR_CONTEXT_MENU_ORDER = [
	'undo',
	'redo',
	'editorSeparatorClipboard',
	'cut',
	'copy',
	'paste',
	'pastePlain',
	'selectAll',
	'editorSeparatorSearch',
	'find',
	'replace',
	'editorSeparatorContext',
	'toggleCheckbox',
	'mergeTableCells',
	'unmergeTableCells',
	'alignTableCellLeft',
	'alignTableCellCenter',
	'alignTableCellRight',
	'valignTableCellTop',
	'valignTableCellMiddle',
	'valignTableCellBottom',
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
	'openLink',
	'editorSeparatorView',
	'collapseAllHeadings',
	'expandAllHeadings',
	'toggleViewMode',
	'toggleOutline',
	'editorSeparatorSplit',
	'splitHorizontal',
	'splitVertical',
	'unsplit',
] as const;

/**
 * タブ右クリックの既定順
 * 区切り線の ID も含む。実行中には変えない
 */
export const DEFAULT_TAB_CONTEXT_MENU_ORDER = [
	'toggleViewMode',
	'toggleOutline',
	'tabSeparatorSplit',
	'splitHorizontal',
	'splitVertical',
	'unsplit',
	'tabSeparatorClose',
	'close',
	'closeOthers',
	'closeRight',
	'tabSeparatorPath',
	'copyPath',
	'showInFolder',
] as const;

/**
 * 設定画面に出す項目名
 * キーは項目 ID。未知の ID はこの表に無く、画面では ID 自体を出す側がある
 */
export const CONTEXT_MENU_ITEM_LABELS: Record<string, string> = {
	undo                    : '元に戻す',
	redo                    : 'やり直し',
	cut                     : '切り取り',
	copy                    : 'コピー',
	paste                   : '貼り付け',
	pastePlain              : 'プレーンテキストとして貼り付け',
	selectAll               : 'すべて選択',
	find                    : '検索',
	replace                 : '置換',
	toggleCheckbox          : 'チェックボックス切替',
	insertTable             : '表を挿入...',
	insertTableRowsBefore   : '選択数と同じ行を上に追加',
	insertTableRowsAfter    : '選択数と同じ行を下に追加',
	deleteTableRows         : '選択した行を削除',
	moveTableRowsUp         : '選択した行を上へ移動',
	moveTableRowsDown       : '選択した行を下へ移動',
	insertTableColumnsBefore: '選択数と同じ列を左に追加',
	insertTableColumnsAfter : '選択数と同じ列を右に追加',
	deleteTableColumns      : '選択した列を削除',
	moveTableColumnsLeft    : '選択した列を左へ移動',
	moveTableColumnsRight   : '選択した列を右へ移動',
	mergeTableCells         : 'セルを結合',
	unmergeTableCells       : '結合を解除',
	alignTableCellLeft      : '左詰め',
	alignTableCellCenter    : '中央揃え',
	alignTableCellRight     : '右詰め',
	valignTableCellTop      : '上詰め',
	valignTableCellMiddle   : '上下中央',
	valignTableCellBottom   : '下詰め',
	openLink                : 'リンクを開く',
	collapseAllHeadings     : '見出しをすべて折りたたむ',
	expandAllHeadings       : '見出しをすべて展開',
	toggleViewMode          : 'ソース / ライブプレビュー切替',
	toggleOutline           : 'アウトラインを表示 / 非表示',
	splitHorizontal         : '上下に分割',
	splitVertical           : '左右に分割',
	unsplit                 : '分割解除',
	close                   : '閉じる',
	closeOthers             : '他のタブをすべて閉じる',
	closeRight              : '右側のタブを閉じる',
	copyPath                : 'フルパスをコピー',
	showInFolder            : 'エクスプローラーで表示',
	editorSeparatorClipboard: '区切り線（編集）',
	editorSeparatorSearch   : '区切り線（検索）',
	editorSeparatorContext  : '区切り線（対象操作）',
	editorSeparatorView     : '区切り線（表示）',
	editorSeparatorSplit    : '区切り線（分割）',
	tabSeparatorSplit       : '区切り線（分割）',
	tabSeparatorClose       : '区切り線（閉じる）',
	tabSeparatorPath        : '区切り線（ファイル）',
};

/**
 * 既定のコンテキストメニュー設定を複製して返す
 * 呼び出しごとに新しい配列を作るので、戻り値を書き換えても既定は変わらない
 * @returns 非表示が空で、既定順をコピーした設定
 */
export function createDefaultContextMenuSettings(): ContextMenuSettings {
	return {
		editorOrder : [...DEFAULT_EDITOR_CONTEXT_MENU_ORDER],
		editorHidden: [],
		tabOrder    : [...DEFAULT_TAB_CONTEXT_MENU_ORDER],
		tabHidden   : [],
	};
}

/**
 * 保存済み設定の欠落、重複、未知 ID を補正する
 * 未設定の入力は既定そのものになる
 * @param settings - 保存済み設定。欠けるときは既定を使う
 * @returns 既定の項目だけを含む並びと非表示
 */
export function normalizeContextMenuSettings(settings?: ContextMenuSettings): ContextMenuSettings {
	const defaults = createDefaultContextMenuSettings();
	return {
		editorOrder : normalizeOrder(settings?.editorOrder, defaults.editorOrder),
		editorHidden: normalizeHidden(settings?.editorHidden, defaults.editorOrder),
		tabOrder    : normalizeOrder(settings?.tabOrder, defaults.tabOrder),
		tabHidden   : normalizeHidden(settings?.tabHidden, defaults.tabOrder),
	};
}

/**
 * 指定メニューの表示順を 1 件移動する
 * 端より外へは動かさず、そのときは同じ順の新しい配列を返す
 * @param order - 現在の項目 ID。この配列は書き換えない
 * @param itemId - 移動する項目。並びにあればその位置から動かす
 * @param direction - `-1` は上、`1` は下
 * @returns 移動後の順序。対象が無い、または端なら元と同じ内容
 */
export function moveContextMenuItem(order: string[], itemId: string, direction: -1 | 1): string[] {
	const currentIndex = order.indexOf(itemId);
	const targetIndex  = currentIndex + direction;
	if (currentIndex < 0 || targetIndex < 0 || targetIndex >= order.length) {
		return [...order];
	}

	const next                              = [...order];
	[next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]];
	return next;
}

/**
 * 区切り線 ID か判定する
 * ID に `Separator` を含むものを区切り線とする
 * @param itemId - メニュー項目 ID
 * @returns 区切り線なら true
 */
export function isContextMenuSeparator(itemId: string): boolean {
	return itemId.includes('Separator');
}

/**
 * 保存済み順序から未知と重複を除き、足りない既定項目を既定位置へ補う
 * 入力が無いときは既定順のコピーを返す
 * @param source - 保存されていた順序。未設定は空として扱う
 * @param defaults - そのメニューの既定順。許可する ID の全体
 * @returns 既定の ID を過不足なく並べた配列
 */
function normalizeOrder(source: string[] | undefined, defaults: string[]): string[] {
	const allowed          = new Set(defaults);
	const seen             = new Set<string>();
	const result: string[] = [];

	(source ?? []).forEach((itemId) => {
		if (allowed.has(itemId) && !seen.has(itemId)) {
			seen.add(itemId);
			result.push(itemId);
		}
	});

	defaults.forEach((itemId) => {
		if (!seen.has(itemId)) {
			seen.add(itemId);
			insertMissingContextMenuItem(result, itemId);
		}
	});

	return placeContextMenuItemAfter(
		placeContextMenuItemAfter(
			placeContextMenuItemAfter(
				placeContextMenuItemAfter(
					placeContextMenuItemAfter(
						placeContextMenuItemAfter(
							placeContextMenuItemAfter(
								placeContextMenuItemAfter(
									placeContextMenuItemAfter(result, 'pastePlain', 'paste', defaults),
									'mergeTableCells',
									'toggleCheckbox',
									defaults,
								),
								'unmergeTableCells',
								'mergeTableCells',
								defaults,
							),
							'alignTableCellLeft',
							'unmergeTableCells',
							defaults,
						),
						'alignTableCellCenter',
						'alignTableCellLeft',
						defaults,
					),
					'alignTableCellRight',
					'alignTableCellCenter',
					defaults,
				),
				'valignTableCellTop',
				'alignTableCellRight',
				defaults,
			),
			'valignTableCellMiddle',
			'valignTableCellTop',
			defaults,
		),
		'valignTableCellBottom',
		'valignTableCellMiddle',
		defaults,
	);
}

/**
 * 欠落した既定項目を、関連項目の直後へ挿入する
 * 位置が決まらない項目は末尾へ足す。`result` を直接書き換える
 * @param result - 構築中の順序。この配列へ挿入する
 * @param itemId - 追加する既定項目
 */
function insertMissingContextMenuItem(result: string[], itemId: string): void {
	if (itemId === 'pastePlain') {
		const pasteIndex = result.indexOf('paste');
		if (pasteIndex >= 0) {
			result.splice(pasteIndex + 1, 0, itemId);
			return;
		}
	}

	const tableAfter: Record<string, string> = {
		insertTable             : 'valignTableCellBottom',
		insertTableRowsBefore   : 'insertTable',
		insertTableRowsAfter    : 'insertTableRowsBefore',
		deleteTableRows         : 'insertTableRowsAfter',
		moveTableRowsUp         : 'deleteTableRows',
		moveTableRowsDown       : 'moveTableRowsUp',
		insertTableColumnsBefore: 'moveTableRowsDown',
		insertTableColumnsAfter : 'insertTableColumnsBefore',
		deleteTableColumns      : 'insertTableColumnsAfter',
		moveTableColumnsLeft    : 'deleteTableColumns',
		moveTableColumnsRight   : 'moveTableColumnsLeft',
	};
	const tableAfterId                       = tableAfter[itemId];
	if (tableAfterId) {
		const tableIndex = result.indexOf(tableAfterId);
		if (tableIndex >= 0) {
			result.splice(tableIndex + 1, 0, itemId);
			return;
		}
	}

	if (itemId === 'mergeTableCells') {
		const checkboxIndex = result.indexOf('toggleCheckbox');
		if (checkboxIndex >= 0) {
			result.splice(checkboxIndex + 1, 0, itemId);
			return;
		}
	}

	if (itemId === 'unmergeTableCells') {
		const mergeIndex = result.indexOf('mergeTableCells');
		if (mergeIndex >= 0) {
			result.splice(mergeIndex + 1, 0, itemId);
			return;
		}
	}

	const headingAfter: Record<string, string> = {
		collapseAllHeadings: 'editorSeparatorView',
		expandAllHeadings  : 'collapseAllHeadings',
	};
	const headingAfterId                       = headingAfter[itemId];
	if (headingAfterId) {
		const headingIndex = result.indexOf(headingAfterId);
		if (headingIndex >= 0) {
			result.splice(headingIndex + 1, 0, itemId);
			return;
		}
	}

	const alignAfter: Record<string, string> = {
		alignTableCellLeft   : 'unmergeTableCells',
		alignTableCellCenter : 'alignTableCellLeft',
		alignTableCellRight  : 'alignTableCellCenter',
		valignTableCellTop   : 'alignTableCellRight',
		valignTableCellMiddle: 'valignTableCellTop',
		valignTableCellBottom: 'valignTableCellMiddle',
	};

	const afterId = alignAfter[itemId];
	if (afterId) {
		const afterIndex = result.indexOf(afterId);
		if (afterIndex >= 0) {
			result.splice(afterIndex + 1, 0, itemId);
			return;
		}
	}

	result.push(itemId);
}

/**
 * 保存順が既定と、移動項目を除いて一致するときだけ、その項目を基準の次へ移す
 * ユーザーが並びを変えているときは何もしない
 * @param order - 現在の順序
 * @param itemId - 既定位置へ戻す候補
 * @param afterId - 直前に置く項目
 * @param defaults - 既定順。カスタム順かどうかの比較に使う
 * @returns 補正後の順序。動かさないときは同じ配列
 */
function placeContextMenuItemAfter(
	order: string[],
	itemId: string,
	afterId: string,
	defaults: string[],
): string[] {
	const itemIndex  = order.indexOf(itemId);
	const afterIndex = order.indexOf(afterId);
	if (itemIndex < 0 || afterIndex < 0 || itemIndex === afterIndex + 1) {
		return order;
	}

	const withoutItem    = order.filter((id) => id !== itemId);
	const defaultWithout = defaults.filter((id) => id !== itemId);
	if (withoutItem.length !== defaultWithout.length
		|| withoutItem.some((id, index) => id !== defaultWithout[index])) {
		return order;
	}

	const next = [...withoutItem];
	next.splice(next.indexOf(afterId) + 1, 0, itemId);
	return next;
}

/**
 * 非表示設定を、いま使える項目だけへ絞り、重複を除く
 * 未知 ID は捨てる
 * @param source - 保存されていた非表示 ID。未設定は空
 * @param defaults - 許可する項目 ID
 * @returns 有効な非表示 ID。重複は 1 つ
 */
function normalizeHidden(source: string[] | undefined, defaults: string[]): string[] {
	const allowed = new Set(defaults);
	return [...new Set((source ?? []).filter((itemId) => allowed.has(itemId)))];
}
