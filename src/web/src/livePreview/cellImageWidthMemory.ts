/**
 * ドラッグで決めた表セル画像の幅を、プロセス内の Map に覚えておく
 * ノートへの保存はせず、呼び出し側が remember / recall / forget で読み書きする
 * @file
 */
/**
 * 幅を覚える表セルの位置
 * 行と列は 0 始まりの整数。パスが取れないときの予備キーにも使う
 */
export type CellImagePosition = {
	/** 表内の行番号。0 始まりの整数 */
	row: number;
	/** 表内の列番号。0 始まりの整数 */
	column: number;
};

/**
 * 正規化した画像パスから幅（px）への対応
 * 実行中だけ保持し、パスが空の画像は入れない
 */
const widthsByPath = new Map<string, number>();

/**
 * セル位置とパスから幅（px）への対応
 * パス単独で引けないときの予備。キーは `行:列` と `行:列:パス` の両方を入れる
 */
const widthsByCell = new Map<string, number>();

/**
 * パスを、記憶キーとして比較できる形へ揃える
 * 前後の空白を除き、区切りをバックスラッシュに統一して小文字化する
 * @param path - 画像パス。空や空白だけならキーは空文字
 * @returns 比較用のパス。空文字は記憶キーに使わない
 */
function normalizePath(path: string): string {
	return path.trim().replaceAll('/', '\\').toLowerCase();
}

/**
 * セル位置の記憶キーを返す
 * パスを付けると `行:列:パス`、省略すると `行:列:` になる
 * @param cell - 表セルの行と列。整数であることは呼び出し側が確認する
 * @param path - 画像パス。省略時はセル位置だけのキー
 * @returns widthsByCell のキー
 */
function cellKey(cell: CellImagePosition, path: string = ''): string {
	return `${cell.row}:${cell.column}:${normalizePath(path)}`;
}

/**
 * ドラッグで決めたセル画像幅を覚える
 * 24px 未満は 24 に切り上げ、小数は四捨五入する。パスが空でも、セルが整数ならセルキーへ入れる
 * @param path - 画像パス。空や空白だけならパスキーは作らない
 * @param width - 幅（px）。24 未満は 24 として覚える
 * @param cell - 表セル位置。行と列が整数のときだけセルキーを更新する
 */
export function rememberCellImageWidth(path: string, width: number, cell?: CellImagePosition): void {
	// 覚える幅（px）。24 未満は 24 に切り上げ、小数は四捨五入
	const rounded = Math.max(24, Math.round(width));
	// 比較用のパス。空白だけなら空文字で、パスキーは作らない
	const key     = normalizePath(path);
	// パスが空でなければパスから幅を引けるようにする。空ならセルキーだけが候補
	if (key) {
		widthsByPath.set(key, rounded);
	}

	// セルがあり、行と列が両方整数のときだけセルキーを更新する。どれか一つが欠けてもパスキー以外は変えない
	if (cell && Number.isInteger(cell.row) && Number.isInteger(cell.column)) {
		widthsByCell.set(cellKey(cell, path), rounded);
		widthsByCell.set(cellKey(cell), rounded);
	}
}

/**
 * 覚えたセル画像幅を返す
 * パスの記憶を優先し、無ければ同じセルのパス付きキー、それも無ければセルだけのキーを見る
 * @param path - 画像パス。正規化してから引く
 * @param cell - 表セル位置。パスで見つからないときの予備
 * @returns 幅（px）。覚えていない、またはセルが整数でないときは undefined
 */
export function recallCellImageWidth(path: string, cell?: CellImagePosition): number | undefined {
	// パスで覚えた幅（px）。覚えていなければ undefined。0 は入らない
	const fromPath = widthsByPath.get(normalizePath(path));
	// パスの記憶があるときはセルを見ない
	if (fromPath) {
		return fromPath;
	}

	// セルが無い、または行か列が整数でないときはパス以外を見ない。どれか一つでも欠ければ undefined
	if (!cell || !Number.isInteger(cell.row) || !Number.isInteger(cell.column)) {
		return undefined;
	}

	return widthsByCell.get(cellKey(cell, path)) ?? widthsByCell.get(cellKey(cell));
}

/**
 * 覚えたセル画像幅を消す
 * パスがあれば、そのパスで終わるセルキーもまとめて削除する
 * @param path - 画像パス。空でもセル指定があればセルキーは消す
 * @param cell - 表セル位置。整数のとき、パス付きとセルだけのキーを消す
 */
export function forgetCellImageWidth(path: string, cell?: CellImagePosition): void {
	// 消すパスの比較形。空ならパスキーは消さない
	const key = normalizePath(path);
	// パスがあるとき、そのパスの記憶と、キー末尾がそのパスのセル記憶を消す
	if (key) {
		widthsByPath.delete(key);
		for (const stored of [...widthsByCell.keys()]) {
			// セルキーの末尾がそのパスなら、行と列が違っても同じ画像の記憶を消す
			if (stored.endsWith(`:${key}`)) {
				widthsByCell.delete(stored);
			}
		}
	}

	// セル位置が整数のとき、パス付きとセルだけのキーを消す。どれか一つが欠けてもセル位置の削除はしない
	if (cell && Number.isInteger(cell.row) && Number.isInteger(cell.column)) {
		widthsByCell.delete(cellKey(cell, path));
		widthsByCell.delete(cellKey(cell));
	}
}

/**
 * 試験用に、覚えたセル画像幅をすべて消す
 * 本番の画面遷移からは呼ばず、テストの前後で Map を空にする
 */
export function clearCellImageWidths(): void {
	widthsByPath.clear();
	widthsByCell.clear();
}
