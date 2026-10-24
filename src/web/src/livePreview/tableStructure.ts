/**
 * 表の行と列の選択単位を作り、挿入、削除、移動の文書変更を返す
 * 結合の占有は tableMerge に任せ、エディタへの dispatch は持たない
 * @file
 */
import type { EditorState } from '@codemirror/state';
import {
	buildTableOccupancy,
	formatCellSpan,
	parseCellSpan,
	readTableLayout,
} from './tableMerge';
import type { TableData, TableDocumentChange } from './tableWidget';

/** 構造選択の軸。row は行、column は列 */
export type TableStructureAxis = 'row' | 'column';

/** 選択単位の両端。結合でまとめた行または列の番号 */
export type TableStructureRange = {
	/** 単位の開始。行は見出しを 1 とした番号、列は 0 始まり */
	start: number;
	/** 単位の終了。start 以上 */
	end: number;
};

/** 今選ばれている行または列の範囲。軸を持つ */
export type TableStructureSelection = TableStructureRange & {
	axis: TableStructureAxis;
};

/** 行・列への操作。前後への挿入、削除、隣との入れ替え */
export type TableStructureAction =
	| 'insert-before'
	| 'insert-after'
	| 'delete'
	| 'move-previous'
	| 'move-next';

/**
 * 右クリック対象を含む既存選択は維持し、それ以外は対象グループへ選択を切り替える
 * contextmenu より先に発生する mousedown で確定し、ヘッダーが focusout で消える競合を防ぐ
 * @param current - 現在の選択
 * @param target - 右クリック対象
 * @returns コンテキストメニューの操作対象
 */
export function resolveTableStructureContextSelection(
	current: TableStructureSelection | null,
	target: TableStructureSelection,
): TableStructureSelection {
	return current
		&& current.axis === target.axis
		&& target.start >= current.start
		&& target.end <= current.end
		? current
		: target;
}

/**
 * 表内にフォーカスも行・列選択もない場合だけ選択ヘッダーを隠す
 * @param hasFocus - 表内にフォーカスがあるか
 * @param hasSelection - 行・列選択があるか
 * @returns 選択ヘッダーを隠すか
 */
export function shouldHideTableStructureControls(hasFocus: boolean, hasSelection: boolean): boolean {
	return !hasFocus && !hasSelection;
}

/** 構造操作が書き換える、表の Markdown 行と寸法 */
type TableSourceModel = {
	/** 見出しセル。左から順 */
	header: string[];
	/** 区切り行のセル。列数は見出しと揃える */
	delimiter: string[];
	/** 本体の行。各行の長さは列数と揃える */
	rows: string[][];
	/** 列幅（px）。未設定ならプロパティ自体が無い */
	widths?: number[];
	/** 行高（px）。見出しを含む。未設定ならプロパティ自体が無い */
	heights?: number[];
};

/**
 * colspan / rowspan で推移的につながる行・列を選択単位へまとめる
 * 行方向は Markdown 見出し行を除外する
 * @param data - 表
 * @param axis - 軸
 * @returns 選択単位
 */
export function buildTableStructureGroups(
	data: TableData,
	axis: TableStructureAxis,
): TableStructureRange[] {
	const occupancy = buildTableOccupancy(data);
	const offset    = axis === 'row' ? 1 : 0;
	const count     = axis === 'row' ? Math.max(0, occupancy.rowCount - 1) : occupancy.columnCount;
	const parents   = Array.from({ length: count }, (_, index) => index);

	/**
	 * 選択単位の根を返す。経路は根へ縮約する
	 * @param value - グループ番号。0 始まり
	 * @returns 同じ選択単位の根
	 */
	const find = (value: number): number => {
		let current = value;
		while (parents[current] !== current) {
			parents[current] = parents[parents[current]!]!;
			current          = parents[current]!;
		}
		return current;
	};
	/**
	 * 2つのグループを同じ選択単位へつなぐ
	 * @param left - つなぐグループ番号
	 * @param right - つなぐもう一方のグループ番号
	 */
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
 * 選択範囲の構造操作可否を返す
 * @param data - 表
 * @param selection - 選択
 * @returns 可否
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
 * 表構造操作を表全体の1置換へ変換する
 * @param state - エディタ状態
 * @param data - 表
 * @param selection - 選択
 * @param action - 操作
 * @returns 文書変更
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
 * 新規 Markdown 表を作る
 * @param columnCount - 列数
 * @param dataRowCount - データ行数
 * @returns Markdown
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
 * 行途中でも前後を改行して表を独立ブロックとして挿入する
 * @param state - 状態
 * @param position - 挿入位置
 * @param markdown - 表Markdown
 * @returns 変更
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

/**
 * 表示中の表から、見出し、区切り、本体、列幅、行高を取り出す
 * 左上セルのレイアウト属性は見出し文字列から外し、モデルの配列へ移す
 * @param state - 区切り行のテキストを読むエディタ状態
 * @param data - セルソースを持つ表データ
 * @returns 構造操作の入力にするソースモデル
 */
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

/**
 * モデルが持つ列幅と行高を、左上セルの属性へ書き戻す
 * 見出しが空なら何もしない
 * @param model - 幅と高さを左上セルへ戻すソースモデル。header の先頭を更新する
 */
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

/**
 * セル末尾から列幅と行高の属性だけを除く
 * 結合と配置は残す
 * @param source - セルのソース文字列
 * @returns レイアウト属性を除いたセル
 */
function stripTableLayout(source: string): string {
	const parsed = parseCellSpan(source);
	return formatCellSpan(parsed.text, parsed.colspan, parsed.rowspan, parsed.align, parsed.valign);
}

/**
 * 行の挿入、削除、移動をソースモデルへ反映する
 * 見出し行は動かさず、行高の配列があれば同じだけずらす
 * @param model - 書き換える表。rows と heights をこの関数が更新する
 * @param groups - 行の選択単位。移動先の隣を引く
 * @param selection - 操作する行範囲。見出しを 0 とした番号
 * @param action - 前挿入、後挿入、削除、前後への移動
 * @param firstGroup - 選択がかかる最初のグループ番号
 * @param lastGroup - 選択がかかる最後のグループ番号
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
	 * 見出しと同じ列数の空セル行を返す
	 * @returns 挿入する行。中身は空文字
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
 * 列の挿入、削除、移動をソースモデルへ反映する
 * 見出し、区切り、各行、列幅を同じ位置で動かす
 * @param model - 書き換える表。header、delimiter、rows、widths を更新する
 * @param groups - 列の選択単位。移動先の隣を引く
 * @param selection - 操作する列範囲。0 始まり
 * @param action - 前挿入、後挿入、削除、前後への移動
 * @param firstGroup - 選択がかかる最初のグループ番号
 * @param lastGroup - 選択がかかる最後のグループ番号
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
 * 配列の中で、選択ブロックと隣ブロックの順序を入れ替える
 * @param items - 入れ替える配列。この関数が splice する
 * @param start - 選択ブロックの開始位置
 * @param count - 選択ブロックの長さ
 * @param adjacentStart - 隣ブロックの開始位置
 * @param adjacentCount - 隣ブロックの長さ
 * @param action - move-previous は選択を前へ、move-next は後ろへ動かす
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

/**
 * ソースモデルを Markdown の表文字列へ戻す
 * @param model - 見出し、区切り、本体を持つモデル
 * @returns 改行でつないだ表。末尾の改行は付けない
 */
function serializeTableSourceModel(model: TableSourceModel): string {
	return [model.header, model.delimiter, ...model.rows].map(formatTableRow).join('\n');
}

/**
 * セル配列を、両端にパイプがある 1 行へ整形する
 * @param cells - 左から順のセル文字列
 * @returns `|` で区切った 1 行
 */
function formatTableRow(cells: string[]): string {
	return `| ${cells.join(' | ')} |`;
}

/**
 * セル配列を指定列数へ揃える。足りない列は空文字で埋める
 * @param cells - 元のセル。列数より短くてよい
 * @param count - 揃える列数。1 以上
 * @returns 長さが count のセル配列
 */
function normalizeCells(cells: string[], count: number): string[] {
	return Array.from({ length: count }, (_, index) => cells[index] ?? '');
}

/**
 * 区切りセルを指定列数へ揃える。区切りの形でなければ `---` にする
 * @param cells - 元の区切りセル
 * @param count - 揃える列数
 * @returns 長さが count の区切り配列
 */
function normalizeDelimiter(cells: string[], count: number): string[] {
	return Array.from({ length: count }, (_, index) => /^:?-{3,}:?$/u.test(cells[index]?.trim() ?? '') ? cells[index]!.trim() : '---');
}

/**
 * パイプ区切りの 1 行を、トリムしたセル配列へ分ける
 * 両端のパイプはセルに数えない。エスケープは見ない
 * @param line - 表の 1 行
 * @returns セル文字列。空行は空配列になり得る
 */
function parseSimpleTableRow(line: string): string[] {
	let source = line.trim();
	if (source.startsWith('|')) source = source.slice(1);
	if (source.endsWith('|')) source = source.slice(0, -1);
	return source.split('|').map((cell) => cell.trim());
}
