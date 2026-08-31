/**
 * ファイルドロップかどうか判定する
 * @param {DataTransfer | null} dataTransfer データ転送
 * @returns {boolean} ファイルを含む場合 true
 */
export function isFileDrag(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) {
		return false;
	}

	return Array.from(dataTransfer.types).includes('Files');
}
