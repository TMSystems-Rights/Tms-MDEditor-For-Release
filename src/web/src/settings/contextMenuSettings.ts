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
export const DEFAULT_EDITOR_CONTEXT_MENU_ORDER = ['undo', 'redo', 'editorSeparatorClipboard', 'cut', 'copy', 'paste', 'pastePlain', 'selectAll', 'editorSeparatorSearch', 'find', 'replace', 'editorSeparatorContext', 'toggleCheckbox', 'mergeTableCells', 'unmergeTableCells', 'alignTableCellLeft', 'alignTableCellCenter', 'alignTableCellRight', 'valignTableCellTop', 'valignTableCellMiddle', 'valignTableCellBottom', 'insertTable', 'insertTableRowsBefore', 'insertTableRowsAfter', 'deleteTableRows', 'moveTableRowsUp', 'moveTableRowsDown', 'insertTableColumnsBefore', 'insertTableColumnsAfter', 'deleteTableColumns', 'moveTableColumnsLeft', 'moveTableColumnsRight', 'openLink', 'editorSeparatorView', 'collapseAllHeadings', 'expandAllHeadings', 'toggleViewMode', 'toggleOutline', 'editorSeparatorSplit', 'splitHorizontal', 'splitVertical', 'unsplit'] as const;

/**
 * タブ右クリックの既定順
 * 区切り線の ID も含む。実行中には変えない
 */
export const DEFAULT_TAB_CONTEXT_MENU_ORDER = ['toggleViewMode', 'toggleOutline', 'tabSeparatorSplit', 'splitHorizontal', 'splitVertical', 'unsplit', 'tabSeparatorClose', 'close', 'closeOthers', 'closeRight', 'tabSeparatorPath', 'copyPath', 'showInFolder'] as const;

/**
 * 設定画面に出す項目名
 * キーは項目 ID。未知の ID はこの表に無く、画面では ID 自体を出す側がある
 */
export const CONTEXT_MENU_ITEM_LABELS: Record<string, string> = {
	// 編集を一段戻す
	undo: '元に戻す',
	// 戻した編集をやり直す
	redo: 'やり直し',
	// 選択を切り取る
	cut: '切り取り',
	// 選択をコピーする
	copy: 'コピー',
	// クリップボードを貼り付ける
	paste: '貼り付け',
	// 書式を捨てて貼り付ける
	pastePlain: 'プレーンテキストとして貼り付け',
	// 文書全体を選択する
	selectAll: 'すべて選択',
	// 検索パネルを開く
	find: '検索',
	// 置換パネルを開く
	replace: '置換',
	// カーソル行のチェックを反転する
	toggleCheckbox: 'チェックボックス切替',
	// 表を新しく挿入する
	insertTable: '表を挿入...',
	// 選択行数と同じ行を上へ足す
	insertTableRowsBefore: '選択数と同じ行を上に追加',
	// 選択行数と同じ行を下へ足す
	insertTableRowsAfter: '選択数と同じ行を下に追加',
	// 選択した行を消す
	deleteTableRows: '選択した行を削除',
	// 選択した行を上へ動かす
	moveTableRowsUp: '選択した行を上へ移動',
	// 選択した行を下へ動かす
	moveTableRowsDown: '選択した行を下へ移動',
	// 選択列数と同じ列を左へ足す
	insertTableColumnsBefore: '選択数と同じ列を左に追加',
	// 選択列数と同じ列を右へ足す
	insertTableColumnsAfter: '選択数と同じ列を右に追加',
	// 選択した列を消す
	deleteTableColumns: '選択した列を削除',
	// 選択した列を左へ動かす
	moveTableColumnsLeft: '選択した列を左へ移動',
	// 選択した列を右へ動かす
	moveTableColumnsRight: '選択した列を右へ移動',
	// 選択セルを一つにまとめる
	mergeTableCells: 'セルを結合',
	// 結合したセルを分け直す
	unmergeTableCells: '結合を解除',
	// セル内の文字を左へ寄せる
	alignTableCellLeft: '左詰め',
	// セル内の文字を中央へ寄せる
	alignTableCellCenter: '中央揃え',
	// セル内の文字を右へ寄せる
	alignTableCellRight: '右詰め',
	// セル内の文字を上へ寄せる
	valignTableCellTop: '上詰め',
	// セル内の文字を上下の中央へ寄せる
	valignTableCellMiddle: '上下中央',
	// セル内の文字を下へ寄せる
	valignTableCellBottom: '下詰め',
	// カーソル位置のリンクを開く
	openLink: 'リンクを開く',
	// 見出しをすべて閉じる
	collapseAllHeadings: '見出しをすべて折りたたむ',
	// 折りたたんだ見出しをすべて開く
	expandAllHeadings: '見出しをすべて展開',
	// ソース表示とライブプレビューを切り替える
	toggleViewMode: 'ソース / ライブプレビュー切替',
	// アウトラインパネルの表示を切り替える
	toggleOutline: 'アウトラインを表示 / 非表示',
	// ペインを上下に分ける
	splitHorizontal: '上下に分割',
	// ペインを左右に分ける
	splitVertical: '左右に分割',
	// 分割をやめて一つに戻す
	unsplit: '分割解除',
	// このタブを閉じる
	close: '閉じる',
	// このタブ以外を閉じる
	closeOthers: '他のタブをすべて閉じる',
	// このタブより右を閉じる
	closeRight: '右側のタブを閉じる',
	// ファイルのフルパスをコピーする
	copyPath: 'フルパスをコピー',
	// ファイルの場所をエクスプローラーで開く
	showInFolder: 'エクスプローラーで表示',
	// 編集操作の前に置く区切り。コマンドではない
	editorSeparatorClipboard: '区切り線（編集）',
	// 検索操作の前に置く区切り。コマンドではない
	editorSeparatorSearch: '区切り線（検索）',
	// 対象操作の前に置く区切り。コマンドではない
	editorSeparatorContext: '区切り線（対象操作）',
	// 表示操作の前に置く区切り。コマンドではない
	editorSeparatorView: '区切り線（表示）',
	// エディタメニューで分割の前に置く区切り。コマンドではない
	editorSeparatorSplit: '区切り線（分割）',
	// タブメニューで分割の前に置く区切り。コマンドではない
	tabSeparatorSplit: '区切り線（分割）',
	// タブを閉じる操作の前に置く区切り。コマンドではない
	tabSeparatorClose: '区切り線（閉じる）',
	// パス操作の前に置く区切り。コマンドではない
	tabSeparatorPath: '区切り線（ファイル）'
};

/**
 * 既定のコンテキストメニュー設定を複製して返す
 * 呼び出しごとに新しい配列を作るので、戻り値を書き換えても既定は変わらない
 * @returns 非表示が空で、既定順をコピーした設定
 */
export function createDefaultContextMenuSettings(): ContextMenuSettings {
	// 呼び出しごとに新しい配列を持つ既定。戻り値を書き換えても定数は変わらない
	return {
		// エディタメニューの既定順。区切り線 ID を含む
		editorOrder: [...DEFAULT_EDITOR_CONTEXT_MENU_ORDER],
		// 非表示は無し。空配列
		editorHidden: [],
		// タブメニューの既定順。区切り線 ID を含む
		tabOrder: [...DEFAULT_TAB_CONTEXT_MENU_ORDER],
		// 非表示は無し。空配列
		tabHidden: []
	};
}

/**
 * 保存済み設定の欠落、重複、未知 ID を補正する
 * 未設定の入力は既定そのものになる
 * @param settings - 保存済み設定。欠けるときは既定を使う
 * @returns 既定の項目だけを含む並びと非表示
 */
export function normalizeContextMenuSettings(settings?: ContextMenuSettings): ContextMenuSettings {
	// 欠落を埋める既定。この呼び出し専用の配列
	const defaults = createDefaultContextMenuSettings();
	// 未知 ID を除いた並びと非表示
	return {
		// エディタの表示順。未設定は既定順
		editorOrder: normalizeOrder(settings?.editorOrder, defaults.editorOrder),
		// エディタの非表示。未知 ID は捨てる
		editorHidden: normalizeHidden(settings?.editorHidden, defaults.editorOrder),
		// タブの表示順。未設定は既定順
		tabOrder: normalizeOrder(settings?.tabOrder, defaults.tabOrder),
		// タブの非表示。未知 ID は捨てる
		tabHidden: normalizeHidden(settings?.tabHidden, defaults.tabOrder)
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
	// 移動する項目の位置。並びにあれば 0 以上、無ければ -1
	const currentIndex = order.indexOf(itemId);
	// 移動先。-1 は上、1 は下。端の外は負または長さ以上
	const targetIndex  = currentIndex + direction;
	// 対象が無い、上端より上、または下端より下。どれか一つでも順は変えない
	if (currentIndex < 0 || targetIndex < 0 || targetIndex >= order.length) {
		return [...order];
	}

	// 入れ替え用の複製。入力配列は書き換えない
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
	// そのメニューで許可する ID
	const allowed          = new Set(defaults);
	// すでに採用した ID。重複は捨てる
	const seen             = new Set<string>();
	// 未知と重複を除いた並び。足りない既定は後で補う
	const result: string[] = [];

	(source ?? []).forEach((itemId) => {
		// 既定にあり、まだ採用していない ID だけ残す。どちらか一方では捨てる
		if (allowed.has(itemId) && !seen.has(itemId)) {
			seen.add(itemId);
			result.push(itemId);
		}
	});

	defaults.forEach((itemId) => {
		// 保存順に無かった既定項目。既定位置の近くへ足す
		if (!seen.has(itemId)) {
			seen.add(itemId);
			insertMissingContextMenuItem(result, itemId);
		}
	});

	return placeContextMenuItemAfter(placeContextMenuItemAfter(placeContextMenuItemAfter(placeContextMenuItemAfter(placeContextMenuItemAfter(placeContextMenuItemAfter(placeContextMenuItemAfter(placeContextMenuItemAfter(placeContextMenuItemAfter(result, 'pastePlain', 'paste', defaults), 'mergeTableCells', 'toggleCheckbox', defaults), 'unmergeTableCells', 'mergeTableCells', defaults), 'alignTableCellLeft', 'unmergeTableCells', defaults), 'alignTableCellCenter', 'alignTableCellLeft', defaults), 'alignTableCellRight', 'alignTableCellCenter', defaults), 'valignTableCellTop', 'alignTableCellRight', defaults), 'valignTableCellMiddle', 'valignTableCellTop', defaults), 'valignTableCellBottom', 'valignTableCellMiddle', defaults);
}

/**
 * 欠落した既定項目を、関連項目の直後へ挿入する
 * 位置が決まらない項目は末尾へ足す。`result` を直接書き換える
 * @param result - 構築中の順序。この配列へ挿入する
 * @param itemId - 追加する既定項目
 */
function insertMissingContextMenuItem(result: string[], itemId: string): void {
	// プレーンテキスト貼り付けは、通常の貼り付けの直後
	if (itemId === 'pastePlain') {
		// 貼り付け項目の位置。無ければ -1 で末尾へ回す
		const pasteIndex = result.indexOf('paste');
		// 貼り付けが並びにあるときだけその直後へ入れる
		if (pasteIndex >= 0) {
			result.splice(pasteIndex + 1, 0, itemId);
			return;
		}
	}

	// 表操作を、どの項目の直後へ足すか。値はその直前に置く ID
	const tableAfter: Record<string, string> = {
		// 表の挿入は、セル揃えの最後の直後
		insertTable: 'valignTableCellBottom',
		// 行の追加は、表の挿入の直後
		insertTableRowsBefore: 'insertTable',
		// 下への行追加は、上への行追加の直後
		insertTableRowsAfter: 'insertTableRowsBefore',
		// 行削除は、行追加の直後
		deleteTableRows: 'insertTableRowsAfter',
		// 行の上移動は、行削除の直後
		moveTableRowsUp: 'deleteTableRows',
		// 行の下移動は、上移動の直後
		moveTableRowsDown: 'moveTableRowsUp',
		// 列の追加は、行移動の直後
		insertTableColumnsBefore: 'moveTableRowsDown',
		// 右への列追加は、左への列追加の直後
		insertTableColumnsAfter: 'insertTableColumnsBefore',
		// 列削除は、列追加の直後
		deleteTableColumns: 'insertTableColumnsAfter',
		// 列の左移動は、列削除の直後
		moveTableColumnsLeft: 'deleteTableColumns',
		// 列の右移動は、左移動の直後
		moveTableColumnsRight: 'moveTableColumnsLeft'
	};
	// この項目の直前に置く ID。表操作でなければ undefined
	const tableAfterId                       = tableAfter[itemId];
	// 表操作の項目だけ、基準の直後を探す
	if (tableAfterId) {
		// 基準項目の位置。無ければ -1 で別の挿入規則へ進む
		const tableIndex = result.indexOf(tableAfterId);
		// 基準が並びにあるときだけその直後へ入れる
		if (tableIndex >= 0) {
			result.splice(tableIndex + 1, 0, itemId);
			return;
		}
	}

	// セル結合は、チェックボックス切替の直後
	if (itemId === 'mergeTableCells') {
		// チェックボックス項目の位置。無ければ -1
		const checkboxIndex = result.indexOf('toggleCheckbox');
		// チェックボックスが並びにあるときだけその直後へ入れる
		if (checkboxIndex >= 0) {
			result.splice(checkboxIndex + 1, 0, itemId);
			return;
		}
	}

	// 結合解除は、セル結合の直後
	if (itemId === 'unmergeTableCells') {
		// セル結合の位置。無ければ -1
		const mergeIndex = result.indexOf('mergeTableCells');
		// セル結合が並びにあるときだけその直後へ入れる
		if (mergeIndex >= 0) {
			result.splice(mergeIndex + 1, 0, itemId);
			return;
		}
	}

	// 見出しの折りたたみを、どの項目の直後へ足すか
	const headingAfter: Record<string, string> = {
		// 全折りたたみは、表示区切りの直後
		collapseAllHeadings: 'editorSeparatorView',
		// 全展開は、全折りたたみの直後
		expandAllHeadings: 'collapseAllHeadings'
	};
	// この項目の直前に置く ID。見出し操作でなければ undefined
	const headingAfterId                       = headingAfter[itemId];
	// 見出し操作の項目だけ、基準の直後を探す
	if (headingAfterId) {
		// 基準項目の位置。無ければ -1
		const headingIndex = result.indexOf(headingAfterId);
		// 基準が並びにあるときだけその直後へ入れる
		if (headingIndex >= 0) {
			result.splice(headingIndex + 1, 0, itemId);
			return;
		}
	}

	// セル揃えを、どの項目の直後へ足すか
	const alignAfter: Record<string, string> = {
		// 左詰めは、結合解除の直後
		alignTableCellLeft: 'unmergeTableCells',
		// 中央揃えは、左詰めの直後
		alignTableCellCenter: 'alignTableCellLeft',
		// 右詰めは、中央揃えの直後
		alignTableCellRight: 'alignTableCellCenter',
		// 上詰めは、右詰めの直後
		valignTableCellTop: 'alignTableCellRight',
		// 上下中央は、上詰めの直後
		valignTableCellMiddle: 'valignTableCellTop',
		// 下詰めは、上下中央の直後
		valignTableCellBottom: 'valignTableCellMiddle'
	};

	// この項目の直前に置く ID。揃え操作でなければ undefined
	const afterId = alignAfter[itemId];
	// 揃え操作の項目だけ、基準の直後を探す
	if (afterId) {
		// 基準項目の位置。無ければ -1 で末尾へ足す
		const afterIndex = result.indexOf(afterId);
		// 基準が並びにあるときだけその直後へ入れる
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
function placeContextMenuItemAfter(order: string[], itemId: string, afterId: string, defaults: string[]): string[] {
	// 戻す候補の位置。無ければ -1
	const itemIndex  = order.indexOf(itemId);
	// 直前に置く項目の位置。無ければ -1
	const afterIndex = order.indexOf(afterId);
	// どちらかが無い、またはすでに直後。どれか一つでも動かさない
	if (itemIndex < 0 || afterIndex < 0 || itemIndex === afterIndex + 1) {
		return order;
	}

	// 戻す候補を除いた現在順
	const withoutItem    = order.filter((id) => id !== itemId);
	// 戻す候補を除いた既定順。これと違えばユーザーが並びを変えている
	const defaultWithout = defaults.filter((id) => id !== itemId);
	// 長さが違う、または並びが既定と違う。どちらかならカスタム順として動かさない
	if (withoutItem.length !== defaultWithout.length || withoutItem.some((id, index) => id !== defaultWithout[index])) {
		return order;
	}

	// 候補を除いた複製。基準の次へ挿入する
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
	// そのメニューで許可する ID。未知の非表示は捨てる
	const allowed = new Set(defaults);
	return [...new Set((source ?? []).filter((itemId) => allowed.has(itemId)))];
}
