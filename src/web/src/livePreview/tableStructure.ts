import type { EditorState } from '@codemirror/state';
import {
	buildTableOccupancy,
	formatCellSpan,
	parseCellSpan,
	readTableLayout,
} from './tableMerge';
import type { TableData, TableDocumentChange } from './tableWidget';

export type TableStructureAxis = 'row' | 'column';

export type TableStructureRange = {
	start: number;
	end: number;
};

export type TableStructureSelection = TableStructureRange & {
	axis: TableStructureAxis;
};

export type TableStructureAction =
	| 'insert-before'
	| 'insert-after'
	| 'delete'
	| 'move-previous'
	| 'move-next';

type TableSourceModel = {
	header: string[];
	delimiter: string[];
	rows: string[][];
	widths?: number[];
	heights?: number[];
};

/**
 * colspan / rowspan で推移的につながる行・列を選択単位へまとめる。
 * 行方向は Markdown 見出し行を除外する。
 * @param {TableData} data 表
 * @param {TableStructureAxis} axis 軸
 * @returns {TableStructureRange[]} 選択単位
 */
export function buildTableStructureGroups(
	data: TableData,
	axis: TableStructureAxis,
): TableStructureRange[] {
	const occupancy = buildTableOccupancy(data);
	const offset    = axis === 'row' ? 1 : 0;
	const count     = axis === 'row' ? Math.max(0, occupancy.rowCount - 1) : occupancy.columnCount;
	const parents   = Array.from({ length: count }, (_, index) => index);

	/** @param {number} value 値 @returns {number} 根 */
	const find = (value: number): number => {
		let current = value;
		while (parents[current] !== current) {
			parents[current] = parents[parents[current]!]!;
			current          = parents[current]!;
		}
		return current;
	};
	/** @param {number} left 左 @param {number} right 右 @returns {void} */
	const unite = (left: number, right: number): void => {
		const leftRoot  = find(left);
		const rightRoot = find(right);
		if (leftRoot !== rightRoot) {
			parents[rightRoot] = leftRoot;
		}
	};

	for (let row = offset; row < occupancy.rowCount; row += 1) {
		for (let column = 0; column < occupancy.columnCount; column += 1) {
			const cell = occupancy.cells[row]?.[column];
			if (!cell || cell.covered) {
				continue;
			}

			if (axis === 'column' && cell.colspan > 1) {
				for (let next = column + 1; next < column + cell.colspan; next += 1) {
					unite(column, next);
				}
			}

			if (axis === 'row' && cell.originRow >= 1 && cell.rowspan > 1) {
				const start = cell.originRow - 1;
				for (let next = start + 1; next < start + cell.rowspan && next < count; next += 1) {
					unite(start, next);
				}
			}
		}
	}

	const groups: TableStructureRange[] = [];
	for (let index = 0; index < count; index += 1) {
		const actual = index + offset;
		if (groups.length === 0 || find(index) !== find(index - 1)) {
			groups.push({ start: actual, end: actual });
		} else {
			groups.at(-1)!.end = actual;
		}
	}
	return groups;
}

/**
 * 選択範囲の構造操作可否を返す。
 * @param {TableData} data 表
 * @param {TableStructureSelection} selection 選択
 * @returns {{ canDelete: boolean; canMovePrevious: boolean; canMoveNext: boolean }} 可否
 */
export function getTableStructureActionState(
	data: TableData,
	selection: TableStructureSelection,
): { canDelete: boolean; canMovePrevious: boolean; canMoveNext: boolean } {
	const groups = buildTableStructureGroups(data, selection.axis);
	const first  = groups.findIndex((group) => group.start === selection.start);
	const last   = groups.findIndex((group) => group.end === selection.end);
	const count  = selection.axis === 'row'
		? data.rowSources.length
		: Math.max(data.headerSources.length, ...data.rowSources.map((row) => row.length), 0);
	return {
		canDelete      : first >= 0 && last >= first && (selection.axis === 'row' || selection.end - selection.start + 1 < count),
		canMovePrevious: first > 0 && last >= first,
		canMoveNext    : first >= 0 && last >= first && last < groups.length - 1,
	};
}

/**
 * 表構造操作を表全体の1置換へ変換する。
 * @param {EditorState} state エディタ状態
 * @param {TableData} data 表
 * @param {TableStructureSelection} selection 選択
 * @param {TableStructureAction} action 操作
 * @returns {TableDocumentChange | null} 文書変更
 */
export function buildTableStructureChange(
	state: EditorState,
	data: TableData,
	selection: TableStructureSelection,
	action: TableStructureAction,
): TableDocumentChange | null {
	const actionState = getTableStructureActionState(data, selection);
	if ((action === 'delete' && !actionState.canDelete)
		|| (action === 'move-previous' && !actionState.canMovePrevious)
		|| (action === 'move-next' && !actionState.canMoveNext)) {
		return null;
	}

	const model  = extractTableSourceModel(state, data);
	const groups = buildTableStructureGroups(data, selection.axis);
	const first  = groups.findIndex((group) => group.start === selection.start);
	const last   = groups.findIndex((group) => group.end === selection.end);
	if (first < 0 || last < first) {
		return null;
	}

	if (selection.axis === 'row') {
		applyRowAction(model, groups, selection, action, first, last);
	} else {
		applyColumnAction(model, groups, selection, action, first, last);
	}

	restoreTableLayout(model);
	return {
		from  : data.tableFrom,
		to    : data.tableTo,
		insert: serializeTableSourceModel(model),
	};
}

/**
 * 新規 Markdown 表を作る。
 * @param {number} columnCount 列数
 * @param {number} dataRowCount データ行数
 * @returns {string} Markdown
 */
export function createMarkdownTable(columnCount: number, dataRowCount: number): string {
	const columns = Math.max(1, Math.floor(columnCount));
	const rows    = Math.max(0, Math.floor(dataRowCount));
	const header  = Array.from({ length: columns }, (_, index) => `見出し ${index + 1}`);
	const lines   = [formatTableRow(header), formatTableRow(Array.from({ length: columns }, () => '---'))];
	for (let row = 0; row < rows; row += 1) {
		lines.push(formatTableRow(Array.from({ length: columns }, () => '')));
	}
	return lines.join('\n');
}

/**
 * 行途中でも前後を改行して表を独立ブロックとして挿入する。
 * @param {EditorState} state 状態
 * @param {number} position 挿入位置
 * @param {string} markdown 表Markdown
 * @returns {TableDocumentChange} 変更
 */
export function buildTableInsertionChange(
	state: EditorState,
	position: number,
	markdown: string,
): TableDocumentChange {
	const at     = Math.min(Math.max(0, position), state.doc.length);
	const before = at > 0 && state.doc.sliceString(at - 1, at) !== '\n' ? '\n' : '';
	const after  = at < state.doc.length && state.doc.sliceString(at, at + 1) !== '\n' ? '\n' : '';
	return { from: at, to: at, insert: `${before}${markdown}${after}` };
}

/** @param {EditorState} state 状態 @param {TableData} data 表 @returns {TableSourceModel} ソースモデル */
function extractTableSourceModel(state: EditorState, data: TableData): TableSourceModel {
	const columnCount = Math.max(data.headerSources.length, ...data.rowSources.map((row) => row.length), 1);
	const header      = normalizeCells(data.headerSources.map((source) => source.text), columnCount);
	const rows        = data.rowSources.map((row) => normalizeCells(row.map((source) => source.text), columnCount));
	const headerLine  = data.headerSources[0] ? state.doc.lineAt(data.headerSources[0].from) : state.doc.lineAt(data.tableFrom);
	const delimiter   = headerLine.number < state.doc.lines
		? normalizeDelimiter(parseSimpleTableRow(state.doc.line(headerLine.number + 1).text), columnCount)
		: Array.from({ length: columnCount }, () => '---');
	const layout      = readTableLayout(data);
	if (header.length > 0) {
		header[0] = stripTableLayout(header[0]!);
	}
	return { header, delimiter, rows, widths: layout.widths, heights: layout.heights };
}

/** @param {TableSourceModel} model モデル @returns {void} */
function restoreTableLayout(model: TableSourceModel): void {
	if (model.header.length === 0) {
		return;
	}
	const parsed    = parseCellSpan(model.header[0]!);
	model.header[0] = formatCellSpan(
		parsed.text,
		parsed.colspan,
		parsed.rowspan,
		parsed.align,
		parsed.valign,
		model.widths ?? [],
		model.heights ?? [],
	);
}

/** @param {string} source セル @returns {string} レイアウト属性を除いたセル */
function stripTableLayout(source: string): string {
	const parsed = parseCellSpan(source);
	return formatCellSpan(parsed.text, parsed.colspan, parsed.rowspan, parsed.align, parsed.valign);
}

/**
 *
 */
function applyRowAction(
	model: TableSourceModel,
	groups: TableStructureRange[],
	selection: TableStructureSelection,
	action: TableStructureAction,
	firstGroup: number,
	lastGroup: number,
): void {
	const start = selection.start - 1;
	const count = selection.end - selection.start + 1;
	/**
	 *
	 */
	const blank = (): string[] => Array.from({ length: model.header.length }, () => '');
	if (action === 'insert-before' || action === 'insert-after') {
		const at = action === 'insert-before' ? start : start + count;
		model.rows.splice(at, 0, ...Array.from({ length: count }, blank));
		if (model.heights) model.heights.splice(at + 1, 0, ...Array.from({ length: count }, () => 0));
		return;
	}
	if (action === 'delete') {
		model.rows.splice(start, count);
		if (model.heights) model.heights.splice(start + 1, count);
		return;
	}
	const adjacent      = action === 'move-previous' ? groups[firstGroup - 1]! : groups[lastGroup + 1]!;
	const adjacentStart = adjacent.start - 1;
	const adjacentCount = adjacent.end - adjacent.start + 1;
	moveArrayBlock(model.rows, start, count, adjacentStart, adjacentCount, action);
	if (model.heights) {
		const dataHeights = model.heights.slice(1);
		moveArrayBlock(dataHeights, start, count, adjacentStart, adjacentCount, action);
		model.heights = [model.heights[0] ?? 0, ...dataHeights];
	}
}

/**
 *
 */
function applyColumnAction(
	model: TableSourceModel,
	groups: TableStructureRange[],
	selection: TableStructureSelection,
	action: TableStructureAction,
	firstGroup: number,
	lastGroup: number,
): void {
	const start  = selection.start;
	const count  = selection.end - selection.start + 1;
	const arrays = [model.header, model.delimiter, ...model.rows];
	if (action === 'insert-before' || action === 'insert-after') {
		const at = action === 'insert-before' ? start : start + count;
		arrays.forEach((row, index) => row.splice(at, 0, ...Array.from({ length: count }, () => index === 1 ? '---' : '')));
		if (model.widths) model.widths.splice(at, 0, ...Array.from({ length: count }, () => 0));
		return;
	}
	if (action === 'delete') {
		arrays.forEach((row) => row.splice(start, count));
		if (model.widths) model.widths.splice(start, count);
		return;
	}
	const adjacent      = action === 'move-previous' ? groups[firstGroup - 1]! : groups[lastGroup + 1]!;
	const adjacentStart = adjacent.start;
	const adjacentCount = adjacent.end - adjacent.start + 1;
	arrays.forEach((row) => moveArrayBlock(row, start, count, adjacentStart, adjacentCount, action));
	if (model.widths) moveArrayBlock(model.widths, start, count, adjacentStart, adjacentCount, action);
}

/**
 *
 */
function moveArrayBlock<T>(
	items: T[],
	start: number,
	count: number,
	adjacentStart: number,
	adjacentCount: number,
	action: 'move-previous' | 'move-next',
): void {
	const rangeStart = Math.min(start, adjacentStart);
	const rangeCount = count + adjacentCount;
	const segment    = items.splice(rangeStart, rangeCount);
	const selected   = action === 'move-previous' ? segment.slice(adjacentCount) : segment.slice(0, count);
	const adjacent   = action === 'move-previous' ? segment.slice(0, adjacentCount) : segment.slice(count);
	items.splice(rangeStart, 0, ...(action === 'move-previous' ? [...selected, ...adjacent] : [...adjacent, ...selected]));
}

/** @param {TableSourceModel} model モデル @returns {string} Markdown */
function serializeTableSourceModel(model: TableSourceModel): string {
	return [model.header, model.delimiter, ...model.rows].map(formatTableRow).join('\n');
}

/** @param {string[]} cells セル @returns {string} 行 */
function formatTableRow(cells: string[]): string {
	return `| ${cells.join(' | ')} |`;
}

/** @param {string[]} cells セル @param {number} count 列数 @returns {string[]} 正規化 */
function normalizeCells(cells: string[], count: number): string[] {
	return Array.from({ length: count }, (_, index) => cells[index] ?? '');
}

/** @param {string[]} cells 区切り @param {number} count 列数 @returns {string[]} 正規化 */
function normalizeDelimiter(cells: string[], count: number): string[] {
	return Array.from({ length: count }, (_, index) => /^:?-{3,}:?$/u.test(cells[index]?.trim() ?? '') ? cells[index]!.trim() : '---');
}

/** @param {string} line 行 @returns {string[]} セル */
function parseSimpleTableRow(line: string): string[] {
	let source = line.trim();
	if (source.startsWith('|')) source = source.slice(1);
	if (source.endsWith('|')) source = source.slice(0, -1);
	return source.split('|').map((cell) => cell.trim());
}
