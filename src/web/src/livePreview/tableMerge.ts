import type { TableCellNode, TableCellPosition, TableData, TableDocumentChange } from './tableWidget';

const CELL_ATTR_BLOCK_PATTERN = /^(?:\{(?:\s*(?:colspan|rowspan)\s*=\s*\d+|\s*align\s*=\s*(?:left|center|right|justify|start)|\s*valign\s*=\s*(?:top|middle|bottom|center|baseline))+\})+$/i;
const CELL_ATTR_PATTERN       = /(colspan|rowspan|align|valign)\s*=\s*([a-z0-9]+)/gi;

export type CellAlign = 'left' | 'center' | 'right';
export type CellValign = 'top' | 'middle' | 'bottom';

export type CellSpan = {
	text: string;
	colspan: number;
	rowspan: number;
	align: CellAlign;
	valign: CellValign;
	suffix: string;
};

export type TableAlignPatch = {
	align?: CellAlign;
	valign?: CellValign;
};

export type TableSelectionRect = {
	startRow: number;
	startColumn: number;
	endRow: number;
	endColumn: number;
};

export type OccupancyCell = {
	originRow: number;
	originColumn: number;
	colspan: number;
	rowspan: number;
	covered: boolean;
};

export type TableOccupancy = {
	rowCount: number;
	columnCount: number;
	cells: OccupancyCell[][];
};

export type TableMergeActionState = {
	canMerge: boolean;
	canUnmerge: boolean;
	rect: TableSelectionRect;
};

/**
 * セル末尾の結合・配置属性を読む。
 * @param {string} text セルソース
 * @returns {CellSpan}
 */
export function parseCellSpan(text: string): CellSpan {
	const trimmedEnd       = text.replace(/[ \t]+$/u, '');
	const trailWs          = text.slice(trimmedEnd.length);
	let rest               = trimmedEnd;
	let suffix             = '';
	let colspan            = 1;
	let rowspan            = 1;
	let align: CellAlign   = 'left';
	let valign: CellValign = 'top';

	while (rest.length > 0) {
		const close = rest.lastIndexOf('}');
		if (close !== rest.length - 1) {
			break;
		}

		const open = rest.lastIndexOf('{');
		if (open < 0) {
			break;
		}

		const block = rest.slice(open);
		if (!CELL_ATTR_BLOCK_PATTERN.test(block)) {
			break;
		}

		CELL_ATTR_PATTERN.lastIndex       = 0;
		let match: RegExpExecArray | null = CELL_ATTR_PATTERN.exec(block);
		while (match) {
			const name  = (match[1] ?? '').toLowerCase();
			const value = match[2] ?? '';
			if (name === 'colspan') {
				colspan = Math.max(1, Number(value));
			} else if (name === 'rowspan') {
				rowspan = Math.max(1, Number(value));
			} else if (name === 'align') {
				align = normalizeCellAlign(value) ?? align;
			} else {
				valign = normalizeCellValign(value) ?? valign;
			}

			match = CELL_ATTR_PATTERN.exec(block);
		}

		suffix = block + suffix;
		rest   = rest.slice(0, open).replace(/[ \t]+$/u, '');
	}

	return {
		text   : rest,
		colspan,
		rowspan,
		align,
		valign,
		suffix : suffix + trailWs,
	};
}

/**
 * 結合・配置属性をセル末尾へ付ける。既定の左詰め・上詰めは書かない。
 * @param {string} text 本文
 * @param {number} colspan 列結合
 * @param {number} rowspan 行結合
 * @param {CellAlign} [align] 横位置
 * @param {CellValign} [valign] 縦位置
 * @returns {string}
 */
export function formatCellSpan(
	text: string,
	colspan: number,
	rowspan: number,
	align: CellAlign = 'left',
	valign: CellValign = 'top',
): string {
	const cols            = Math.max(1, Math.floor(colspan));
	const rows            = Math.max(1, Math.floor(rowspan));
	const parts: string[] = [];
	if (cols > 1) {
		parts.push(`colspan=${cols}`);
	}

	if (rows > 1) {
		parts.push(`rowspan=${rows}`);
	}

	if (align !== 'left') {
		parts.push(`align=${align}`);
	}

	if (valign !== 'top') {
		parts.push(`valign=${valign}`);
	}

	return parts.length === 0 ? text : `${text}{${parts.join(' ')}}`;
}

/**
 * 配置用 CSS クラスを返す。既定は空。
 * @param {Pick<CellSpan, 'align' | 'valign'>} span 配置
 * @returns {string}
 */
export function cellAlignmentClassNames(span: Pick<CellSpan, 'align' | 'valign'>): string {
	const parts: string[] = [];
	if (span.align !== 'left') {
		parts.push(`cm-md-table-align-${span.align}`);
	}

	if (span.valign !== 'top') {
		parts.push(`cm-md-table-valign-${span.valign}`);
	}

	return parts.join(' ');
}

/**
 * 横位置の別名を正規化する。
 * @param {string} value 生値
 * @returns {CellAlign | null}
 */
export function normalizeCellAlign(value: string): CellAlign | null {
	const lower = value.trim().toLowerCase();
	if (lower === 'center') {
		return 'center';
	}

	if (lower === 'right' || lower === 'end') {
		return 'right';
	}

	if (lower === 'left' || lower === 'justify' || lower === 'start') {
		return 'left';
	}

	return null;
}

/**
 * 縦位置の別名を正規化する。
 * @param {string} value 生値
 * @returns {CellValign | null}
 */
export function normalizeCellValign(value: string): CellValign | null {
	const lower = value.trim().toLowerCase();
	if (lower === 'middle' || lower === 'center') {
		return 'middle';
	}

	if (lower === 'bottom') {
		return 'bottom';
	}

	if (lower === 'top' || lower === 'baseline') {
		return 'top';
	}

	return null;
}

/**
 * 表データの論理行数を返す（見出し行を含む）。
 * @param {TableData} data 表
 * @returns {number}
 */
export function getTableRowCount(data: TableData): number {
	return 1 + data.rowSources.length;
}

/**
 * 指定マスのセルソース文字列を返す。
 * @param {TableData} data 表
 * @param {TableCellPosition} position 位置
 * @returns {string}
 */
export function getTableCellText(data: TableData, position: TableCellPosition): string {
	if (position.row === 0) {
		return data.headerSources[position.column]?.text ?? '';
	}

	return data.rowSources[position.row - 1]?.[position.column]?.text ?? '';
}

/**
 * 占有グリッドを組み立てる。はみ出す結合は表の端で切る。
 * @param {TableData} data 表
 * @param {(row: number, column: number) => string} [readText] セル文字列
 * @returns {TableOccupancy}
 */
export function buildTableOccupancy(
	data: TableData,
	readText: (row: number, column: number) => string = (row, column) => getTableCellText(data, { row, column }),
): TableOccupancy {
	const rowCount                 = getTableRowCount(data);
	const columnCount              = Math.max(
		data.headerSources.length,
		...data.rowSources.map((row) => row.length),
		0,
	);
	const cells: OccupancyCell[][] = [];
	for (let row = 0; row < rowCount; row += 1) {
		const line: OccupancyCell[] = [];
		for (let column = 0; column < columnCount; column += 1) {
			line.push({
				originRow   : row,
				originColumn: column,
				colspan     : 1,
				rowspan     : 1,
				covered     : false,
			});
		}

		cells.push(line);
	}

	for (let row = 0; row < rowCount; row += 1) {
		for (let column = 0; column < columnCount; column += 1) {
			if (cells[row]![column]!.covered) {
				continue;
			}

			const span    = parseCellSpan(readText(row, column));
			const colspan = Math.min(Math.max(1, span.colspan), columnCount - column);
			const rowspan = Math.min(Math.max(1, span.rowspan), rowCount - row);
			for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
				for (let colOffset = 0; colOffset < colspan; colOffset += 1) {
					const target        = cells[row + rowOffset]![column + colOffset]!;
					target.originRow    = row;
					target.originColumn = column;
					target.colspan      = colspan;
					target.rowspan      = rowspan;
					target.covered      = rowOffset > 0 || colOffset > 0;
				}
			}
		}
	}

	return { rowCount, columnCount, cells };
}

/**
 * マスが他セルに覆われているか。
 * @param {TableOccupancy} occupancy 占有
 * @param {TableCellPosition} position 位置
 * @returns {boolean}
 */
export function isCoveredTableCell(occupancy: TableOccupancy, position: TableCellPosition): boolean {
	return occupancy.cells[position.row]?.[position.column]?.covered === true;
}

/**
 * 表示上の原点位置を返す。
 * @param {TableOccupancy} occupancy 占有
 * @param {TableCellPosition} position 位置
 * @returns {TableCellPosition}
 */
export function getTableCellOrigin(
	occupancy: TableOccupancy,
	position: TableCellPosition,
): TableCellPosition {
	const cell = occupancy.cells[position.row]?.[position.column];
	if (!cell) {
		return position;
	}

	return { row: cell.originRow, column: cell.originColumn };
}

/**
 * 選択範囲を正規化する。
 * @param {TableCellPosition} anchor 始点
 * @param {TableCellPosition} focus 終点
 * @returns {TableSelectionRect}
 */
export function normalizeTableSelectionRect(
	anchor: TableCellPosition,
	focus: TableCellPosition,
): TableSelectionRect {
	return {
		startRow   : Math.min(anchor.row, focus.row),
		startColumn: Math.min(anchor.column, focus.column),
		endRow     : Math.max(anchor.row, focus.row),
		endColumn  : Math.max(anchor.column, focus.column),
	};
}

export type TableCellSelectionEdges = {
	selected: boolean;
	north: boolean;
	south: boolean;
	east: boolean;
	west: boolean;
};

/**
 * セルが選択範囲に入るかと、範囲外周のどの辺かを返す。
 * @param {TableCellPosition} origin セル原点
 * @param {number} rowSpan 行結合
 * @param {number} colSpan 列結合
 * @param {TableSelectionRect} rect 選択矩形
 * @returns {TableCellSelectionEdges}
 */
export function describeTableCellSelection(
	origin: TableCellPosition,
	rowSpan: number,
	colSpan: number,
	rect: TableSelectionRect,
): TableCellSelectionEdges {
	const safeRowSpan  = Math.max(1, rowSpan);
	const safeColSpan  = Math.max(1, colSpan);
	const occupyEndRow = origin.row + safeRowSpan - 1;
	const occupyEndCol = origin.column + safeColSpan - 1;
	const selected     = origin.row >= rect.startRow
		&& origin.row <= rect.endRow
		&& origin.column >= rect.startColumn
		&& origin.column <= rect.endColumn;
	if (!selected) {
		return {
			selected: false,
			north   : false,
			south   : false,
			east    : false,
			west    : false,
		};
	}

	return {
		selected: true,
		north   : origin.row === rect.startRow,
		south   : occupyEndRow === rect.endRow,
		east    : occupyEndCol === rect.endColumn,
		west    : origin.column === rect.startColumn,
	};
}

/**
 * 矩形内のマスを列挙する。
 * @param {TableSelectionRect} rect 矩形
 * @returns {TableCellPosition[]}
 */
export function listTableSelectionCells(rect: TableSelectionRect): TableCellPosition[] {
	const cells: TableCellPosition[] = [];
	for (let row = rect.startRow; row <= rect.endRow; row += 1) {
		for (let column = rect.startColumn; column <= rect.endColumn; column += 1) {
			cells.push({ row, column });
		}
	}

	return cells;
}

/**
 * 結合／解除の可否を返す。
 * @param {TableData} data 表
 * @param {TableSelectionRect} rect 選択
 * @returns {TableMergeActionState}
 */
export function getTableMergeActionState(
	data: TableData,
	rect: TableSelectionRect,
): TableMergeActionState {
	const occupancy = buildTableOccupancy(data);
	const clamped   = clampSelectionRect(rect, occupancy);
	const width     = clamped.endColumn - clamped.startColumn + 1;
	const height    = clamped.endRow - clamped.startRow + 1;
	const cells     = listTableSelectionCells(clamped);
	const canMerge  = (width > 1 || height > 1)
		&& cells.every((position) => {
			const cell = occupancy.cells[position.row]?.[position.column];
			return cell !== undefined && !cell.covered && cell.colspan === 1 && cell.rowspan === 1;
		});
	const canUnmerge = cells.some((position) => {
		const cell = occupancy.cells[position.row]?.[position.column];
		return cell !== undefined && !cell.covered && (cell.colspan > 1 || cell.rowspan > 1);
	});

	return { canMerge, canUnmerge, rect: clamped };
}

/**
 * セル結合の文書変更を返す。
 * @param {TableData} data 表
 * @param {TableSelectionRect} rect 選択
 * @returns {TableDocumentChange[] | null}
 */
export function buildMergeTableCellsChanges(
	data: TableData,
	rect: TableSelectionRect,
): TableDocumentChange[] | null {
	const state = getTableMergeActionState(data, rect);
	if (!state.canMerge) {
		return null;
	}

	const origin = { row: state.rect.startRow, column: state.rect.startColumn };
	const source = getCellSource(data, origin);
	if (!source) {
		return null;
	}

	const parsed                         = parseCellSpan(source.text);
	const colspan                        = state.rect.endColumn - state.rect.startColumn + 1;
	const rowspan                        = state.rect.endRow - state.rect.startRow + 1;
	const changes: TableDocumentChange[] = [{
		from  : source.from,
		to    : source.to,
		insert: formatCellSpan(parsed.text, colspan, rowspan, parsed.align, parsed.valign),
	}];

	for (const position of listTableSelectionCells(state.rect)) {
		if (position.row === origin.row && position.column === origin.column) {
			continue;
		}

		const other = getCellSource(data, position);
		if (other && other.text.length > 0) {
			changes.push({ from: other.from, to: other.to, insert: '' });
		}
	}

	return sortChangesDescending(changes);
}

/**
 * 結合解除の文書変更を返す。
 * @param {TableData} data 表
 * @param {TableSelectionRect} rect 選択
 * @returns {TableDocumentChange[] | null}
 */
export function buildUnmergeTableCellsChanges(
	data: TableData,
	rect: TableSelectionRect,
): TableDocumentChange[] | null {
	const state = getTableMergeActionState(data, rect);
	if (!state.canUnmerge) {
		return null;
	}

	const occupancy                      = buildTableOccupancy(data);
	const seen                           = new Set<string>();
	const changes: TableDocumentChange[] = [];
	for (const position of listTableSelectionCells(state.rect)) {
		const cell = occupancy.cells[position.row]?.[position.column];
		if (!cell || cell.covered || (cell.colspan <= 1 && cell.rowspan <= 1)) {
			continue;
		}

		const key = `${cell.originRow}:${cell.originColumn}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		const source = getCellSource(data, { row: cell.originRow, column: cell.originColumn });
		if (!source) {
			continue;
		}

		const parsed = parseCellSpan(source.text);
		const next   = formatCellSpan(parsed.text, 1, 1, parsed.align, parsed.valign);
		if (next !== source.text) {
			changes.push({ from: source.from, to: source.to, insert: next });
		}
	}

	return changes.length > 0 ? sortChangesDescending(changes) : null;
}

/**
 * 選択範囲の原点セルへ配置を書く変更を返す。
 * @param {TableData} data 表
 * @param {TableSelectionRect} rect 選択
 * @param {TableAlignPatch} patch 変更する配置
 * @returns {TableDocumentChange[] | null}
 */
export function buildAlignTableCellsChanges(
	data: TableData,
	rect: TableSelectionRect,
	patch: TableAlignPatch,
): TableDocumentChange[] | null {
	if (patch.align === undefined && patch.valign === undefined) {
		return null;
	}

	const occupancy                      = buildTableOccupancy(data);
	const clamped                        = clampSelectionRect(rect, occupancy);
	const seen                           = new Set<string>();
	const changes: TableDocumentChange[] = [];
	for (const position of listTableSelectionCells(clamped)) {
		const origin = getTableCellOrigin(occupancy, position);
		const key    = `${origin.row}:${origin.column}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		const source = getCellSource(data, origin);
		if (!source) {
			continue;
		}

		const parsed = parseCellSpan(source.text);
		const insert = formatCellSpan(
			parsed.text,
			parsed.colspan,
			parsed.rowspan,
			patch.align ?? parsed.align,
			patch.valign ?? parsed.valign,
		);
		if (insert !== source.text) {
			changes.push({ from: source.from, to: source.to, insert });
		}
	}

	return changes.length > 0 ? sortChangesDescending(changes) : null;
}

/**
 * 表示用 AST から末尾の結合・配置属性を除く。
 * @param {TableCellNode[]} nodes セル AST
 * @param {string} sourceText セルソース
 * @returns {TableCellNode[]}
 */
export function stripCellSpanFromNodes(nodes: TableCellNode[], sourceText: string): TableCellNode[] {
	const suffix = parseCellSpan(sourceText).suffix.trim();
	if (!suffix) {
		return nodes;
	}

	return trimNodesSuffix(nodes, suffix);
}

/**
 * 覆われているマスを飛ばした隣接セルを返す。
 * @param {TableData} data 表
 * @param {TableCellPosition} position 現在位置
 * @param {'next' | 'previous' | 'up' | 'down'} direction 方向
 * @returns {TableCellPosition | null}
 */
export function getVisibleAdjacentTableCellPosition(
	data: TableData,
	position: TableCellPosition,
	direction: 'next' | 'previous' | 'up' | 'down',
): TableCellPosition | null {
	const occupancy = buildTableOccupancy(data);
	if (occupancy.columnCount === 0 || occupancy.rowCount === 0) {
		return null;
	}

	const origin = getTableCellOrigin(occupancy, position);
	const cell   = occupancy.cells[origin.row]?.[origin.column];
	if (!cell) {
		return null;
	}

	if (direction === 'next') {
		return findVisibleCell(
			occupancy,
			origin.row,
			origin.column + cell.colspan,
			1,
			true,
		);
	}

	if (direction === 'previous') {
		return findVisibleCell(
			occupancy,
			origin.row,
			origin.column - 1,
			-1,
			true,
		);
	}

	if (direction === 'down') {
		return findVisibleCell(
			occupancy,
			origin.row + cell.rowspan,
			origin.column,
			1,
			false,
		);
	}

	return findVisibleCell(
		occupancy,
		origin.row - 1,
		origin.column,
		-1,
		false,
	);
}

/**
 * @param {TableData} data 表
 * @param {TableCellPosition} position 位置
 * @returns {{ from: number; to: number; text: string } | null}
 */
function getCellSource(
	data: TableData,
	position: TableCellPosition,
): { from: number; to: number; text: string } | null {
	if (position.row === 0) {
		return data.headerSources[position.column] ?? null;
	}

	return data.rowSources[position.row - 1]?.[position.column] ?? null;
}

/**
 * @param {TableSelectionRect} rect 矩形
 * @param {TableOccupancy} occupancy 占有
 * @returns {TableSelectionRect}
 */
function clampSelectionRect(rect: TableSelectionRect, occupancy: TableOccupancy): TableSelectionRect {
	const lastRow    = Math.max(0, occupancy.rowCount - 1);
	const lastColumn = Math.max(0, occupancy.columnCount - 1);
	return {
		startRow   : Math.min(Math.max(0, rect.startRow), lastRow),
		startColumn: Math.min(Math.max(0, rect.startColumn), lastColumn),
		endRow     : Math.min(Math.max(0, rect.endRow), lastRow),
		endColumn  : Math.min(Math.max(0, rect.endColumn), lastColumn),
	};
}

/**
 * @param {TableDocumentChange[]} changes 変更
 * @returns {TableDocumentChange[]}
 */
function sortChangesDescending(changes: TableDocumentChange[]): TableDocumentChange[] {
	return [...changes].sort((left, right) => right.from - left.from || right.to - left.to);
}

/**
 * @param {TableOccupancy} occupancy 占有
 * @param {number} row 行
 * @param {number} column 列
 * @param {1 | -1} step 進み
 * @param {boolean} wrapRow 行を折り返すか
 * @returns {TableCellPosition | null}
 */
function findVisibleCell(
	occupancy: TableOccupancy,
	row: number,
	column: number,
	step: 1 | -1,
	wrapRow: boolean,
): TableCellPosition | null {
	let nextRow    = row;
	let nextColumn = column;
	while (nextRow >= 0 && nextRow < occupancy.rowCount) {
		if (wrapRow) {
			if (nextColumn >= occupancy.columnCount) {
				nextRow   += 1;
				nextColumn = 0;
				continue;
			}

			if (nextColumn < 0) {
				nextRow   -= 1;
				nextColumn = occupancy.columnCount - 1;
				continue;
			}
		} else if (nextColumn < 0 || nextColumn >= occupancy.columnCount) {
			return null;
		}

		const cell = occupancy.cells[nextRow]?.[nextColumn];
		if (cell && !cell.covered) {
			return { row: nextRow, column: nextColumn };
		}

		if (wrapRow) {
			nextColumn += step;
		} else {
			nextRow += step;
		}
	}

	return null;
}

/**
 * @param {TableCellNode[]} nodes ノード
 * @param {string} suffix 末尾
 * @returns {TableCellNode[]}
 */
function trimNodesSuffix(nodes: TableCellNode[], suffix: string): TableCellNode[] {
	if (nodes.length === 0 || suffix.length === 0) {
		return nodes;
	}

	const cloned = nodes.map((node) => cloneTableCellNode(node));
	let remain   = suffix;
	for (let index = cloned.length - 1; index >= 0 && remain.length > 0; index -= 1) {
		const node = cloned[index]!;
		if (node.kind === 'text') {
			if (node.text.endsWith(remain)) {
				node.text = node.text.slice(0, -remain.length);
				remain    = '';
				break;
			}

			if (remain.endsWith(node.text)) {
				remain    = remain.slice(0, -node.text.length);
				node.text = '';
				continue;
			}

			break;
		}

		if (nodeHasChildren(node) && node.children.length > 0) {
			node.children   = trimNodesSuffix(node.children, remain);
			const flattened = flattenNodeText(node);
			if (flattened.endsWith(remain)) {
				remain = '';
			} else if (remain.endsWith(flattened)) {
				remain = remain.slice(0, -flattened.length);
			} else {
				break;
			}
		}
	}

	return cloned.filter((node) => node.kind !== 'text' || node.text.length > 0);
}

/**
 * @param {TableCellNode} node ノード
 * @returns {node is TableCellNode & { children: TableCellNode[] }}
 */
function nodeHasChildren(node: TableCellNode): node is TableCellNode & { children: TableCellNode[] } {
	return node.kind !== 'text' && node.kind !== 'br' && node.kind !== 'image';
}

/**
 * @param {TableCellNode} node ノード
 * @returns {TableCellNode}
 */
function cloneTableCellNode(node: TableCellNode): TableCellNode {
	if (node.kind === 'text' || node.kind === 'br' || node.kind === 'image') {
		return { ...node };
	}

	if (node.kind === 'html') {
		return {
			...node,
			attributes: { ...node.attributes },
			children  : node.children.map((child) => cloneTableCellNode(child)),
		};
	}

	if (node.kind === 'link') {
		return { ...node, children: node.children.map((child) => cloneTableCellNode(child)) };
	}

	return { ...node, children: node.children.map((child) => cloneTableCellNode(child)) };
}

/**
 * @param {TableCellNode} node ノード
 * @returns {string}
 */
function flattenNodeText(node: TableCellNode): string {
	if (node.kind === 'text') {
		return node.text;
	}

	if (node.kind === 'br' || node.kind === 'image') {
		return '';
	}

	return node.children.map((child) => flattenNodeText(child)).join('');
}
