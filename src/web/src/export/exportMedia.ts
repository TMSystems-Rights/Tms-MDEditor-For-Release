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
const EXPORT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg']);

/**
 * 解決済みの画像を一覧へ加え、HTML から参照する相対パスを返す
 * 同じ絶対パスは 1 枚にまとめ、2 回目以降は先の名前を返す
 * @param media - ここまでの画像。同じパスがあればそれを使う
 * @param sourcePath - コピー元の絶対パス
 * @returns `media/1.png` の形。拡張子が未対応なら null
 */
export function rememberExportMedia(media: ExportMediaFile[], sourcePath: string): string | null {
	// 同じ絶対パスの登録。無ければ undefined で新規になる
	const existing = media.find((item) => item.sourcePath === sourcePath);
	// 登録済みなら新しいファイルを作らず、先の相対パスを返す
	if (existing) {
		return `media/${existing.name}`;
	}

	// 連番と拡張子のファイル名。拡張子が未対応なら null
	const name = exportMediaFileName(media.length + 1, sourcePath);
	// 画像として置けない拡張子は一覧へ加えない
	if (!name) {
		return null;
	}

	// 今回追加する 1 枚。同じパスの再登録を防ぐ
	media.push({
		// media フォルダ内のファイル名。ディレクトリは含まない
		name,
		// コピー元の絶対パス。次回の同一判定に使う
		sourcePath
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
	// 整数でない、または 1 未満。連番として使えないので名前を作らない
	if (!Number.isInteger(index) || index < 1) {
		return null;
	}

	// パス末尾の対応拡張子。未対応やドット無しは null
	const extension = imageExtension(sourcePath);
	// 画像として置けないパスは連番も使わない
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
	// パス末尾のファイル名。区切りが無いときはパス全体。空なら拡張子なし
	const base      = sourcePath.replace(/\\/g, '/').split('/').pop() ?? '';
	// 最後のドット位置。無いときは -1 で拡張子なし
	const dot       = base.lastIndexOf('.');
	// ドットが先頭以外にあるときだけ小文字の拡張子。先頭ドットやドット無しは空文字
	const extension = dot > 0 ? base.slice(dot).toLowerCase() : '';
	return EXPORT_IMAGE_EXTENSIONS.has(extension) ? extension : null;
}
