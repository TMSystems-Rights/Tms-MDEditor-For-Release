import type { ContextMenuSettings } from '../types/app';

export type ContextMenuKind = 'editor' | 'tab';

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
	'openLink',
	'editorSeparatorView',
	'toggleViewMode',
	'toggleOutline',
	'editorSeparatorSplit',
	'splitHorizontal',
	'splitVertical',
	'unsplit',
] as const;

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
	mergeTableCells         : 'セルを結合',
	unmergeTableCells       : '結合を解除',
	alignTableCellLeft      : '左詰め',
	alignTableCellCenter    : '中央揃え',
	alignTableCellRight     : '右詰め',
	valignTableCellTop      : '上詰め',
	valignTableCellMiddle   : '上下中央',
	valignTableCellBottom   : '下詰め',
	openLink                : 'リンクを開く',
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
 * 既定のコンテキストメニュー設定を複製して返す。
 * @returns {ContextMenuSettings} 既定設定
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
 * 保存済み設定の欠落・重複・未知IDを補正する。
 * @param {ContextMenuSettings | undefined} settings 保存済み設定
 * @returns {ContextMenuSettings} 正規化した設定
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
 * 指定メニューの表示順を1件移動する。
 * @param {string[]} order 現在の順序
 * @param {string} itemId 移動対象
 * @param {-1 | 1} direction 移動方向
 * @returns {string[]} 移動後の順序
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
 * 区切り線IDか判定する。
 * @param {string} itemId 項目ID
 * @returns {boolean} 区切り線ならtrue
 */
export function isContextMenuSeparator(itemId: string): boolean {
	return itemId.includes('Separator');
}

/**
 *
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
 * 欠落した既定項目を挿入する。貼り付け系は「貼り付け」の次へ置く。
 * @param {string[]} result 構築中の順序
 * @param {string} itemId 追加する項目
 * @returns {void}
 */
function insertMissingContextMenuItem(result: string[], itemId: string): void {
	if (itemId === 'pastePlain') {
		const pasteIndex = result.indexOf('paste');
		if (pasteIndex >= 0) {
			result.splice(pasteIndex + 1, 0, itemId);
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
 * 保存順が既定と同一なら、指定項目を基準項目の次へ移す。
 * @param {string[]} order 現在の順序
 * @param {string} itemId 移動する項目
 * @param {string} afterId 直前に置く項目
 * @param {string[]} defaults 既定順
 * @returns {string[]} 補正後の順序
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
 *
 */
function normalizeHidden(source: string[] | undefined, defaults: string[]): string[] {
	const allowed = new Set(defaults);
	return [...new Set((source ?? []).filter((itemId) => allowed.has(itemId)))];
}
