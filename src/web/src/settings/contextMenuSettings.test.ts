/**
 * コンテキストメニューの並びが、未知 ID と欠落項目を既定位置へ戻すことを確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { createDefaultContextMenuSettings, moveContextMenuItem, normalizeContextMenuSettings } from './contextMenuSettings';

describe('contextMenuSettings', () => {
	it('未知IDと重複を除去し、欠落した既定項目を末尾へ補完する', () => {
		// 補完後の長さとタブ順を比べる既定
		const defaults = createDefaultContextMenuSettings();
		// 未知と重複を除き、欠けた既定項目を末尾へ補った結果
		const result   = normalizeContextMenuSettings({
			// エディタの並び。未知 ID と copy の重複を含む
			editorOrder: ['copy', 'unknown', 'copy'],
			// 非表示。同じ未知と重複。未知は落ちて copy だけ残る
			editorHidden: ['copy', 'unknown', 'copy'],
			// タブの並び。空は既定順で埋まる
			tabOrder: [],
			// タブの非表示。空は何も隠さない
			tabHidden: []
		});

		expect(result.editorOrder[0]).toBe('copy');
		expect(result.editorOrder).toHaveLength(defaults.editorOrder.length);
		expect(result.editorHidden).toEqual(['copy']);
		expect(result.tabOrder).toEqual(defaults.tabOrder);
	});

	it('既定のエディタメニューにプレーンテキスト貼り付けを含める', () => {
		// 既定の並び。pastePlain が paste の直後にある
		const defaults = createDefaultContextMenuSettings();
		expect(defaults.editorOrder.indexOf('pastePlain')).toBe(defaults.editorOrder.indexOf('paste') + 1);
	});

	it('欠落したプレーンテキスト貼り付けを貼り付けの次へ補完する', () => {
		// pastePlain を欠いた並びの元。補完位置の基準
		const defaults = createDefaultContextMenuSettings();
		// pastePlain を貼り付けの次へ戻した結果
		const result   = normalizeContextMenuSettings({
			// エディタの並び。pastePlain だけ欠ける
			editorOrder: defaults.editorOrder.filter((itemId) => itemId !== 'pastePlain'),
			// 非表示。空は何も隠さない
			editorHidden: [],
			// タブの並び。空は既定順で埋まる
			tabOrder: [],
			// タブの非表示。空は何も隠さない
			tabHidden: []
		});

		expect(result.editorOrder.indexOf('pastePlain')).toBe(result.editorOrder.indexOf('paste') + 1);
	});

	it('既定順の末尾へ付いたプレーンテキスト貼り付けを貼り付けの次へ移す', () => {
		// pastePlain を末尾へ付けた並びの元。既定位置へ戻す
		const defaults = createDefaultContextMenuSettings();
		// 末尾の pastePlain を貼り付けの次へ移した結果
		const result   = normalizeContextMenuSettings({
			// エディタの並び。pastePlain は既定の位置ではなく末尾
			editorOrder: [...defaults.editorOrder.filter((itemId) => itemId !== 'pastePlain'), 'pastePlain'],
			// 非表示。空は何も隠さない
			editorHidden: [],
			// タブの並び。空は既定順で埋まる
			tabOrder: [],
			// タブの非表示。空は何も隠さない
			tabHidden: []
		});

		expect(result.editorOrder.indexOf('pastePlain')).toBe(result.editorOrder.indexOf('paste') + 1);
		expect(result.editorOrder).toEqual(defaults.editorOrder);
	});

	it('独自順のプレーンテキスト貼り付け位置は維持する', () => {
		// 独自順を保った結果。pastePlain は selectAll の次のまま
		const result = normalizeContextMenuSettings({
			// エディタの並び。既定とは違う位置に pastePlain がある
			editorOrder: ['copy', 'paste', 'selectAll', 'pastePlain'],
			// 非表示。空は何も隠さない
			editorHidden: [],
			// タブの並び。空は既定順で埋まる
			tabOrder: [],
			// タブの非表示。空は何も隠さない
			tabHidden: []
		});

		expect(result.editorOrder.indexOf('pastePlain')).toBe(result.editorOrder.indexOf('selectAll') + 1);
	});

	it('既定のエディタメニューに表セル結合を含める', () => {
		// 既定の並び。結合と配置がチェックボックスの後ろに続く
		const defaults = createDefaultContextMenuSettings();
		expect(defaults.editorOrder.indexOf('mergeTableCells')).toBe(defaults.editorOrder.indexOf('toggleCheckbox') + 1);
		expect(defaults.editorOrder.indexOf('unmergeTableCells')).toBe(defaults.editorOrder.indexOf('mergeTableCells') + 1);
		expect(defaults.editorOrder.indexOf('alignTableCellLeft')).toBe(defaults.editorOrder.indexOf('unmergeTableCells') + 1);
		expect(defaults.editorOrder.indexOf('valignTableCellBottom')).toBe(defaults.editorOrder.indexOf('valignTableCellMiddle') + 1);
	});

	it('欠落した表セル結合をチェックボックスの次へ補完する', () => {
		// 結合の 2 項目を欠いた並びの元
		const defaults = createDefaultContextMenuSettings();
		// 欠けた結合をチェックボックスの次へ戻した結果
		const result   = normalizeContextMenuSettings({
			// エディタの並び。結合と結合解除だけ欠ける
			editorOrder: defaults.editorOrder.filter((itemId) => itemId !== 'mergeTableCells' && itemId !== 'unmergeTableCells'),
			// 非表示。空は何も隠さない
			editorHidden: [],
			// タブの並び。空は既定順で埋まる
			tabOrder: [],
			// タブの非表示。空は何も隠さない
			tabHidden: []
		});

		expect(result.editorOrder.indexOf('mergeTableCells')).toBe(result.editorOrder.indexOf('toggleCheckbox') + 1);
		expect(result.editorOrder.indexOf('unmergeTableCells')).toBe(result.editorOrder.indexOf('mergeTableCells') + 1);
	});

	it('欠落した表セル配置を結合解除の次へ補完する', () => {
		// 水平・垂直の配置を欠いた並びの元
		const defaults = createDefaultContextMenuSettings();
		// 欠けた配置を結合解除の次へ戻した結果
		const result   = normalizeContextMenuSettings({
			// エディタの並び。配置 ID だけ欠ける
			editorOrder: defaults.editorOrder.filter((itemId) => !itemId.startsWith('alignTableCell') && !itemId.startsWith('valignTableCell')),
			// 非表示。空は何も隠さない
			editorHidden: [],
			// タブの並び。空は既定順で埋まる
			tabOrder: [],
			// タブの非表示。空は何も隠さない
			tabHidden: []
		});

		expect(result.editorOrder.indexOf('alignTableCellLeft')).toBe(result.editorOrder.indexOf('unmergeTableCells') + 1);
		expect(result.editorOrder.slice(result.editorOrder.indexOf('alignTableCellLeft'), result.editorOrder.indexOf('valignTableCellBottom') + 1)).toEqual(['alignTableCellLeft', 'alignTableCellCenter', 'alignTableCellRight', 'valignTableCellTop', 'valignTableCellMiddle', 'valignTableCellBottom']);
	});

	it('既定の表示メニューにアウトライン切替を含める', () => {
		// 既定の並び。表示モードの直後がアウトライン切替
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
