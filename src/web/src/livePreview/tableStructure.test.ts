import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { extractTableData, type TableData } from './tableWidget';
import {
	buildTableStructureChange,
	buildTableStructureGroups,
	buildTableInsertionChange,
	createMarkdownTable,
} from './tableStructure';

/**
 *
 */
function createState(doc: string): EditorState {
	return EditorState.create({ doc, extensions: [createTmsMarkdownSupport()] });
}

/**
 *
 */
function tableData(state: EditorState): TableData {
	let result: TableData | null = null;
	syntaxTree(state).iterate({
		/**
		 *
		 */
		enter(node) {
			if (node.name === 'Table') result = extractTableData(state, node.node);
		},
	});
	return result!;
}

/**
 *
 */
function applyChange(state: EditorState, change: { from: number; to: number; insert: string }): string {
	return state.update({ changes: change }).state.doc.toString();
}

describe('tableStructure', () => {
	it('重なる colspan を推移的に1つの列選択単位へまとめる', () => {
		const state = createState('| H1 | H2 | H3 | H4 |\n| --- | --- | --- | --- |\n| A{colspan=2} | | C | D |\n| A | B{colspan=2} | | D |');
		expect(buildTableStructureGroups(tableData(state), 'column')).toEqual([
			{ start: 0, end: 2 },
			{ start: 3, end: 3 },
		]);
	});

	it('データ行の重なる rowspan を推移的に1つの行選択単位へまとめる', () => {
		const state = createState('| H1 | H2 |\n| --- | --- |\n| A{rowspan=2} | 1 |\n| | B{rowspan=2} |\n| 3 | |\n| 4 | 4 |');
		expect(buildTableStructureGroups(tableData(state), 'row')).toEqual([
			{ start: 1, end: 3 },
			{ start: 4, end: 4 },
		]);
	});

	it('複数行を同数追加、削除、隣接グループ単位で移動する', () => {
		const source = '| H1 | H2 |\n| --- | --- |\n| A{rowspan=2} | 1 |\n| | 2 |\n| C | 3 |';
		let state    = createState(source);
		let data     = tableData(state);
		const added  = buildTableStructureChange(state, data, { axis: 'row', start: 1, end: 2 }, 'insert-after')!;
		expect(applyChange(state, added)).toContain('|  |  |\n|  |  |\n| C | 3 |');

		state          = createState(source);
		data           = tableData(state);
		const moved    = buildTableStructureChange(state, data, { axis: 'row', start: 3, end: 3 }, 'move-previous')!;
		const movedDoc = applyChange(state, moved);
		expect(movedDoc.indexOf('| C | 3 |')).toBeLessThan(movedDoc.indexOf('| A{rowspan=2} | 1 |'));

		state         = createState(source);
		data          = tableData(state);
		const removed = buildTableStructureChange(state, data, { axis: 'row', start: 1, end: 2 }, 'delete')!;
		expect(applyChange(state, removed)).toBe('| H1 | H2 |\n| --- | --- |\n| C | 3 |');
	});

	it('列操作で配置と表レイアウトを対象列と一緒に移動する', () => {
		const state = createState('| H1{colwidths=100,200,300 rowheights=30,40} | H2 | H3 |\n| :--- | ---: | --- |\n| A | B | C |');
		const data  = tableData(state);
		const moved = buildTableStructureChange(state, data, { axis: 'column', start: 2, end: 2 }, 'move-previous')!;
		expect(applyChange(state, moved)).toBe(
			'| H1{colwidths=100,300,200 rowheights=30,40} | H3 | H2 |\n| :--- | --- | ---: |\n| A | C | B |',
		);
	});

	it('全列削除は拒否し、先頭列削除でもレイアウトを新しい左上へ移す', () => {
		const state = createState('| H1{colwidths=100,200} | H2 |\n| --- | --- |\n| A | B |');
		const data  = tableData(state);
		expect(buildTableStructureChange(state, data, { axis: 'column', start: 0, end: 1 }, 'delete')).toBeNull();
		const removed = buildTableStructureChange(state, data, { axis: 'column', start: 0, end: 0 }, 'delete')!;
		expect(applyChange(state, removed)).toBe('| H2{colwidths=200} |\n| --- |\n| B |');
	});

	it('指定した列数とデータ行数で新規表を作る', () => {
		expect(createMarkdownTable(2, 2)).toBe(
			'| 見出し 1 | 見出し 2 |\n| --- | --- |\n|  |  |\n|  |  |',
		);
	});

	it('本文途中へ挿入すると表の前後を改行する', () => {
		const state  = createState('前後');
		const change = buildTableInsertionChange(state, 1, createMarkdownTable(1, 0));
		expect(applyChange(state, change)).toBe('前\n| 見出し 1 |\n| --- |\n後');
	});
});
