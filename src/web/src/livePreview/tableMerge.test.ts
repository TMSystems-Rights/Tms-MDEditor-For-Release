import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { createDocumentContextExtensions } from './documentContext';
import {
	buildAlignTableCellsChanges,
	buildMergeTableCellsChanges,
	buildTableOccupancy,
	buildUnmergeTableCellsChanges,
	cellAlignmentClassNames,
	describeTableCellSelection,
	formatCellSpan,
	getTableMergeActionState,
	getVisibleAdjacentTableCellPosition,
	isCoveredTableCell,
	parseCellSpan,
} from './tableMerge';
import { extractTableData } from './tableWidget';
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
});
