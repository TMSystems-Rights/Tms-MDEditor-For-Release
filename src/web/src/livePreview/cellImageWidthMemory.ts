export type CellImagePosition = {
	row: number;
	column: number;
};

const widthsByPath = new Map<string, number>();
const widthsByCell = new Map<string, number>();

/**
 * 記憶キーを正規化する
 * @param {string} path 画像パス
 * @returns {string}
 */
function normalizePath(path: string): string {
	return path.trim().replaceAll('/', '\\').toLowerCase();
}

/**
 * セル位置の記憶キーを返す
 * @param {CellImagePosition} cell セル
 * @param {string} [path] 画像パス
 * @returns {string}
 */
function cellKey(cell: CellImagePosition, path: string = ''): string {
	return `${cell.row}:${cell.column}:${normalizePath(path)}`;
}

/**
 * ドラッグで決めたセル画像幅を覚える
 * @param {string} path 画像パス
 * @param {number} width 幅（px）
 * @param {CellImagePosition} [cell] 表セル位置
 * @returns {void}
 */
export function rememberCellImageWidth(
	path: string,
	width: number,
	cell?: CellImagePosition,
): void {
	const rounded = Math.max(24, Math.round(width));
	const key     = normalizePath(path);
	if (key) {
		widthsByPath.set(key, rounded);
	}

	if (cell && Number.isInteger(cell.row) && Number.isInteger(cell.column)) {
		widthsByCell.set(cellKey(cell, path), rounded);
		widthsByCell.set(cellKey(cell), rounded);
	}
}

/**
 * 覚えたセル画像幅を返す
 * @param {string} path 画像パス
 * @param {CellImagePosition} [cell] 表セル位置
 * @returns {number | undefined}
 */
export function recallCellImageWidth(
	path: string,
	cell?: CellImagePosition,
): number | undefined {
	const fromPath = widthsByPath.get(normalizePath(path));
	if (fromPath) {
		return fromPath;
	}

	if (!cell || !Number.isInteger(cell.row) || !Number.isInteger(cell.column)) {
		return undefined;
	}

	return widthsByCell.get(cellKey(cell, path)) ?? widthsByCell.get(cellKey(cell));
}

/**
 * 覚えたセル画像幅を消す
 * @param {string} path 画像パス
 * @param {CellImagePosition} [cell] 表セル位置
 * @returns {void}
 */
export function forgetCellImageWidth(path: string, cell?: CellImagePosition): void {
	const key = normalizePath(path);
	if (key) {
		widthsByPath.delete(key);
		for (const stored of [...widthsByCell.keys()]) {
			if (stored.endsWith(`:${key}`)) {
				widthsByCell.delete(stored);
			}
		}
	}

	if (cell && Number.isInteger(cell.row) && Number.isInteger(cell.column)) {
		widthsByCell.delete(cellKey(cell, path));
		widthsByCell.delete(cellKey(cell));
	}
}

/**
 * 試験用に覚えたセル画像幅を消す
 * @returns {void}
 */
export function clearCellImageWidths(): void {
	widthsByPath.clear();
	widthsByCell.clear();
}
