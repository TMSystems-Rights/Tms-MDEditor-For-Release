import type { EolKind } from '../types/app';

/**
 * 改行コード表示ラベルを生成する
 * @param {EolKind} eol 主要改行コード
 * @param {boolean} eolMixed 混在フラグ
 * @returns {string} 表示ラベル
 */
export function formatEolLabel(eol: EolKind, eolMixed: boolean): string {
	const base = eol.toUpperCase();
	return eolMixed ? `${base}(混在)` : base;
}

/**
 * 改行コードを指定種別へ統一する
 * @param {string} text テキスト
 * @param {EolKind} target 統一先
 * @returns {string} 変換後テキスト
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
 * 改行コード分布を解析する
 * @param {string} text テキスト
 * @returns {{ primary: EolKind; mixed: boolean }} 解析結果
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
 * 文字コード表示ラベルを生成する
 * @param {string} encoding 文字コード種別
 * @returns {string} 表示ラベル
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
 * @param {number | undefined} fileSizeBytes ファイルサイズ
 * @param {number} thresholdBytes 閾値（バイト）
 * @returns {boolean} 大ファイルなら true
 */
export function isLargeFile(fileSizeBytes: number | undefined, thresholdBytes: number): boolean {
	if (typeof fileSizeBytes !== 'number' || Number.isNaN(fileSizeBytes)) {
		return false;
	}

	return fileSizeBytes >= thresholdBytes;
}

/**
 * タブタイトルを生成する
 * @param {string | null} filePath ファイルパス
 * @returns {string} タイトル
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
 * @param {string} tabTitle タブタイトル
 * @param {boolean} dirty 未保存フラグ
 * @param {string | null} filePath ファイルパス
 * @returns {string} ウィンドウタイトル
 */
export function buildWindowTitle(tabTitle: string, dirty: boolean, filePath: string | null = null): string {
	const prefix = dirty ? '*' : '';
	const title  = filePath || tabTitle;
	return `${prefix}${title} - TMS-MDEditor`;
}
