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
	// 大文字の種別名。混在のときだけこの後に印を足す
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
	// CR と CRLF をいったん LF に揃えた全文。この後の置換の入力になる
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	// 統一先が CRLF のときだけ、LF を 2 文字の改行へ戻す
	if (target === 'crlf') {
		return normalized.replace(/\n/g, '\r\n');
	}

	// 統一先が CR のときだけ、LF を CR へ戻す。LF 指定は下でそのまま返す
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
	// CRLF の個数。CR の直後が LF のときだけ増やす
	let crlfCount = 0;
	// LF 単独の個数。CRLF の LF は数えない
	let lfCount   = 0;
	// CR 単独の個数。次が LF の CR は数えない
	let crCount   = 0;

	for (let index = 0; index < text.length; index += 1) {
		// いま見ている文字。改行以外はこの周回では数えない
		const current = text[index];

		// CR の開始。直後が LF なら CRLF、そうでなければ CR 単独
		if (current === '\r') {
			// 範囲内かつ次が LF のときだけ CRLF。末尾の CR や次が LF でないときは入らない
			if (index + 1 < text.length && text[index + 1] === '\n') {
				crlfCount += 1;
				index     += 1;
			} else {
				crCount += 1;
			}

			continue;
		}

		// LF 単独。CRLF の LF は直前の CR 側で消費済み
		if (current === '\n') {
			lfCount += 1;
		}
	}

	// 種別ごとの件数。0 件の種別は主要候補から外す
	const counts = [
		// CRLF の集計
		{
			// 比較する改行種別
			kind: 'crlf' as const,
			// 本文中の CRLF の数。0 なら候補から外す
			count: crlfCount
		},
		// LF 単独の集計
		{
			// 比較する改行種別
			kind: 'lf' as const,
			// 本文中の LF 単独の数。0 なら候補から外す
			count: lfCount
		},
		// CR 単独の集計
		{
			// 比較する改行種別
			kind: 'cr' as const,
			// 本文中の CR 単独の数。0 なら候補から外す
			count: crCount
		}
	];

	// 1 件以上ある種別。空なら改行が無く、主要は CRLF にする
	const present = counts.filter((entry) => entry.count > 0);
	// 件数が最大の種別。改行が無いときは使わず CRLF
	const primary = present.length === 0 ? 'crlf' : present.sort((left, right) => right.count - left.count)[0].kind;

	// 主要改行と、混在しているか
	return {
		// 最も多い改行。1 件も無いときは CRLF
		primary,
		// 2 種以上あるときだけ true。1 種や 0 種は false
		mixed: present.length > 1
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
		// BOM の無い UTF-8
		case 'utf8':
			return 'UTF-8';
		// BOM 付き UTF-8。BOM 無しとは表示を分ける
		case 'utf8Bom':
			return 'UTF-8(BOM)';
		// リトルエンディアンの UTF-16
		case 'utf16Le':
			return 'UTF-16LE';
		// ビッグエンディアンの UTF-16
		case 'utf16Be':
			return 'UTF-16BE';
		// Windows の日本語コードページ
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
	// サイズが数値でない、または NaN。未取得を大ファイルにしない
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
	// パスが無い未保存は、ファイル名を取れない
	if (!filePath) {
		return '無題';
	}

	// 区切りで分けたパス要素。空の末尾ならファイル名にならない
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
	// 未保存なら先頭の *。保存済みは空文字
	const prefix = dirty ? '*' : '';
	// パスがあればパス。null または空ならタブ名へ落とす
	const title  = filePath || tabTitle;
	return `${prefix}${title} - TMS-MDEditor`;
}
