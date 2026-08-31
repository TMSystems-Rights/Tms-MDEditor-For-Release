import type { ContextMenuSettings } from '../types/app';

export type ContextMenuKind = 'editor' | 'tab';

export const DEFAULT_EDITOR_CONTEXT_MENU_ORDER = [
	'undo',
	'redo',
	'editorSeparatorClipboard',
	'cut',
	'copy',
	'paste',
	'selectAll',
	'editorSeparatorSearch',
	'find',
	'replace',
	'editorSeparatorContext',
	'toggleCheckbox',
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
	selectAll               : 'すべて選択',
	find                    : '検索',
	replace                 : '置換',
	toggleCheckbox          : 'チェックボックス切替',
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
			result.push(itemId);
		}
	});

	return result;
}

/**
 *
 */
function normalizeHidden(source: string[] | undefined, defaults: string[]): string[] {
	const allowed = new Set(defaults);
	return [...new Set((source ?? []).filter((itemId) => allowed.has(itemId)))];
}
