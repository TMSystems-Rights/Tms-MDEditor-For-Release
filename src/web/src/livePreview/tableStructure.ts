/**
 * 表の行と列の選択単位を作り、挿入、削除、移動の文書変更を返す
 * 結合の占有は tableMerge に任せ、エディタへの dispatch は持たない
 * @file
 */
import type { EditorState } from '@codemirror/state';
import { buildTableOccupancy, formatCellSpan, parseCellSpan, readTableLayout } from './tableMerge';
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
export type TableStructureAction = 'insert-before' | 'insert-after' | 'delete' | 'move-previous' | 'move-next';

/**
 * 右クリック対象を含む既存選択は維持し、それ以外は対象グループへ選択を切り替える
 * contextmenu より先に発生する mousedown で確定し、ヘッダーが focusout で消える競合を防ぐ
 * @param current - 現在の選択
 * @param target - 右クリック対象
 * @returns コンテキストメニューの操作対象
 */
export function resolveTableStructureContextSelection(current: TableStructureSelection | null, target: TableStructureSelection): TableStructureSelection {
	return current && current.axis === target.axis && target.start >= current.start && target.end <= current.end ? current : target;
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
export function buildTableStructureGroups(data: TableData, axis: TableStructureAxis): TableStructureRange[] {
	// 結合の占有。covered のセルは選択単位の起点にしない
	const occupancy = buildTableOccupancy(data);
	// 行なら見出しを除く 1、列なら 0。選択番号のずらす量
	const offset    = axis === 'row' ? 1 : 0;
	// 選択単位に数える個数。行は見出しを引いた 0 以上、列は列数
	const count     = axis === 'row' ? Math.max(0, occupancy.rowCount - 1) : occupancy.columnCount;
	// グループ番号から根への対応。初期は自分自身が根
	const parents   = Array.from({ length: count }, (_, index) => index);

	/**
	 * 選択単位の根を返す。経路は根へ縮約する
	 * @param value - グループ番号。0 始まり
	 * @returns 同じ選択単位の根
	 */
	const find = (value: number): number => {
		// いま辿っている番号。根に着いたら自分を指す
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
		// 左の根。すでに同じ単位なら右と一致する
		const leftRoot  = find(left);
		// 右の根。左と違うときだけつなぐ
		const rightRoot = find(right);
		// 根が違うときだけ右を左の単位へ入れる。同じ根では配列を変えない
		if (leftRoot !== rightRoot) {
			parents[rightRoot] = leftRoot;
		}
	};

	for (let row = offset; row < occupancy.rowCount; row += 1) {
		for (let column = 0; column < occupancy.columnCount; column += 1) {
			// このマスの占有。行が短ければ undefined
			const cell = occupancy.cells[row]?.[column];
			// マスが無い、または結合で覆われているマスは起点にしない。どちらか一方でも飛ばす
			if (!cell || cell.covered) {
				continue;
			}

			// 列選択で、横結合が 2 列以上のときだけ隣の列を同じ単位にする。どちらか一方ではつながらない
			if (axis === 'column' && cell.colspan > 1) {
				for (let next = column + 1; next < column + cell.colspan; next += 1) {
					unite(column, next);
				}
			}

			// 行選択で、見出しより下の縦結合が 2 行以上のときだけつなぐ。どれか一つが欠けてもつながらない
			if (axis === 'row' && cell.originRow >= 1 && cell.rowspan > 1) {
				// 見出しを除いた開始行。0 始まり
				const start = cell.originRow - 1;
				for (let next = start + 1; next < start + cell.rowspan && next < count; next += 1) {
					unite(start, next);
				}
			}
		}
	}

	// 連続する同じ根を 1 単位に畳んだ結果。無ければ空
	const groups: TableStructureRange[] = [];
	for (let index = 0; index < count; index += 1) {
		// 見出しを戻した行番号、または列番号
		const actual = index + offset;
		// 最初の番号、または前と根が違うときだけ新しい単位を始める。どちらか一方でも新しい単位
		if (groups.length === 0 || find(index) !== find(index - 1)) {
			// 1 番号だけの選択単位。直後が同じ根なら end を伸ばす
			groups.push({
				// 単位の開始。行は見出しを 1 とした番号
				start: actual,
				// 単位の終了。開始時は start と同じ
				end: actual
			});
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
export function getTableStructureActionState(data: TableData, selection: TableStructureSelection): { canDelete: boolean; canMovePrevious: boolean; canMoveNext: boolean } {
	// 選択軸の単位。結合でまとまった行または列
	const groups = buildTableStructureGroups(data, selection.axis);
	// 選択開始と一致する単位の番号。無ければ -1
	const first  = groups.findIndex((group) => group.start === selection.start);
	// 選択終了と一致する単位の番号。無ければ -1
	const last   = groups.findIndex((group) => group.end === selection.end);
	// 削除して残せる行数または列数。行はデータ行、列は見出しと各行の最大
	const count  = selection.axis === 'row' ? data.rowSources.length : Math.max(data.headerSources.length, ...data.rowSources.map((row) => row.length), 0);
	// メニューが使う可否。範囲が単位に乗らない操作は false
	return {
		// 単位が見つかり、行なら残行を問わず、列なら全列より少ないときだけ削除できる
		canDelete: first >= 0 && last >= first && (selection.axis === 'row' || selection.end - selection.start + 1 < count),
		// 先頭単位より後ろで、終了単位が開始以上のときだけ前へ動かせる
		canMovePrevious: first > 0 && last >= first,
		// 単位が見つかり、終了が最後の単位より前のときだけ次へ動かせる
		canMoveNext: first >= 0 && last >= first && last < groups.length - 1
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
export function buildTableStructureChange(state: EditorState, data: TableData, selection: TableStructureSelection, action: TableStructureAction): TableDocumentChange | null {
	// 削除と移動の可否。挿入は常に通す
	const actionState = getTableStructureActionState(data, selection);
	// 禁止された削除か移動なら文書を変えない。挿入はこの条件に入らない
	if ((action === 'delete' && !actionState.canDelete) || (action === 'move-previous' && !actionState.canMovePrevious) || (action === 'move-next' && !actionState.canMoveNext)) {
		return null;
	}

	// 見出し、区切り、本体、寸法を持つ書き換え元
	const model  = extractTableSourceModel(state, data);
	// 選択軸の単位。移動先の隣を引く
	const groups = buildTableStructureGroups(data, selection.axis);
	// 選択開始の単位番号。無ければ -1
	const first  = groups.findIndex((group) => group.start === selection.start);
	// 選択終了の単位番号。無ければ -1
	const last   = groups.findIndex((group) => group.end === selection.end);
	// 開始単位が無い、または終了が開始より前なら変更を作らない。どちらか一方でも null
	if (first < 0 || last < first) {
		return null;
	}

	// 行選択だけ行操作にする。列選択は列操作
	if (selection.axis === 'row') {
		applyRowAction(model, groups, selection, action, first, last);
	} else {
		applyColumnAction(model, groups, selection, action, first, last);
	}

	restoreTableLayout(model);
	// 表全体を 1 区間で置き換える変更
	return {
		// 表の開始。文書上の文字位置
		from: data.tableFrom,
		// 表の終端。文書上の文字位置
		to: data.tableTo,
		// 操作後の Markdown。末尾改行は付けない
		insert: serializeTableSourceModel(model)
	};
}

/**
 * 構造操作のあとに残す行・列選択を返す
 * 削除した範囲は選択を残さない。挿入と移動は、操作後の同じ行や列を指す
 * @param data - 操作前の表
 * @param selection - 操作した範囲
 * @param action - 挿入、削除、移動
 * @returns 操作後の選択。削除したとき、または範囲が単位に乗らないときは null
 */
export function structureSelectionAfterAction(data: TableData, selection: TableStructureSelection, action: TableStructureAction): TableStructureSelection | null {
	// 削除した行や列は、もう選択できない
	if (action === 'delete') {
		return null;
	}

	// 選択軸の単位。移動先の隣を引く
	const groups = buildTableStructureGroups(data, selection.axis);
	// 選択開始の単位番号。無ければ -1
	const first  = groups.findIndex((group) => group.start === selection.start);
	// 選択終了の単位番号。無ければ -1
	const last   = groups.findIndex((group) => group.end === selection.end);
	// 開始単位が無い、または終了が開始より前なら選択を残せない。どちらか一方でも null
	if (first < 0 || last < first) {
		return null;
	}

	// 選択の幅。挿入で同じ数だけずれる
	const width = selection.end - selection.start + 1;
	// 前へ挿入すると、元の行や列は挿入した数だけ後ろへずれる
	if (action === 'insert-before') {
		return {
			// 操作した軸
			axis: selection.axis,
			// 挿入した数だけ後ろへずれた開始
			start: selection.start + width,
			// 挿入した数だけ後ろへずれた終了
			end: selection.end + width
		};
	}

	// 後ろへ挿入しても、選んでいた行や列の番号は変わらない
	if (action === 'insert-after') {
		return selection;
	}

	// 移動先の隣単位。前移動は直前、後移動は直後。端なら undefined
	const adjacent = action === 'move-previous' ? groups[first - 1] : groups[last + 1];
	// 隣が無い移動は、選択位置を変えない
	if (!adjacent) {
		return selection;
	}

	// 隣単位の幅。選択はこの幅だけ入れ替わる
	const shift = adjacent.end - adjacent.start + 1;
	// 前移動は負、後移動は正
	const delta = action === 'move-previous' ? -shift : shift;
	return {
		// 操作した軸
		axis: selection.axis,
		// 隣と入れ替わったあとの開始
		start: selection.start + delta,
		// 隣と入れ替わったあとの終了
		end: selection.end + delta
	};
}

/**
 * 新規 Markdown 表を作る
 * @param columnCount - 列数
 * @param dataRowCount - データ行数
 * @returns Markdown
 */
export function createMarkdownTable(columnCount: number, dataRowCount: number): string {
	// 列数。1 未満や小数は 1 列に切り上げる
	const columns = Math.max(1, Math.floor(columnCount));
	// データ行数。負や小数は 0 行にする。見出しと区切りは別
	const rows    = Math.max(0, Math.floor(dataRowCount));
	// 見出しセル。列番号は 1 始まりの表示
	const header  = Array.from({ length: columns }, (_, index) => `見出し ${index + 1}`);
	// 見出し行と区切り行。データ行は後から足す
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
export function buildTableInsertionChange(state: EditorState, position: number, markdown: string): TableDocumentChange {
	// 文書内に収めた挿入位置
	const at     = Math.min(Math.max(0, position), state.doc.length);
	// 直前が改行でないときだけ足す改行。文書先頭や直前が改行なら空文字
	const before = at > 0 && state.doc.sliceString(at - 1, at) !== '\n' ? '\n' : '';
	// 直後が改行でないときだけ足す改行。文書末や直後が改行なら空文字
	const after  = at < state.doc.length && state.doc.sliceString(at, at + 1) !== '\n' ? '\n' : '';
	// 表を独立ブロックにする挿入。範囲は点
	return {
		// 挿入位置。置き換え幅は 0
		from: at,
		// 挿入位置。from と同じ点
		to: at,
		// 前後の改行を足した表
		insert: `${before}${markdown}${after}`
	};
}

/**
 * 表示中の表から、見出し、区切り、本体、列幅、行高を取り出す
 * 左上セルのレイアウト属性は見出し文字列から外し、モデルの配列へ移す
 * @param state - 区切り行のテキストを読むエディタ状態
 * @param data - セルソースを持つ表データ
 * @returns 構造操作の入力にするソースモデル
 */
function extractTableSourceModel(state: EditorState, data: TableData): TableSourceModel {
	// 揃える列数。見出しも行も空なら 1
	const columnCount = Math.max(data.headerSources.length, ...data.rowSources.map((row) => row.length), 1);
	// 列数に揃えた見出し。足りない列は空文字
	const header      = normalizeCells(
		data.headerSources.map((source) => source.text),
		columnCount
	);
	// 列数に揃えた本体。各行の長さは columnCount
	const rows        = data.rowSources.map((row) =>
		normalizeCells(
			row.map((source) => source.text),
			columnCount
		)
	);
	// 見出しがある行。見出しセルが無ければ表の開始行
	const headerLine  = data.headerSources[0] ? state.doc.lineAt(data.headerSources[0].from) : state.doc.lineAt(data.tableFrom);
	// 次行の区切り。最終行なら `---` を列数ぶん作る
	const delimiter   = headerLine.number < state.doc.lines ? normalizeDelimiter(parseSimpleTableRow(state.doc.line(headerLine.number + 1).text), columnCount) : Array.from({ length: columnCount }, () => '---');
	// 左上セルから外した列幅と行高。未設定の配列は空
	const layout      = readTableLayout(data);
	// 見出しがあるときだけ、左上セルからレイアウト属性を外す
	if (header.length > 0) {
		header[0] = stripTableLayout(header[0]!);
	}
	// 構造操作の入力。幅と高さは配列のまま別に持つ
	return {
		// レイアウト属性を外した見出し
		header,
		// 列数に揃えた区切り
		delimiter,
		// 列数に揃えた本体
		rows,
		// 列幅（px）。未設定なら空配列
		widths: layout.widths,
		// 行高（px）。見出しを含む。未設定なら空配列
		heights: layout.heights
	};
}

/**
 * モデルが持つ列幅と行高を、左上セルの属性へ書き戻す
 * 見出しが空なら何もしない
 * @param model - 幅と高さを左上セルへ戻すソースモデル。header の先頭を更新する
 */
function restoreTableLayout(model: TableSourceModel): void {
	// 見出しが空なら左上セルが無く、属性を戻す先も無い
	if (model.header.length === 0) {
		return;
	}
	// 左上セルの本文、結合、配置。幅と高さはモデル側を書き戻す
	const parsed    = parseCellSpan(model.header[0]!);
	model.header[0] = formatCellSpan(parsed.text, parsed.colspan, parsed.rowspan, parsed.align, parsed.valign, model.widths ?? [], model.heights ?? []);
}

/**
 * セル末尾から列幅と行高の属性だけを除く
 * 結合と配置は残す
 * @param source - セルのソース文字列
 * @returns レイアウト属性を除いたセル
 */
function stripTableLayout(source: string): string {
	// セルの本文、結合、配置。幅と高さは戻さない
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
function applyRowAction(model: TableSourceModel, groups: TableStructureRange[], selection: TableStructureSelection, action: TableStructureAction, firstGroup: number, lastGroup: number): void {
	// 本体配列での開始。見出し行は 0 番なので 1 引く
	const start = selection.start - 1;
	// 動かす行数。開始と終了を含む
	const count = selection.end - selection.start + 1;
	/**
	 * 見出しと同じ列数の空セル行を返す
	 * @returns 挿入する行。中身は空文字
	 */
	const blank = (): string[] => Array.from({ length: model.header.length }, () => '');
	// 前挿入か後挿入のときだけ空行を足す。削除と移動はこの分岐に入らない
	if (action === 'insert-before' || action === 'insert-after') {
		// 挿入位置。前なら選択の先頭、後なら選択の直後
		const at = action === 'insert-before' ? start : start + count;
		model.rows.splice(at, 0, ...Array.from({ length: count }, blank));
		// 行高があるときだけ、見出しの分だけ 1 ずらして 0 を足す
		if (model.heights) model.heights.splice(at + 1, 0, ...Array.from({ length: count }, () => 0));
		return;
	}
	// 削除は選択行と、対応する行高を取り除く
	if (action === 'delete') {
		model.rows.splice(start, count);
		// 行高があるときだけ、見出しを飛ばした位置から同じ行数を消す
		if (model.heights) model.heights.splice(start + 1, count);
		return;
	}
	// 移動先の隣単位。前移動は直前、後移動は直後
	const adjacent      = action === 'move-previous' ? groups[firstGroup - 1]! : groups[lastGroup + 1]!;
	// 隣単位の本体配列での開始
	const adjacentStart = adjacent.start - 1;
	// 隣単位の行数
	const adjacentCount = adjacent.end - adjacent.start + 1;
	moveArrayBlock(model.rows, start, count, adjacentStart, adjacentCount, action);
	// 行高があるときだけ、見出しの高さを残して本体と同じ順に入れ替える
	if (model.heights) {
		// 見出しを除いた行高。入れ替えはこの配列だけ
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
function applyColumnAction(model: TableSourceModel, groups: TableStructureRange[], selection: TableStructureSelection, action: TableStructureAction, firstGroup: number, lastGroup: number): void {
	// 列の開始。0 始まりで、行操作のような見出しずらしはしない
	const start  = selection.start;
	// 動かす列数。開始と終了を含む
	const count  = selection.end - selection.start + 1;
	// 見出し、区切り、各本体行。同じ列位置で動かす
	const arrays = [model.header, model.delimiter, ...model.rows];
	// 前挿入か後挿入のときだけ空列を足す。区切り行だけ `---`
	if (action === 'insert-before' || action === 'insert-after') {
		// 挿入位置。前なら選択の先頭、後なら選択の直後
		const at = action === 'insert-before' ? start : start + count;
		arrays.forEach((row, index) => row.splice(at, 0, ...Array.from({ length: count }, () => (index === 1 ? '---' : ''))));
		// 列幅があるときだけ、同じ位置へ 0 を足す
		if (model.widths) model.widths.splice(at, 0, ...Array.from({ length: count }, () => 0));
		return;
	}
	// 削除は見出し、区切り、本体、列幅から同じ列を取り除く
	if (action === 'delete') {
		arrays.forEach((row) => row.splice(start, count));
		// 列幅があるときだけ、同じ位置から消す
		if (model.widths) model.widths.splice(start, count);
		return;
	}
	// 移動先の隣単位。前移動は直前、後移動は直後
	const adjacent      = action === 'move-previous' ? groups[firstGroup - 1]! : groups[lastGroup + 1]!;
	// 隣単位の列開始。0 始まり
	const adjacentStart = adjacent.start;
	// 隣単位の列数
	const adjacentCount = adjacent.end - adjacent.start + 1;
	arrays.forEach((row) => moveArrayBlock(row, start, count, adjacentStart, adjacentCount, action));
	// 列幅があるときだけ、セルと同じ順に入れ替える
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
function moveArrayBlock<T>(items: T[], start: number, count: number, adjacentStart: number, adjacentCount: number, action: 'move-previous' | 'move-next'): void {
	// 選択と隣を含む区間の開始。前移動なら隣が先
	const rangeStart = Math.min(start, adjacentStart);
	// 選択と隣を合わせた長さ
	const rangeCount = count + adjacentCount;
	// いったん抜いた区間。前移動では隣が先、後移動では選択が先
	const segment    = items.splice(rangeStart, rangeCount);
	// 動かす選択ブロック。前移動では区間の後半
	const selected   = action === 'move-previous' ? segment.slice(adjacentCount) : segment.slice(0, count);
	// 隣ブロック。前移動では区間の前半
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
	return Array.from({ length: count }, (_, index) => (/^:?-{3,}:?$/u.test(cells[index]?.trim() ?? '') ? cells[index]!.trim() : '---'));
}

/**
 * パイプ区切りの 1 行を、トリムしたセル配列へ分ける
 * 両端のパイプはセルに数えない。エスケープは見ない
 * @param line - 表の 1 行
 * @returns セル文字列。空行は空配列になり得る
 */
function parseSimpleTableRow(line: string): string[] {
	// 両端の空白を除いた 1 行。両端のパイプは次で外す
	let source = line.trim();
	// 行頭のパイプはセルに数えない
	if (source.startsWith('|')) source = source.slice(1);
	// 行末のパイプはセルに数えない
	if (source.endsWith('|')) source = source.slice(0, -1);
	return source.split('|').map((cell) => cell.trim());
}
