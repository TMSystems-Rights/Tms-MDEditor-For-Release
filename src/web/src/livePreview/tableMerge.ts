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
	// 末尾の空白を除いたセル。属性ブロックはこの末尾から読む
	const trimmedEnd         = text.replace(/[ \t]+$/u, '');
	// 除いた末尾空白。属性の後ろへ戻す
	const trailWs            = text.slice(trimmedEnd.length);
	// まだ本文側に残している文字列。属性を剥がすたびに短くなる
	let rest                 = trimmedEnd;
	// 剥がした属性ブロック。後ろから足す
	let suffix               = '';
	// 列結合。属性が無ければ 1
	let colspan              = 1;
	// 行結合。属性が無ければ 1
	let rowspan              = 1;
	// 横位置。属性が無ければ左
	let align: CellAlign     = 'left';
	// 縦位置。属性が無ければ上
	let valign: CellValign   = 'top';
	// 列幅。属性が無ければ空
	let colwidths: number[]  = [];
	// 行高。属性が無ければ空
	let rowheights: number[] = [];

	while (rest.length > 0) {
		// 末尾の `}`。属性ブロックの終わり
		const close = rest.lastIndexOf('}');
		// 末尾が `}` でない文字列は、もう属性ではない
		if (close !== rest.length - 1) {
			break;
		}

		// 対応する `{`。無ければ -1
		const open = rest.lastIndexOf('{');
		// `{` が無い `}` は属性として剥がさない
		if (open < 0) {
			break;
		}

		// `{` から末尾までの候補。形が違えば本文に残す
		const block = rest.slice(open);
		// 属性の形でないブロックは本文の一部なので、ここで止める
		if (!CELL_ATTR_BLOCK_PATTERN.test(block)) {
			break;
		}

		CELL_ATTR_PATTERN.lastIndex       = 0;
		// ブロック内の最初の属性。無ければ null
		let match: RegExpExecArray | null = CELL_ATTR_PATTERN.exec(block);
		while (match) {
			// 属性名。大文字は小文字へ揃える。無名なら空
			const name  = (match[1] ?? '').toLowerCase();
			// 属性値。空でもよい
			const value = match[2] ?? '';
			// 列結合だけ colspan を更新する。1 未満にはしない
			if (name === 'colspan') {
				colspan = Math.max(1, Number(value));
				// 行結合だけ rowspan を更新する
			} else if (name === 'rowspan') {
				rowspan = Math.max(1, Number(value));
				// 知っている横位置だけ align を更新する。未知の値は残す
			} else if (name === 'align') {
				align = normalizeCellAlign(value) ?? align;
				// 知っている縦位置だけ valign を更新する。未知の値は残す
			} else if (name === 'valign') {
				valign = normalizeCellValign(value) ?? valign;
				// 列幅のリストだけ colwidths を置き換える
			} else if (name === 'colwidths') {
				colwidths = parseSizeList(value);
				// 行高のリストだけ rowheights を置き換える
			} else if (name === 'rowheights') {
				rowheights = parseSizeList(value);
			}

			match = CELL_ATTR_PATTERN.exec(block);
		}

		suffix = block + suffix;
		rest   = rest.slice(0, open).replace(/[ \t]+$/u, '');
	}

	return {
		// 属性を除いた本文。末尾空白は suffix 側
		text: rest,
		// 列結合。無ければ 1
		colspan,
		// 行結合。無ければ 1
		rowspan,
		// 横位置。無ければ左
		align,
		// 縦位置。無ければ上
		valign,
		// 列幅。無ければ空
		colwidths,
		// 行高。無ければ空
		rowheights,
		// 剥がした属性と、元の末尾空白
		suffix: suffix + trailWs
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
export function formatCellSpan(text: string, colspan: number, rowspan: number, align: CellAlign = 'left', valign: CellValign = 'top', colwidths: number[] = [], rowheights: number[] = []): string {
	// 列結合。1 未満や小数は 1
	const cols            = Math.max(1, Math.floor(colspan));
	// 行結合。1 未満や小数は 1
	const rows            = Math.max(1, Math.floor(rowspan));
	// 書く属性。既定値は入れない
	const parts: string[] = [];
	// 2 列以上のときだけ colspan を書く
	if (cols > 1) {
		parts.push(`colspan=${cols}`);
	}

	// 2 行以上のときだけ rowspan を書く
	if (rows > 1) {
		parts.push(`rowspan=${rows}`);
	}

	// 左以外のときだけ align を書く
	if (align !== 'left') {
		parts.push(`align=${align}`);
	}

	// 上以外のときだけ valign を書く
	if (valign !== 'top') {
		parts.push(`valign=${valign}`);
	}

	// 列幅の属性値。すべて未指定なら null
	const widthList  = formatSizeList(colwidths);
	// 行高の属性値。すべて未指定なら null
	const heightList = formatSizeList(rowheights);
	// 列幅があるときだけ colwidths を書く
	if (widthList) {
		parts.push(`colwidths=${widthList}`);
	}

	// 行高があるときだけ rowheights を書く
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
		// 1 要素の数値。空や不正は NaN
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
	// 空、またはすべて 0 以下の配列は属性にしない。どちらか一方でも null
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
	// 左上セルの属性。見出しが無ければ空文字から読む
	const span = parseCellSpan(data.headerSources[0]?.text ?? '');
	// 配列があるときだけレイアウトへ移す。空はプロパティを置かない
	return {
		// 列幅。空なら undefined
		widths: span.colwidths.length > 0 ? [...span.colwidths] : undefined,
		// 行高。空なら undefined
		heights: span.rowheights.length > 0 ? [...span.rowheights] : undefined
	};
}

/**
 * 見出し左上セルへ列幅・行高を書く変更を返す
 * @param data - 表
 * @param layout - レイアウト
 * @returns 見出し左上セルへ列幅・行高を書く変更
 */
export function buildTableLayoutChange(data: TableData, layout: TableSizeLayout): TableDocumentChange | null {
	// 左上セル。見出しが無ければ変更を作らない
	const source = data.headerSources[0];
	// 見出しセルが無い表はレイアウトを書けない
	if (!source) {
		return null;
	}

	// 既存の本文、結合、配置。幅と高さだけ差し替える
	const parsed = parseCellSpan(source.text);
	// 幅と高さを書き戻したセル。他の属性は維持する
	const insert = formatCellSpan(parsed.text, parsed.colspan, parsed.rowspan, parsed.align, parsed.valign, layout.widths ?? [], layout.heights ?? []);
	// 書き戻し結果が元と同じなら文書を変えない
	if (insert === source.text) {
		return null;
	}

	// 左上セルだけを置き換える変更
	return {
		// セルの開始
		from: source.from,
		// セルの終端
		to: source.to,
		// 幅と高さを入れたセル
		insert
	};
}

/**
 * 配置用 CSS クラスを返す。既定は空
 * @param span - 配置
 * @returns 配置用 CSS クラスを返す。既定は空
 */
export function cellAlignmentClassNames(span: Pick<CellSpan, 'align' | 'valign'>): string {
	// 既定以外の配置クラス。両方既定なら空
	const parts: string[] = [];
	// 左以外の横位置だけクラスを足す
	if (span.align !== 'left') {
		parts.push(`cm-md-table-align-${span.align}`);
	}

	// 上以外の縦位置だけクラスを足す
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
	// 比較用の小文字。前後空白は除く
	const lower = value.trim().toLowerCase();
	// center だけ中央にする
	if (lower === 'center') {
		return 'center';
	}

	// right と end は右寄せ。どちらか一方でも右
	if (lower === 'right' || lower === 'end') {
		return 'right';
	}

	// left、justify、start は左寄せ。どれか一つでも左
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
	// 比較用の小文字。前後空白は除く
	const lower = value.trim().toLowerCase();
	// middle と center は縦の中央。どちらか一方でも中央
	if (lower === 'middle' || lower === 'center') {
		return 'middle';
	}

	// bottom だけ下寄せ
	if (lower === 'bottom') {
		return 'bottom';
	}

	// top と baseline は上寄せ。どちらか一方でも上
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
	// 見出し行は headerSources から取る。範囲外は空
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
export function buildTableOccupancy(data: TableData, readText: (row: number, column: number) => string = (row, column) => getTableCellText(data, { row, column })): TableOccupancy {
	// 見出しを含む行数
	const rowCount                 = getTableRowCount(data);
	// 見出しと各行の最大列数。どちらも空なら 0
	const columnCount              = Math.max(data.headerSources.length, ...data.rowSources.map((row) => row.length), 0);
	// マスごとの占有。初期は結合なし
	const cells: OccupancyCell[][] = [];
	for (let row = 0; row < rowCount; row += 1) {
		// この行の初期マス。すべて自分自身が原点
		const line: OccupancyCell[] = [];
		for (let column = 0; column < columnCount; column += 1) {
			// まだ結合を当てる前のマス。覆われていない
			line.push({
				// 初期の原点行。自分自身
				originRow: row,
				// 初期の原点列。自分自身
				originColumn: column,
				// 初期の列結合。1
				colspan: 1,
				// 初期の行結合。1
				rowspan: 1,
				// 初期は覆われていない
				covered: false
			});
		}

		cells.push(line);
	}

	for (let row = 0; row < rowCount; row += 1) {
		for (let column = 0; column < columnCount; column += 1) {
			// すでに他セルに覆われたマスは、自分の属性で上書きしない
			if (cells[row]![column]!.covered) {
				continue;
			}

			// このマスの結合属性
			const span    = parseCellSpan(readText(row, column));
			// 表の右端で切った列結合。1 未満にはしない
			const colspan = Math.min(Math.max(1, span.colspan), columnCount - column);
			// 表の下端で切った行結合。1 未満にはしない
			const rowspan = Math.min(Math.max(1, span.rowspan), rowCount - row);
			for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
				for (let colOffset = 0; colOffset < colspan; colOffset += 1) {
					// 結合が覆うマス。原点は起点セル
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

	return {
		// 見出しを含む行数
		rowCount,
		// 最大列数
		columnCount,
		// マスごとの原点と覆い
		cells
	};
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
export function getTableCellOrigin(occupancy: TableOccupancy, position: TableCellPosition): TableCellPosition {
	// この位置の占有。範囲外なら undefined
	const cell = occupancy.cells[position.row]?.[position.column];
	// 範囲外は渡された位置をそのまま原点にする
	if (!cell) {
		return position;
	}

	// 覆いの起点。覆われていなければ自分自身
	return {
		// 起点の行
		row: cell.originRow,
		// 起点の列
		column: cell.originColumn
	};
}

/**
 * 選択範囲を正規化する
 * @param anchor - 始点
 * @param focus - 終点
 * @returns 正規化した選択範囲
 */
export function normalizeTableSelectionRect(anchor: TableCellPosition, focus: TableCellPosition): TableSelectionRect {
	// 始点と終点の小さい方を開始、大きい方を終了にした矩形
	return {
		// 上端。行の小さい方
		startRow: Math.min(anchor.row, focus.row),
		// 左端。列の小さい方
		startColumn: Math.min(anchor.column, focus.column),
		// 下端。行の大きい方
		endRow: Math.max(anchor.row, focus.row),
		// 右端。列の大きい方
		endColumn: Math.max(anchor.column, focus.column)
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
export function describeTableCellSelection(origin: TableCellPosition, rowSpan: number, colSpan: number, rect: TableSelectionRect): TableCellSelectionEdges {
	// 行結合。1 未満は 1
	const safeRowSpan  = Math.max(1, rowSpan);
	// 列結合。1 未満は 1
	const safeColSpan  = Math.max(1, colSpan);
	// 結合が占める最終行
	const occupyEndRow = origin.row + safeRowSpan - 1;
	// 結合が占める最終列
	const occupyEndCol = origin.column + safeColSpan - 1;
	// 原点が選択矩形の中にあるか。どれか一つが外れても false
	const selected     = origin.row >= rect.startRow && origin.row <= rect.endRow && origin.column >= rect.startColumn && origin.column <= rect.endColumn;
	// 選択外のセルは辺も持たない
	if (!selected) {
		// 選択外。辺はすべて false
		return {
			// 選択に入らない
			selected: false,
			// 上辺ではない
			north: false,
			// 下辺ではない
			south: false,
			// 右辺ではない
			east: false,
			// 左辺ではない
			west: false
		};
	}

	// 選択内のセルと、範囲の外周に乗っている辺
	return {
		// 選択に入る
		selected: true,
		// 原点行が選択の上端
		north: origin.row === rect.startRow,
		// 結合の最終行が選択の下端
		south: occupyEndRow === rect.endRow,
		// 結合の最終列が選択の右端
		east: occupyEndCol === rect.endColumn,
		// 原点列が選択の左端
		west: origin.column === rect.startColumn
	};
}

/**
 * 矩形内のマスを列挙する
 * @param rect - 矩形
 * @returns 矩形内のマスを列挙する
 */
export function listTableSelectionCells(rect: TableSelectionRect): TableCellPosition[] {
	// 矩形内のマス。行優先
	const cells: TableCellPosition[] = [];
	for (let row = rect.startRow; row <= rect.endRow; row += 1) {
		for (let column = rect.startColumn; column <= rect.endColumn; column += 1) {
			// 矩形内の 1 マス
			cells.push({
				// 行。見出しは 0
				row,
				// 列。0 始まり
				column
			});
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
export function getTableMergeActionState(data: TableData, rect: TableSelectionRect): TableMergeActionState {
	// 結合の占有。覆われたマスは結合の起点にしない
	const occupancy = buildTableOccupancy(data);
	// 表の端へ収めた選択
	const clamped   = clampSelectionRect(rect, occupancy);
	// 選択の列数。1 なら横結合は不要
	const width     = clamped.endColumn - clamped.startColumn + 1;
	// 選択の行数。1 なら縦結合は不要
	const height    = clamped.endRow - clamped.startRow + 1;
	// 選択内のマス
	const cells     = listTableSelectionCells(clamped);
	// 2 マス以上で、かつ全マスが未結合の起点なら結合できる。どちらか一方が欠けても false
	const canMerge  =
		(width > 1 || height > 1) &&
		cells.every((position) => {
			// このマスの占有。範囲外は undefined
			const cell = occupancy.cells[position.row]?.[position.column];
			return cell !== undefined && !cell.covered && cell.colspan === 1 && cell.rowspan === 1;
		});
	const canUnmerge = cells.some((position) => {
		// このマスの占有。範囲外は undefined
		const cell = occupancy.cells[position.row]?.[position.column];
		return cell !== undefined && !cell.covered && (cell.colspan > 1 || cell.rowspan > 1);
	});

	return {
		// 未結合の複数マスを 1 セルにできるか
		canMerge,
		// 選択内に結合済みの起点があるか
		canUnmerge,
		// 端に収めた選択
		rect: clamped
	};
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
export function buildMergeTableCellsChanges(data: TableData, rect: TableSelectionRect): TableDocumentChange[] | null {
	// 結合できるかの判定。できない選択は変更を作らない
	const state = getTableMergeActionState(data, rect);
	// 結合できない選択は null
	if (!state.canMerge) {
		return null;
	}

	// 結合の起点。選択の左上
	const origin = {
		// 起点の行
		row: state.rect.startRow,
		// 起点の列
		column: state.rect.startColumn
	};
	// 起点セルのソース。範囲外なら null
	const source = getCellSource(data, origin);
	// 起点のソースが無い選択は結合しない
	if (!source) {
		return null;
	}

	// 起点の本文と配置。結合数だけ書き換える
	const parsed                         = parseCellSpan(source.text);
	// 選択の列数。起点へ書く colspan
	const colspan                        = state.rect.endColumn - state.rect.startColumn + 1;
	// 選択の行数。起点へ書く rowspan
	const rowspan                        = state.rect.endRow - state.rect.startRow + 1;
	// 起点へ結合属性を書く変更。他セルの消去は後から足す
	const changes: TableDocumentChange[] = [
		{
			// 起点セルの開始
			from: source.from,
			// 起点セルの終端
			to: source.to,
			insert: formatCellSpan(parsed.text, colspan, rowspan, parsed.align, parsed.valign, parsed.colwidths, parsed.rowheights)
		}
	];

	for (const position of listTableSelectionCells(state.rect)) {
		// 起点自身は結合属性を残すので空にしない。行と列の両方が起点のときだけ飛ばす
		if (position.row === origin.row && position.column === origin.column) {
			continue;
		}

		// 起点以外のセル。範囲外なら null
		const other = getCellSource(data, position);
		// 中身があるセルだけ空文字で消す。空や範囲外は変更しない。どちらか一方でも push しない
		if (other && other.text.length > 0) {
			// 結合に飲み込まれるセルを空にする
			changes.push({
				// セルの開始
				from: other.from,
				// セルの終端
				to: other.to,
				// 中身を消す
				insert: ''
			});
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
export function buildUnmergeTableCellsChanges(data: TableData, rect: TableSelectionRect): TableDocumentChange[] | null {
	// 結合の占有。同じ起点を二度処理しない
	const occupancy                      = buildTableOccupancy(data);
	// 表の端へ収めた選択
	const clamped                        = clampSelectionRect(rect, occupancy);
	// 処理済みの「行:列」。同じ起点の重複を避ける
	const seen                           = new Set<string>();
	// 結合属性を 1 に戻す変更。無ければ null を返す
	const changes: TableDocumentChange[] = [];

	/**
	 * セルソース末尾の結合属性だけを外す
	 * @param position - 位置
	 */
	const consider = (position: { row: number; column: number }): void => {
		// 同じマスを二度見ないためのキー
		const key = `${position.row}:${position.column}`;
		// すでに見たマスは属性を二重に外さない
		if (seen.has(key)) {
			return;
		}

		seen.add(key);
		// このマスのソース。範囲外なら null
		const source = getCellSource(data, position);
		// ソースが無いマスは解除しない
		if (!source) {
			return;
		}

		// いまの結合と配置
		const parsed = parseCellSpan(source.text);
		// 列も行も 1 のセルは解除する属性が無い。どちらか一方が 1 を超えていれば続ける
		if (parsed.colspan <= 1 && parsed.rowspan <= 1) {
			return;
		}

		// 結合だけ 1 に戻したセル。配置と寸法は残す
		const next = formatCellSpan(parsed.text, 1, 1, parsed.align, parsed.valign, parsed.colwidths, parsed.rowheights);
		// 書き戻し結果が元と違うときだけ変更に足す
		if (next !== source.text) {
			// 結合を外したセル
			changes.push({
				// セルの開始
				from: source.from,
				// セルの終端
				to: source.to,
				// 結合を 1 に戻した本文
				insert: next
			});
		}
	};

	consider({
		// 選択の上端
		row: clamped.startRow,
		// 選択の左端
		column: clamped.startColumn
	});
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
export function buildAlignTableCellsChanges(data: TableData, rect: TableSelectionRect, patch: TableAlignPatch): TableDocumentChange[] | null {
	// 横も縦も変えない指定は文書を変えない。どちらか一方が無いだけでは null にしない
	if (patch.align === undefined && patch.valign === undefined) {
		return null;
	}

	// 結合の占有。覆われたマスは原点へまとめる
	const occupancy                      = buildTableOccupancy(data);
	// 表の端へ収めた選択
	const clamped                        = clampSelectionRect(rect, occupancy);
	// 処理済みの原点。同じ結合を二度書かない
	const seen                           = new Set<string>();
	// 配置を書いた変更。無ければ null
	const changes: TableDocumentChange[] = [];
	for (const position of listTableSelectionCells(clamped)) {
		// 覆いの起点。配置は起点だけへ書く
		const origin = getTableCellOrigin(occupancy, position);
		// 同じ起点を二度見ないためのキー
		const key    = `${origin.row}:${origin.column}`;
		// すでに書いた起点は飛ばす
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		// 起点セルのソース。範囲外なら null
		const source = getCellSource(data, origin);
		// ソースが無い起点は配置を書けない
		if (!source) {
			continue;
		}

		// いまの本文、結合、配置、寸法
		const parsed = parseCellSpan(source.text);
		// 指定が無い軸は元の配置を残したセル
		const insert = formatCellSpan(parsed.text, parsed.colspan, parsed.rowspan, patch.align ?? parsed.align, patch.valign ?? parsed.valign, parsed.colwidths, parsed.rowheights);
		// 書き戻し結果が元と違うときだけ変更に足す
		if (insert !== source.text) {
			// 配置を更新した起点セル
			changes.push({
				// セルの開始
				from: source.from,
				// セルの終端
				to: source.to,
				// 配置を差し替えた本文
				insert
			});
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
	// 属性として付いた末尾。空白だけなら空
	const suffix = parseCellSpan(sourceText).suffix.trim();
	// 属性が無いセルはノードをそのまま返す
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
export function getVisibleAdjacentTableCellPosition(data: TableData, position: TableCellPosition, direction: 'next' | 'previous' | 'up' | 'down'): TableCellPosition | null {
	// 結合の占有。空の表は隣を返さない
	const occupancy = buildTableOccupancy(data);
	// 列か行が 0 の表は移動先が無い。どちらか一方でも null
	if (occupancy.columnCount === 0 || occupancy.rowCount === 0) {
		return null;
	}

	// いまのセルの起点。覆われたマスからでも起点へ戻す
	const origin = getTableCellOrigin(occupancy, position);
	// 起点の占有。範囲外なら undefined
	const cell   = occupancy.cells[origin.row]?.[origin.column];
	// 起点が無い位置は隣を決めない
	if (!cell) {
		return null;
	}

	// 右隣は、結合の右端の次から見えるセルを探す
	if (direction === 'next') {
		return findVisibleCell(occupancy, origin.row, origin.column + cell.colspan, 1, true);
	}

	// 左隣は、起点の直前から見えるセルを探す
	if (direction === 'previous') {
		return findVisibleCell(occupancy, origin.row, origin.column - 1, -1, true);
	}

	// 下隣は、結合の下端の次の行へ入る
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
export function resolveTableMergeRect(data: TableData, selected: TableSelectionRect | null, clicked: TableCellPosition | null): TableSelectionRect | null {
	// 複数セルのドラッグ選択は、そのまま結合の対象にする
	if (selected && isMultiCellTableSelectionRect(selected)) {
		return selected;
	}

	// クリック位置。無ければ 1 セル選択の左上。どちらも無ければ null
	const position =
		clicked ??
		(selected
			? {
				// 選択の上端
				row: selected.startRow,
				// 選択の左端
				column: selected.startColumn
			}
			: null);
	// 位置が決まらないときは対象矩形を作らない
	if (!position) {
		return null;
	}

	// 結合の占有。1 セルが結合全体ならそこへ広げる
	const occupancy = buildTableOccupancy(data);
	// 位置の起点
	const origin    = getTableCellOrigin(occupancy, position);
	// 起点の占有。範囲外なら undefined
	const cell      = occupancy.cells[origin.row]?.[origin.column];
	// 列か行が 2 以上の結合は、その全体を対象にする。どちらも 1 なら 1 セル
	if (cell && (cell.colspan > 1 || cell.rowspan > 1)) {
		// 結合全体の矩形
		return {
			// 起点の行
			startRow: origin.row,
			// 起点の列
			startColumn: origin.column,
			// 結合の最終行
			endRow: origin.row + cell.rowspan - 1,
			// 結合の最終列
			endColumn: origin.column + cell.colspan - 1
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
function getCellSource(data: TableData, position: TableCellPosition): { from: number; to: number; text: string } | null {
	// 見出し行は headerSources から取る
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
	// 収められる最終行。行が 0 でも 0
	const lastRow    = Math.max(0, occupancy.rowCount - 1);
	// 収められる最終列。列が 0 でも 0
	const lastColumn = Math.max(0, occupancy.columnCount - 1);
	// 各端を 0 から最終番号へ収めた矩形
	return {
		// 上端。0 未満や表の外は端へ戻す
		startRow: Math.min(Math.max(0, rect.startRow), lastRow),
		// 左端。0 未満や表の外は端へ戻す
		startColumn: Math.min(Math.max(0, rect.startColumn), lastColumn),
		// 下端。0 未満や表の外は端へ戻す
		endRow: Math.min(Math.max(0, rect.endRow), lastRow),
		// 右端。0 未満や表の外は端へ戻す
		endColumn: Math.min(Math.max(0, rect.endColumn), lastColumn)
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
function findVerticalAdjacentCell(occupancy: TableOccupancy, origin: TableCellPosition, preferredColumn: number, step: 1 | -1): TableCellPosition | null {
	// いまの起点の占有。範囲外なら undefined
	const originCell = occupancy.cells[origin.row]?.[origin.column];
	// 着地したい列。表の端へ収める
	const column     = Math.min(Math.max(0, preferredColumn), Math.max(0, occupancy.columnCount - 1));
	// 探索を始める行。下は結合の下端の次、上は起点の直前
	let row          = step === 1 ? origin.row + (originCell?.rowspan ?? 1) : origin.row - 1;
	while (row >= 0 && row < occupancy.rowCount) {
		// 着地列の占有。行が短ければ undefined
		const cell = occupancy.cells[row]?.[column];
		// マスがあるときだけ、その起点が別セルかを見る
		if (cell) {
			// 覆いの起点。同じ結合の中なら現在位置と一致する
			const landed = {
				// 起点の行
				row: cell.originRow,
				// 起点の列
				column: cell.originColumn
			};
			// いまのセルと違う起点だけ隣として返す。どちらか一方が違えば返す
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
function findVisibleCell(occupancy: TableOccupancy, row: number, column: number, step: 1 | -1, wrapRow: boolean): TableCellPosition | null {
	// 探索中の行。端で折り返すときは増減する
	let nextRow    = row;
	// 探索中の列。端で折り返すときは反対側へ移る
	let nextColumn = column;
	while (nextRow >= 0 && nextRow < occupancy.rowCount) {
		// 行端で折り返す探索だけ、列のはみ出しを隣の行へ送る
		if (wrapRow) {
			// 右端を超えた列は次の行の先頭へ移す
			if (nextColumn >= occupancy.columnCount) {
				nextRow   += 1;
				nextColumn = 0;
				continue;
			}

			// 左端より前の列は前の行の末尾へ移す
			if (nextColumn < 0) {
				nextRow   -= 1;
				nextColumn = occupancy.columnCount - 1;
				continue;
			}
		} else if (nextColumn < 0 || nextColumn >= occupancy.columnCount) {
			return null;
		}

		// このマスの占有。範囲外は undefined
		const cell = occupancy.cells[nextRow]?.[nextColumn];
		// 覆われていないマスだけ見える隣として返す。どちらか一方が欠けても次へ進む
		if (cell && !cell.covered) {
			// 見えるセルの位置
			return {
				// 探索中の行
				row: nextRow,
				// 探索中の列
				column: nextColumn
			};
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
	// ノードが無い、または除く文字が無いときはそのまま返す。どちらか一方でも元の配列
	if (nodes.length === 0 || suffix.length === 0) {
		return nodes;
	}

	// 元の配列を変えないための複製
	const cloned = nodes.map((node) => cloneTableCellNode(node));
	// まだ除き切れていない末尾
	let remain   = suffix;
	for (let index = cloned.length - 1; index >= 0 && remain.length > 0; index -= 1) {
		// 末尾から見るノード
		const node = cloned[index]!;
		// テキストノードだけ、末尾の文字を直接削る
		if (node.kind === 'text') {
			// このノードが残りの末尾を全部持っているとき、その分だけ削って終える
			if (node.text.endsWith(remain)) {
				node.text = node.text.slice(0, -remain.length);
				remain    = '';
				break;
			}

			// 残りの末尾がこのノード全体のとき、ノードを空にして残りを短くする
			if (remain.endsWith(node.text)) {
				remain    = remain.slice(0, -node.text.length);
				node.text = '';
				continue;
			}

			break;
		}

		// 子を持つノードは、子の末尾から同じ残りを削る
		if (nodeHasChildren(node) && node.children.length > 0) {
			node.children   = trimNodesSuffix(node.children, remain);
			// 削ったあとのプレーンテキスト。残りと突き合わせる
			const flattened = flattenNodeText(node);
			// 子を削った結果が残りの末尾と一致したら、このノードで除き終わる
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
	// 葉ノードは子が無いので、プロパティだけ写す
	if (node.kind === 'text' || node.kind === 'br' || node.kind === 'image') {
		return { ...node };
	}

	// HTML は属性と子を別オブジェクトへ写す
	if (node.kind === 'html') {
		return {
			...node,
			attributes: { ...node.attributes },
			children: node.children.map((child) => cloneTableCellNode(child))
		};
	}

	// リンクは子だけ別配列へ写す
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
	// テキストはそのまま文字にする
	if (node.kind === 'text') {
		return node.text;
	}

	// 改行と画像は文字を持たない
	if (node.kind === 'br' || node.kind === 'image') {
		return '';
	}

	return node.children.map((child) => flattenNodeText(child)).join('');
}
