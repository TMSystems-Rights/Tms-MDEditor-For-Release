/**
 * タブ名、ウィンドウ名、文字コード、改行の表示と、改行の統一を行う
 * ファイルの読み書きは持たない
 * @file
 */
import type { EolKind } from '../types/app';

/**
 * 改行コードの表示ラベルを生成する
 * 種別名は大文字にし、混在しているときだけ `(混在)` を足す
 * @param eol - 主要とみなす改行。表示名の元になる
 * @param eolMixed - 文書内に複数の改行があるか
 * @returns `CRLF` または `LF(混在)` のようなラベル
 */
export function formatEolLabel(eol: EolKind, eolMixed: boolean): string {
	const base = eol.toUpperCase();
	return eolMixed ? `${base}(混在)` : base;
}

/**
 * 改行コードを指定種別へ統一する
 * いったん LF に揃えてから、CRLF または CR へ戻す。LF 指定はそのまま返す
 * @param text - 変換前の全文
 * @param target - 統一先の改行
 * @returns 改行を統一した全文。本文の文字は変えない
 */
export function normalizeEol(text: string, target: EolKind): string {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	if (target === 'crlf') {
		return normalized.replace(/\n/g, '\r\n');
	}

	if (target === 'cr') {
		return normalized.replace(/\n/g, '\r');
	}

	return normalized;
}

/**
 * 改行コードの分布を解析する
 * 最も多い種別を主要とし、2 種以上あれば混在とする。改行が無いときは CRLF で混在ではない
 * @param text - 解析する全文
 * @returns `primary` は主要改行、`mixed` は複数種があるか
 */
export function analyzeEol(text: string): { primary: EolKind; mixed: boolean } {
	let crlfCount = 0;
	let lfCount   = 0;
	let crCount   = 0;

	for (let index = 0; index < text.length; index += 1) {
		const current = text[index];

		if (current === '\r') {
			if (index + 1 < text.length && text[index + 1] === '\n') {
				crlfCount += 1;
				index     += 1;
			} else {
				crCount += 1;
			}

			continue;
		}

		if (current === '\n') {
			lfCount += 1;
		}
	}

	const counts = [
		{ kind: 'crlf' as const, count: crlfCount },
		{ kind: 'lf' as const, count: lfCount },
		{ kind: 'cr' as const, count: crCount },
	];

	const present = counts.filter((entry) => entry.count > 0);
	const primary = present.length === 0
		? 'crlf'
		: present.sort((left, right) => right.count - left.count)[0].kind;

	return {
		primary,
		mixed: present.length > 1,
	};
}

/**
 * 文字コードの表示ラベルを生成する
 * 既知の 5 種だけを表示名へ置き、それ以外はそのまま返す
 * @param encoding - 文字コード種別。既知の値は `utf8` など
 * @returns `UTF-8` や `CP932` などの表示名。未知の値は入力のまま
 */
export function formatEncodingLabel(encoding: string): string {
	switch (encoding) {
		case 'utf8':
			return 'UTF-8';
		case 'utf8Bom':
			return 'UTF-8(BOM)';
		case 'utf16Le':
			return 'UTF-16LE';
		case 'utf16Be':
			return 'UTF-16BE';
		case 'cp932':
			return 'CP932';
		default:
			return encoding;
	}
}

/**
 * 大ファイルか判定する
 * サイズが数値でない、または NaN のときは大ファイルとしない。閾値ちょうどは大ファイル
 * @param fileSizeBytes - ファイルサイズ。単位はバイト。未取得は undefined
 * @param thresholdBytes - 大ファイルとみなす下限。単位はバイト。この値以上で true
 * @returns 閾値以上なら true
 */
export function isLargeFile(fileSizeBytes: number | undefined, thresholdBytes: number): boolean {
	if (typeof fileSizeBytes !== 'number' || Number.isNaN(fileSizeBytes)) {
		return false;
	}

	return fileSizeBytes >= thresholdBytes;
}

/**
 * タブタイトルを生成する
 * パスの最後の区切りより後ろを使う。パスが無い、または空の末尾なら `無題`
 * @param filePath - ファイルパス。未保存は null
 * @returns タブに出すファイル名。未保存は `無題`
 */
export function buildTabTitle(filePath: string | null): string {
	if (!filePath) {
		return '無題';
	}

	const segments = filePath.split(/[/\\]/);
	return segments[segments.length - 1] || '無題';
}

/**
 * ウィンドウタイトルを生成する
 * 未保存なら先頭に `*` を付け、パスがあればタブ名よりパスを優先する
 * @param tabTitle - パスが無いときに使うタブ名
 * @param dirty - 未保存の変更があるか。true なら `*` を付ける
 * @param filePath - フルパス。null または空なら `tabTitle` を使う
 * @returns `*パス - TMS-MDEditor` の形のウィンドウタイトル
 */
export function buildWindowTitle(tabTitle: string, dirty: boolean, filePath: string | null = null): string {
	const prefix = dirty ? '*' : '';
	const title  = filePath || tabTitle;
	return `${prefix}${title} - TMS-MDEditor`;
}
