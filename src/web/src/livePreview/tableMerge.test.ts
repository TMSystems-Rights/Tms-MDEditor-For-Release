import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { createDocumentContextExtensions } from './documentContext';
import {
	buildAlignTableCellsChanges,
	buildMergeTableCellsChanges,
	buildTableLayoutChange,
	buildTableOccupancy,
	buildUnmergeTableCellsChanges,
	cellAlignmentClassNames,
	describeTableCellSelection,
	formatCellSpan,
	isMultiCellTableSelectionRect,
	getTableMergeActionState,
	getVisibleAdjacentTableCellPosition,
	isCoveredTableCell,
	parseCellSpan,
	readTableLayout,
	resolveTableMergeRect,
} from './tableMerge';
import {
	applyTableMergeSnapshot,
	extractTableData,
	getTableDataIdentity,
	resolveTableMergeTargetFromParts,
} from './tableWidget';
import { syntaxTree } from '@codemirror/language';

/**
 * @param {string} doc 文書
 * @returns {EditorState}
 */
function createState(doc: string): EditorState {
	return EditorState.create({
		doc,
		selection  : EditorSelection.cursor(0),
		extensions : [
			createTmsMarkdownSupport(),
			...createDocumentContextExtensions({
				filePath        : 'E:\\vault\\note.md',
				loadRemoteImages: true,
			}),
		],
	});
}

/**
 * @param {EditorState} state 状態
 * @returns {import('./tableWidget').TableData}
 */
function tableData(state: EditorState) {
	let found: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * @param {{ name: string; node: import('@lezer/common').SyntaxNode }} ref ノード
		 * @returns {boolean | void}
		 */
		enter(ref) {
			if (ref.name === 'Table') {
				found = ref.node;
				return false;
			}
		},
	});
	if (!found) {
		throw new Error('Table が無い');
	}

	return extractTableData(state, found);
}

describe('tableMerge', () => {
	it('末尾の colspan / rowspan を読む', () => {
		expect(parseCellSpan('新キャラ{colspan=3}')).toMatchObject({
			text   : '新キャラ',
			colspan: 3,
			rowspan: 1,
		});
		expect(parseCellSpan('A{rowspan=2}')).toMatchObject({ text: 'A', colspan: 1, rowspan: 2 });
		expect(parseCellSpan('X{colspan=2 rowspan=2}')).toMatchObject({
			text   : 'X',
			colspan: 2,
			rowspan: 2,
		});
		expect(parseCellSpan('Y{colspan=2}{rowspan=3}')).toMatchObject({
			text   : 'Y',
			colspan: 2,
			rowspan: 3,
		});
		expect(formatCellSpan('新キャラ', 3, 1)).toBe('新キャラ{colspan=3}');
		expect(formatCellSpan('A', 1, 1)).toBe('A');
	});

	it('末尾の align / valign を読む', () => {
		expect(parseCellSpan('100{align=right}')).toMatchObject({
			text  : '100',
			align : 'right',
			valign: 'top',
		});
		expect(parseCellSpan('見出し{valign=middle}')).toMatchObject({
			text  : '見出し',
			align : 'left',
			valign: 'middle',
		});
		expect(parseCellSpan('新キャラ{colspan=3 align=center valign=middle}')).toMatchObject({
			text   : '新キャラ',
			colspan: 3,
			align  : 'center',
			valign : 'middle',
		});
		expect(parseCellSpan('A{align=center}{valign=bottom}')).toMatchObject({
			text  : 'A',
			align : 'center',
			valign: 'bottom',
		});
		expect(parseCellSpan('B{valign=center}')).toMatchObject({ text: 'B', valign: 'middle' });
		expect(formatCellSpan('100', 1, 1, 'right')).toBe('100{align=right}');
		expect(formatCellSpan('見出し', 1, 1, 'left', 'middle')).toBe('見出し{valign=middle}');
		expect(formatCellSpan('新キャラ', 3, 1, 'center', 'middle')).toBe(
			'新キャラ{colspan=3 align=center valign=middle}',
		);
		expect(formatCellSpan('A', 1, 1, 'left', 'top')).toBe('A');
		expect(cellAlignmentClassNames({ align: 'center', valign: 'middle' })).toBe(
			'cm-md-table-align-center cm-md-table-valign-middle',
		);
		expect(cellAlignmentClassNames({ align: 'left', valign: 'top' })).toBe('');
	});

	it('末尾の colwidths / rowheights を読む', () => {
		expect(parseCellSpan('{colwidths=120,80,200}')).toMatchObject({
			text      : '',
			colwidths : [120, 80, 200],
			rowheights: [],
		});
		expect(parseCellSpan('見出し{colspan=2 colwidths=100,90 rowheights=32,40}')).toMatchObject({
			text      : '見出し',
			colspan   : 2,
			colwidths : [100, 90],
			rowheights: [32, 40],
		});
		expect(formatCellSpan('', 1, 1, 'left', 'top', [120, 80], [32, 40])).toBe(
			'{colwidths=120,80 rowheights=32,40}',
		);
		expect(formatCellSpan('A', 2, 1, 'center', 'top', [100, 90], [])).toBe(
			'A{colspan=2 align=center colwidths=100,90}',
		);
	});

	it('見出し左上セルから列幅・行高を読み書きする', () => {
		const data = tableData(createState('|   |   |\n|---|---|\n|A|B|\n'));
		expect(readTableLayout(data)).toEqual({ widths: undefined, heights: undefined });
		const change = buildTableLayoutChange(data, { widths: [120, 80], heights: [28, 40] });
		expect(change?.insert).toBe('{colwidths=120,80 rowheights=28,40}');
		const sized = tableData(createState(
			'| {colwidths=120,80 rowheights=28,40} |   |\n|---|---|\n|A|B|\n',
		));
		expect(readTableLayout(sized)).toEqual({ widths: [120, 80], heights: [28, 40] });
	});

	it('占有グリッドで覆われるマスを付ける', () => {
		const data      = tableData(createState('|   |   |   |\n|---|---|---|\n|新キャラ{colspan=3}|  |  |\n|A|B|C|'));
		const occupancy = buildTableOccupancy(data);
		expect(isCoveredTableCell(occupancy, { row: 1, column: 0 })).toBe(false);
		expect(isCoveredTableCell(occupancy, { row: 1, column: 1 })).toBe(true);
		expect(isCoveredTableCell(occupancy, { row: 1, column: 2 })).toBe(true);
		expect(occupancy.cells[1]![0]).toMatchObject({ colspan: 3, rowspan: 1, covered: false });
	});

	it('矩形選択を結合し、解除できる', () => {
		const data = tableData(createState('|   |   |   |\n|---|---|---|\n|A|B|C|'));
		const rect = { startRow: 1, startColumn: 0, endRow: 1, endColumn: 2 };
		expect(getTableMergeActionState(data, rect).canMerge).toBe(true);
		const merged = buildMergeTableCellsChanges(data, rect);
		expect(merged).not.toBeNull();
		const next = data.headerSources[0]!.text;
		void next;
		const applied    = createState('|   |   |   |\n|---|---|---|\n|A{colspan=3}|  |  |');
		const mergedData = tableData(applied);
		expect(getTableMergeActionState(mergedData, rect).canUnmerge).toBe(true);
		const undone = buildUnmergeTableCellsChanges(mergedData, rect);
		expect(undone?.[0]?.insert).toBe('A');
	});

	it('結合を文書へ書いたあと抽出し、解除で属性を消す', () => {
		let state    = createState('|   |   |   |\n|---|---|---|\n|A|B|C|');
		const data   = tableData(state);
		const merged = buildMergeTableCellsChanges(data, {
			startRow: 1, startColumn: 0, endRow: 1, endColumn: 2,
		});
		expect(merged).not.toBeNull();
		state            = state.update({
			changes: merged!.map((change) => ({
				from: change.from, to: change.to, insert: change.insert,
			})),
		}).state;
		const mergedData = tableData(state);
		expect(mergedData.rowSources[0]![0]!.text).toContain('{colspan=3}');
		expect(getTableDataIdentity(data)).not.toBe(getTableDataIdentity(mergedData));
		const undone = buildUnmergeTableCellsChanges(
			mergedData,
			resolveTableMergeRect(mergedData, null, { row: 1, column: 1 })!,
		);
		expect(undone?.[0]?.insert).toBe('A');
		state = state.update({
			changes: undone!.map((change) => ({
				from: change.from, to: change.to, insert: change.insert,
			})),
		}).state;
		expect(tableData(state).rowSources[0]![0]!.text).toBe('A');
	});

	it('結合は配置を残し、解除は結合だけ外す', () => {
		const data = tableData(createState('|   |   |   |\n|---|---|---|\n|A{align=center valign=middle}|B|C|'));
		const rect = { startRow: 1, startColumn: 0, endRow: 1, endColumn: 2 };
		expect(buildMergeTableCellsChanges(data, rect)?.map((change) => change.insert)).toContain(
			'A{colspan=3 align=center valign=middle}',
		);
		const mergedData = tableData(createState(
			'|   |   |   |\n|---|---|---|\n|A{colspan=3 align=center valign=middle}|  |  |',
		));
		expect(buildUnmergeTableCellsChanges(mergedData, rect)?.map((change) => change.insert)).toContain(
			'A{align=center valign=middle}',
		);
	});

	it('選択範囲の原点セルへ配置を書く', () => {
		const data    = tableData(createState('|   |   |\n|---|---|\n|A|B{align=right}|'));
		const rect    = { startRow: 1, startColumn: 0, endRow: 1, endColumn: 1 };
		const written = buildAlignTableCellsChanges(data, rect, { align: 'center', valign: 'middle' });
		expect(written?.map((change) => change.insert)).toEqual([
			'B{align=center valign=middle}',
			'A{align=center valign=middle}',
		]);
		expect(buildAlignTableCellsChanges(data, rect, { align: 'left' })?.[0]?.insert).toBe('B');
	});

	it('1セルだけの矩形は塗らず、複数セルだけ塗る', () => {
		expect(isMultiCellTableSelectionRect({
			startRow: 1, startColumn: 1, endRow: 1, endColumn: 1,
		})).toBe(false);
		expect(isMultiCellTableSelectionRect({
			startRow: 1, startColumn: 1, endRow: 1, endColumn: 2,
		})).toBe(true);
		expect(isMultiCellTableSelectionRect({
			startRow: 1, startColumn: 1, endRow: 2, endColumn: 1,
		})).toBe(true);
	});

	it('選択範囲の外周辺だけをセルに付ける', () => {
		const rect = { startRow: 1, startColumn: 0, endRow: 2, endColumn: 2 };
		expect(describeTableCellSelection({ row: 1, column: 0 }, 1, 1, rect)).toEqual({
			selected: true,
			north   : true,
			south   : false,
			east    : false,
			west    : true,
		});
		expect(describeTableCellSelection({ row: 2, column: 2 }, 1, 1, rect)).toEqual({
			selected: true,
			north   : false,
			south   : true,
			east    : true,
			west    : false,
		});
		expect(describeTableCellSelection({ row: 1, column: 0 }, 2, 3, rect)).toEqual({
			selected: true,
			north   : true,
			south   : true,
			east    : true,
			west    : true,
		});
		expect(describeTableCellSelection({ row: 0, column: 0 }, 1, 1, rect)).toEqual({
			selected: false,
			north   : false,
			south   : false,
			east    : false,
			west    : false,
		});
	});

	it('結合セルからは覆われたマスを飛ばして移動する', () => {
		const data = tableData(createState('|   |   |   |\n|---|---|---|\n|A{colspan=3}|  |  |\n|D|E|F|'));
		expect(getVisibleAdjacentTableCellPosition(data, { row: 1, column: 0 }, 'next')).toEqual({
			row   : 2,
			column: 0,
		});
		expect(getVisibleAdjacentTableCellPosition(data, { row: 2, column: 0 }, 'up')).toEqual({
			row   : 1,
			column: 0,
		});
	});

	it('上下キーは覆われているマスの結合原点へ入る', () => {
		const data = tableData(createState([
			'見出し１{colwidths=111,97,32 rowheights=32,263}|||',
			'|---|---|---|',
			'|データ１－１{colspan=3}||',
			'|データ２－１|あああ<br>いいい|',
			'|データ３－１{colspan=3}||',
		].join('\n')));
		expect(getVisibleAdjacentTableCellPosition(data, { row: 2, column: 1 }, 'up')).toEqual({
			row   : 1,
			column: 0,
		});
		expect(getVisibleAdjacentTableCellPosition(data, { row: 2, column: 1 }, 'down')).toEqual({
			row   : 3,
			column: 0,
		});
		expect(getVisibleAdjacentTableCellPosition(data, { row: 1, column: 0 }, 'down')).toEqual({
			row   : 2,
			column: 0,
		});
		expect(getVisibleAdjacentTableCellPosition(data, { row: 3, column: 0 }, 'up')).toEqual({
			row   : 2,
			column: 0,
		});
	});

	it('検証表の結合セルは表位置だけから解除できる', () => {
		const state    = createState([
			'見出し１{colwidths=111,97,32 rowheights=32,263}|||',
			'|---|---|---|',
			'|データ１－１{colspan=3}||',
			'|データ２－１|あああ<br>いいい|',
			'|データ３－１{colspan=3}||',
		].join('\n'));
		const data     = tableData(state);
		const resolved = resolveTableMergeTargetFromParts(state, data.tableFrom, null, { row: 1, column: 1 });
		expect(resolved?.state.canUnmerge).toBe(true);
		const undone = buildUnmergeTableCellsChanges(resolved!.data, resolved!.state.rect);
		expect(undone?.[0]?.insert).toBe('データ１－１');
		const next = state.update({
			changes: undone!.map((change) => ({
				from: change.from, to: change.to, insert: change.insert,
			})),
		}).state;
		expect(tableData(next).rowSources[0]![0]!.text).toBe('データ１－１');
		expect(tableData(next).rowSources[0]![0]!.text).not.toContain('colspan');
	});

	it('メニュー時点のスナップショットから解除すると colspan が消える', () => {
		const state    = createState([
			'見出し１{colwidths=111,97,32 rowheights=32,263}|||',
			'|---|---|---|',
			'|データ１－１{colspan=3}||',
			'|データ２－１|あああ<br>いいい|',
			'|データ３－１{colspan=3}||',
		].join('\n'));
		const data     = tableData(state);
		const resolved = resolveTableMergeTargetFromParts(state, data.tableFrom, null, { row: 1, column: 1 });
		const view     = {
			state,
			/**
			 * @param {TransactionSpec} spec 更新
			 * @returns {void}
			 */
			dispatch(spec: TransactionSpec) {
				this.state = this.state.update(spec).state;
			},
			/**
			 *
			 */
			focus() {},
			dom: { /**
			 *
			 */
				querySelector: () => null },
		};

		expect(applyTableMergeSnapshot(
			view as never,
			{ tableFrom: data.tableFrom, rect: resolved!.state.rect },
			'unmerge',
		)).toBe(true);
		expect(tableData(view.state).rowSources[0]![0]!.text).toBe('データ１－１');
		expect(tableData(view.state).rowSources[2]![0]!.text).toContain('{colspan=3}');
	});

	it('1セルクリックは結合全体を解除対象にする', () => {
		const data = tableData(createState('|   |   |   |\n|---|---|---|\n|A{colspan=3}|  |  |\n|D|E|F|'));
		expect(resolveTableMergeRect(data, null, { row: 1, column: 1 })).toEqual({
			startRow   : 1,
			startColumn: 0,
			endRow     : 1,
			endColumn  : 2,
		});
		expect(getTableMergeActionState(data, resolveTableMergeRect(data, null, { row: 1, column: 2 })!).canUnmerge)
			.toBe(true);
		expect(buildUnmergeTableCellsChanges(data, resolveTableMergeRect(data, null, { row: 1, column: 1 })!)?.[0]?.insert)
			.toBe('A');
		expect(resolveTableMergeRect(data, {
			startRow: 2, startColumn: 0, endRow: 2, endColumn: 2,
		}, { row: 2, column: 1 })).toEqual({
			startRow   : 2,
			startColumn: 0,
			endRow     : 2,
			endColumn  : 2,
		});
	});
});
