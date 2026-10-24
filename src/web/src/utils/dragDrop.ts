/**
 * ドロップ操作がファイルを運んでいるかを、データ転送の種別だけから判定する
 * ファイル本体の読み取りは持たない
 * @file
 */

/**
 * ファイルドロップかどうか判定する
 * `types` に `Files` が含まれるときだけ true。転送オブジェクトが無いときは false
 * @param dataTransfer - ドラッグ中の転送データ。ドロップ以外で null のことがある
 * @returns ファイルを含む場合 true
 */
export function isFileDrag(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) {
		return false;
	}

	return Array.from(dataTransfer.types).includes('Files');
}
