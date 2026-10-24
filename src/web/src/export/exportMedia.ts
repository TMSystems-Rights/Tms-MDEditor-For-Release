/**
 * PDF と印刷で、ローカル画像を一時フォルダの相対パスにする
 * HTML ファイル書き出しの Data URL とは別に、同じ画像を何度参照しても 1 枚にまとめる
 * @file
 */

/**
 * 一時フォルダへコピーする 1 枚
 * 名前は media フォルダ内のファイル名で、パスはコピー元の絶対パス
 */
export type ExportMediaFile = {
	/** media フォルダへ置くファイル名。ディレクトリは含まない */
	name: string;
	/** コピー元の絶対パス */
	sourcePath: string;
};

/**
 * 画像として一時フォルダへ置く拡張子。FileService の対応一覧と揃える
 */
const EXPORT_IMAGE_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.bmp',
	'.ico',
	'.svg',
]);

/**
 * 解決済みの画像を一覧へ加え、HTML から参照する相対パスを返す
 * 同じ絶対パスは 1 枚にまとめ、2 回目以降は先の名前を返す
 * @param media - ここまでの画像。同じパスがあればそれを使う
 * @param sourcePath - コピー元の絶対パス
 * @returns `media/1.png` の形。拡張子が未対応なら null
 */
export function rememberExportMedia(media: ExportMediaFile[], sourcePath: string): string | null {
	const existing = media.find((item) => item.sourcePath === sourcePath);
	if (existing) {
		return `media/${existing.name}`;
	}

	const name = exportMediaFileName(media.length + 1, sourcePath);
	if (!name) {
		return null;
	}

	media.push({
		name,
		sourcePath,
	});
	return `media/${name}`;
}

/**
 * 連番と拡張子だけのファイル名を返す
 * @param index - 1 から始まる連番
 * @param sourcePath - 拡張子を取るパス
 * @returns `1.png` の形。連番または拡張子が不正なら null
 */
export function exportMediaFileName(index: number, sourcePath: string): string | null {
	if (!Number.isInteger(index) || index < 1) {
		return null;
	}

	const extension = imageExtension(sourcePath);
	if (!extension) {
		return null;
	}

	return `${index}${extension}`;
}

/**
 * パス末尾の対応拡張子を小文字で返す
 * @param sourcePath - 拡張子を見るパス。区切りは `/` と `\` のどちらでもよい
 * @returns ドット付きの拡張子。未対応なら null
 */
function imageExtension(sourcePath: string): string | null {
	const base      = sourcePath.replace(/\\/g, '/').split('/').pop() ?? '';
	const dot       = base.lastIndexOf('.');
	const extension = dot > 0 ? base.slice(dot).toLowerCase() : '';
	return EXPORT_IMAGE_EXTENSIONS.has(extension) ? extension : null;
}
