/**
 * 表セルの結合、配置、列幅、行高を読み書きし、占有グリッドと文書変更を返す
 * エディタへの dispatch は持たず、呼び出し側が変更を適用する
 * @file
 */
import type { TableCellNode, TableCellPosition, TableData, TableDocumentChange } from './tableWidget';

/** セル末尾が結合・配置・寸法の属性だけかを見る。実行中は変えない */
const CELL_ATTR_BLOCK_PATTERN = /^(?:\{(?:\s*(?:colspan|rowspan)\s*=\s*\d+|\s*align\s*=\s*(?:left|center|right|justify|start)|\s*valign\s*=\s*(?:top|middle|bottom|center|baseline)|\s*colwidths\s*=\s*[\d,]+|\s*rowheights\s*=\s*[\d,]+)+\})+$/i;
/** 属性名と値を取り出す。グローバル正規表現なので走査前に lastIndex を戻す */
const CELL_ATTR_PATTERN       = /(colspan|rowspan|align|valign|colwidths|rowheights)\s*=\s*([a-z0-9,]+)/gi;

/** セルの横位置。既定の左は属性に書かない */
export type CellAlign = 'left' | 'center' | 'right';
/** セルの縦位置。既定の上は属性に書かない */
export type CellValign = 'top' | 'middle' | 'bottom';

/** セル本文と、末尾属性から読んだ結合・配置・寸法 */
export type CellSpan = {
	/** 属性を除いたセル本文 */
	text: string;
	/** 横結合。属性が無ければ 1 */
	colspan: number;
	/** 縦結合。属性が無ければ 1 */
	rowspan: number;
	/** 横位置。属性が無ければ left */
	align: CellAlign;
	/** 縦位置。属性が無ければ top */
	valign: CellValign;
	/** 列幅（px）。未指定の列は 0 以下で、配列が空なら未設定 */
	colwidths: number[];
	/** 行高（px）。未指定は 0 以下 */
	rowheights: number[];
	/** 本文の後ろに残す空白。属性の外側 */
	suffix: string;
};

/** 表全体の列幅と行高。未設定の軸はプロパティを置かない */
export type TableSizeLayout = {
	/** 左からの列幅（px）。未設定ならプロパティ自体が無い */
	widths?: number[];
	/** 上からの行高（px）。見出し行を含む。未設定ならプロパティ自体が無い */
	heights?: number[];
};

/** セルへ書く配置の差分。指定した軸だけを変える */
export type TableAlignPatch = {
	/** 新しい横位置。未指定なら変えない */
	align?: CellAlign;
	/** 新しい縦位置。未指定なら変えない */
	valign?: CellValign;
};

/** セル選択の矩形。行と列は見出しを 0 とした両端を含む */
export type TableSelectionRect = {
	/** 矩形の上端。0 は見出し行 */
	startRow: number;
	/** 矩形の左端。0 始まり */
	startColumn: number;
	/** 矩形の下端。startRow 以上 */
	endRow: number;
	/** 矩形の右端。startColumn 以上 */
	endColumn: number;
};

/** 占有グリッドの1マス。結合で覆われたマスは原点を指す */
export type OccupancyCell = {
	/** このマスを所有するセルの行 */
	originRow: number;
	/** このマスを所有するセルの列 */
	originColumn: number;
	/** 所有セルの横結合 */
	colspan: number;
	/** 所有セルの縦結合 */
	rowspan: number;
	/** 他セルに覆われたマスなら true。原点自身は false */
	covered: boolean;
};

/** 表全体の占有。はみ出す結合は端で切ってある */
export type TableOccupancy = {
	/** 見出しを含む行数 */
	rowCount: number;
	/** 列数 */
	columnCount: number;
	/** 行、列の順のマス。範囲外参照はしない */
	cells: OccupancyCell[][];
};

/** 今の選択で結合と解除ができるかと、その矩形 */
export type TableMergeActionState = {
	/** 矩形を1セルへ結合できるなら true */
	canMerge: boolean;
	/** 矩形内の結合を解除できるなら true */
	canUnmerge: boolean;
	/** 操作対象の矩形 */
	rect: TableSelectionRect;
};

// ----------------------------------------------
// セル属性の読み書き
// ----------------------------------------------
/**
 * セル末尾の結合・配置・列幅・行高属性を読む
 * @param text - セルソース
 * @returns セル末尾の結合・配置・列幅・行高属性
 */
export function parseCellSpan(text: string): CellSpan {
	const trimmedEnd         = text.replace(/[ \t]+$/u, '');
	const trailWs            = text.slice(trimmedEnd.length);
	let rest                 = trimmedEnd;
	let suffix               = '';
	let colspan              = 1;
	let rowspan              = 1;
	let align: CellAlign     = 'left';
	let valign: CellValign   = 'top';
	let colwidths: number[]  = [];
	let rowheights: number[] = [];

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
			} else if (name === 'valign') {
				valign = normalizeCellValign(value) ?? valign;
			} else if (name === 'colwidths') {
				colwidths = parseSizeList(value);
			} else if (name === 'rowheights') {
				rowheights = parseSizeList(value);
			}

			match = CELL_ATTR_PATTERN.exec(block);
		}

		suffix = block + suffix;
		rest   = rest.slice(0, open).replace(/[ \t]+$/u, '');
	}

	return {
		text      : rest,
		colspan,
		rowspan,
		align,
		valign,
		colwidths,
		rowheights,
		suffix    : suffix + trailWs,
	};
}

/**
 * 結合・配置・列幅・行高属性をセル末尾へ付ける。既定の左詰め・上詰めと未指定の寸法は書かない
 * @param text - 本文
 * @param colspan - 列結合
 * @param rowspan - 行結合
 * @param align - 横位置。省略可
 * @param valign - 縦位置。省略可
 * @param colwidths - 列幅。省略可
 * @param rowheights - 行高。省略可
 * @returns 結合・配置・列幅・行高属性をセル末尾へ付ける。既定の左詰め・上詰めと未指定の寸法は書かない
 */
export function formatCellSpan(
	text: string,
	colspan: number,
	rowspan: number,
	align: CellAlign = 'left',
	valign: CellValign = 'top',
	colwidths: number[] = [],
	rowheights: number[] = [],
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

	const widthList  = formatSizeList(colwidths);
	const heightList = formatSizeList(rowheights);
	if (widthList) {
		parts.push(`colwidths=${widthList}`);
	}

	if (heightList) {
		parts.push(`rowheights=${heightList}`);
	}

	return parts.length === 0 ? text : `${text}{${parts.join(' ')}}`;
}

/**
 * カンマ区切りの幅・高を読む。0 以下は未指定
 * @param value - 生値
 * @returns カンマ区切りの幅・高を読む。0 以下は未指定
 */
export function parseSizeList(value: string): number[] {
	return value.split(',').map((part) => {
		const parsed = Number(part.trim());
		return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
	});
}

/**
 * 幅・高の配列を属性値にする。すべて未指定なら書かない
 * @param values - 値
 * @returns 幅・高の配列を属性値にする。すべて未指定なら書かない。無ければ null
 */
export function formatSizeList(values: number[]): string | null {
	if (values.length === 0 || values.every((value) => value <= 0)) {
		return null;
	}

	return values.map((value) => (value > 0 ? String(Math.round(value)) : '')).join(',');
}

/**
 * 見出し左上セルから列幅・行高を読む
 * @param data - 表
 * @returns 見出し左上セルから列幅・行高
 */
export function readTableLayout(data: TableData): TableSizeLayout {
	const span = parseCellSpan(data.headerSources[0]?.text ?? '');
	return {
		widths : span.colwidths.length > 0 ? [...span.colwidths] : undefined,
		heights: span.rowheights.length > 0 ? [...span.rowheights] : undefined,
	};
}

/**
 * 見出し左上セルへ列幅・行高を書く変更を返す
 * @param data - 表
 * @param layout - レイアウト
 * @returns 見出し左上セルへ列幅・行高を書く変更
 */
export function buildTableLayoutChange(
	data: TableData,
	layout: TableSizeLayout,
): TableDocumentChange | null {
	const source = data.headerSources[0];
	if (!source) {
		return null;
	}

	const parsed = parseCellSpan(source.text);
	const insert = formatCellSpan(
		parsed.text,
		parsed.colspan,
		parsed.rowspan,
		parsed.align,
		parsed.valign,
		layout.widths ?? [],
		layout.heights ?? [],
	);
	if (insert === source.text) {
		return null;
	}

	return { from: source.from, to: source.to, insert };
}

/**
 * 配置用 CSS クラスを返す。既定は空
 * @param span - 配置
 * @returns 配置用 CSS クラスを返す。既定は空
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
 * 横位置の別名を正規化する
 * @param value - 生値
 * @returns 正規化した横位置の別名
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
 * 縦位置の別名を正規化する
 * @param value - 生値
 * @returns 正規化した縦位置の別名
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
 * 表データの論理行数を返す（見出し行を含む）
 * @param data - 表
 * @returns 表データの論理行数を返す（見出し行を含む）
 */
export function getTableRowCount(data: TableData): number {
	return 1 + data.rowSources.length;
}

/**
 * 指定マスのセルソース文字列を返す
 * @param data - 表
 * @param position - 位置
 * @returns 指定マスのセルソース文字列
 */
export function getTableCellText(data: TableData, position: TableCellPosition): string {
	if (position.row === 0) {
		return data.headerSources[position.column]?.text ?? '';
	}

	return data.rowSources[position.row - 1]?.[position.column]?.text ?? '';
}

// ----------------------------------------------
// 占有グリッド
// ----------------------------------------------
/**
 * 占有グリッドを組み立てる。はみ出す結合は表の端で切る
 * @param data - 表
 * @param readText - セル文字列。省略可
 * @returns 占有グリッドを組み立てる。はみ出す結合は表の端で切る
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
 * マスが他セルに覆われているか
 * @param occupancy - 占有
 * @param position - 位置
 * @returns マスが他セルに覆われているかなら true
 */
export function isCoveredTableCell(occupancy: TableOccupancy, position: TableCellPosition): boolean {
	return occupancy.cells[position.row]?.[position.column]?.covered === true;
}

/**
 * 表示上の原点位置を返す
 * @param occupancy - 占有
 * @param position - 位置
 * @returns 表示上の原点位置
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
 * 選択範囲を正規化する
 * @param anchor - 始点
 * @param focus - 終点
 * @returns 正規化した選択範囲
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

/**
 * 結合用の矩形として塗る範囲か。1セルだけの選択は編集ハイライトと重なるので塗らない
 * @param rect - 矩形
 * @returns 結合用の矩形として塗る範囲か。1セルだけの選択は編集ハイライトと重なるので塗らないなら true
 */
export function isMultiCellTableSelectionRect(rect: TableSelectionRect): boolean {
	return rect.startRow !== rect.endRow || rect.startColumn !== rect.endColumn;
}

/** セルが選択に入るかと、選択外周のどの辺に乗るか */
export type TableCellSelectionEdges = {
	/** 選択矩形に入るなら true */
	selected: boolean;
	/** 選択の上辺なら true */
	north: boolean;
	/** 選択の下辺なら true */
	south: boolean;
	/** 選択の右辺なら true */
	east: boolean;
	/** 選択の左辺なら true */
	west: boolean;
};

/**
 * セルが選択範囲に入るかと、範囲外周のどの辺かを返す
 * @param origin - セル原点
 * @param rowSpan - 行結合
 * @param colSpan - 列結合
 * @param rect - 選択矩形
 * @returns セルが選択範囲に入るかと、範囲外周のどの辺か
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
 * 矩形内のマスを列挙する
 * @param rect - 矩形
 * @returns 矩形内のマスを列挙する
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
 * 結合／解除の可否を返す
 * @param data - 表
 * @param rect - 選択
 * @returns 結合／解除の可否
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

// ----------------------------------------------
// 結合と配置の文書変更
// ----------------------------------------------
/**
 * セル結合の文書変更を返す
 * @param data - 表
 * @param rect - 選択
 * @returns セル結合の文書変更
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
		insert: formatCellSpan(
			parsed.text,
			colspan,
			rowspan,
			parsed.align,
			parsed.valign,
			parsed.colwidths,
			parsed.rowheights,
		),
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
 * 結合解除の文書変更を返す
 * @param data - 表
 * @param rect - 選択
 * @returns 結合解除の文書変更
 */
export function buildUnmergeTableCellsChanges(
	data: TableData,
	rect: TableSelectionRect,
): TableDocumentChange[] | null {
	const occupancy                      = buildTableOccupancy(data);
	const clamped                        = clampSelectionRect(rect, occupancy);
	const seen                           = new Set<string>();
	const changes: TableDocumentChange[] = [];

	/**
	 * セルソース末尾の結合属性だけを外す
	 * @param position - 位置
	 */
	const consider = (position: { row: number; column: number }): void => {
		const key = `${position.row}:${position.column}`;
		if (seen.has(key)) {
			return;
		}

		seen.add(key);
		const source = getCellSource(data, position);
		if (!source) {
			return;
		}

		const parsed = parseCellSpan(source.text);
		if (parsed.colspan <= 1 && parsed.rowspan <= 1) {
			return;
		}

		const next = formatCellSpan(
			parsed.text,
			1,
			1,
			parsed.align,
			parsed.valign,
			parsed.colwidths,
			parsed.rowheights,
		);
		if (next !== source.text) {
			changes.push({ from: source.from, to: source.to, insert: next });
		}
	};

	consider({ row: clamped.startRow, column: clamped.startColumn });
	for (const position of listTableSelectionCells(clamped)) {
		consider(getTableCellOrigin(occupancy, position));
		consider(position);
	}

	return changes.length > 0 ? sortChangesDescending(changes) : null;
}

/**
 * 選択範囲の原点セルへ配置を書く変更を返す
 * @param data - 表
 * @param rect - 選択
 * @param patch - 変更する配置
 * @returns 選択範囲の原点セルへ配置を書く変更
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
			parsed.colwidths,
			parsed.rowheights,
		);
		if (insert !== source.text) {
			changes.push({ from: source.from, to: source.to, insert });
		}
	}

	return changes.length > 0 ? sortChangesDescending(changes) : null;
}

/**
 * 表示用 AST から末尾の結合・配置属性を除く
 * @param nodes - セル AST
 * @param sourceText - セルソース
 * @returns 表示用 AST から末尾の結合・配置属性を除く
 */
export function stripCellSpanFromNodes(nodes: TableCellNode[], sourceText: string): TableCellNode[] {
	const suffix = parseCellSpan(sourceText).suffix.trim();
	if (!suffix) {
		return nodes;
	}

	return trimNodesSuffix(nodes, suffix);
}

/**
 * 横移動は覆われているマスを飛ばし、縦移動は覆いの原点へ入る隣接セルを返す
 * @param data - 表
 * @param position - 現在位置
 * @param direction - 方向
 * @returns 横移動は覆われているマスを飛ばし、縦移動は覆いの原点へ入る隣接セル
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
		return findVerticalAdjacentCell(occupancy, origin, position.column, 1);
	}

	return findVerticalAdjacentCell(occupancy, origin, position.column, -1);
}

/**
 * 結合／解除の対象矩形を決める。複数セル選択を優先し、1セルなら結合全体へ広げる
 * @param data - 表
 * @param selected - ドラッグ選択
 * @param clicked - クリック位置
 * @returns 結合／解除の対象矩形を決める。複数セル選択を優先し、1セルなら結合全体へ広げる。無ければ null
 */
export function resolveTableMergeRect(
	data: TableData,
	selected: TableSelectionRect | null,
	clicked: TableCellPosition | null,
): TableSelectionRect | null {
	if (selected && isMultiCellTableSelectionRect(selected)) {
		return selected;
	}

	const position = clicked ?? (selected
		? { row: selected.startRow, column: selected.startColumn }
		: null);
	if (!position) {
		return null;
	}

	const occupancy = buildTableOccupancy(data);
	const origin    = getTableCellOrigin(occupancy, position);
	const cell      = occupancy.cells[origin.row]?.[origin.column];
	if (cell && (cell.colspan > 1 || cell.rowspan > 1)) {
		return {
			startRow   : origin.row,
			startColumn: origin.column,
			endRow     : origin.row + cell.rowspan - 1,
			endColumn  : origin.column + cell.colspan - 1,
		};
	}

	return normalizeTableSelectionRect(origin, origin);
}

/**
 * 表示上の位置から、文書上のセルソースを返す
 * @param data - セルソースを持つ表
 * @param position - 見出し行を 0 とした位置
 * @returns その位置のソース。範囲外なら null
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
 * 選択矩形を、表の端の内側へ収める
 * @param rect - 収める前の矩形
 * @param occupancy - 行数と列数の上限に使う占有
 * @returns 端に収めた矩形
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
 * 文書変更を、後ろの位置から適用できる順に並べる
 * 前の置換で後ろの位置がずれないようにする
 * @param changes - 並べ替える変更。配列自体は変えない
 * @returns from の降順
 */
function sortChangesDescending(changes: TableDocumentChange[]): TableDocumentChange[] {
	return [...changes].sort((left, right) => right.from - left.from || right.to - left.to);
}

/**
 * 縦方向は覆われているマスの原点へ入る。同じ結合の中は飛ばす
 * @param occupancy - 占有
 * @param origin - 現在の原点
 * @param preferredColumn - 着地したい列
 * @param step - 進み
 * @returns 縦方向は覆われているマスの原点へ入る。同じ結合の中は飛ばす。無ければ null
 */
function findVerticalAdjacentCell(
	occupancy: TableOccupancy,
	origin: TableCellPosition,
	preferredColumn: number,
	step: 1 | -1,
): TableCellPosition | null {
	const originCell = occupancy.cells[origin.row]?.[origin.column];
	const column     = Math.min(
		Math.max(0, preferredColumn),
		Math.max(0, occupancy.columnCount - 1),
	);
	let row          = step === 1
		? origin.row + (originCell?.rowspan ?? 1)
		: origin.row - 1;
	while (row >= 0 && row < occupancy.rowCount) {
		const cell = occupancy.cells[row]?.[column];
		if (cell) {
			const landed = { row: cell.originRow, column: cell.originColumn };
			if (landed.row !== origin.row || landed.column !== origin.column) {
				return landed;
			}
		}

		row += step;
	}

	return null;
}

/**
 * 覆われていない隣のセルを、指定方向へ探す
 * @param occupancy - 覆いを判定する占有グリッド
 * @param row - 探索を始める行。見出しを 0 とする
 * @param column - 探索を始める列
 * @param step - 行方向の進み。正は下、負は上
 * @param wrapRow - 行端で隣の行へ折り返すなら true
 * @returns 見えるセル。見つからなければ null
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
 * 表示用ノードの末尾から、属性として付いた文字列を除く
 * @param nodes - セルの表示ノード
 * @param suffix - 除く末尾文字列。空ならノードをそのまま返す
 * @returns 末尾を除いたノード。元の配列は変えない
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
 * @param node - ノード
 * @returns 子を持つ表セルノードなら true
 */
function nodeHasChildren(node: TableCellNode): node is TableCellNode & { children: TableCellNode[] } {
	return node.kind !== 'text' && node.kind !== 'br' && node.kind !== 'image';
}

/**
 * 表セルの表示ノードを、子も含めて複製する
 * @param node - 複製するノード。元は変えない
 * @returns 新しいノード。葉はそのまま写す
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
 * 表示ノードを、子の文字も含めたプレーンテキストにする
 * 改行は改行文字、画像は空にする
 * @param node - 平坦化するノード
 * @returns 連結した文字
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
