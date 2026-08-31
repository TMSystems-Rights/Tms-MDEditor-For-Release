import type { EolKind } from '../types/app';

/** 行末の改行。null は終端改行なし（最終行のみ） */
export type LineEol = EolKind | null;

export type SplitEolResult = {
	lines: string[];
	eols: LineEol[];
};

export type Cm6LineInfo = {
	lines: string[];
	endsWithNewline: boolean;
};

/**
 * 改行文字へ変換する
 * @param {EolKind} eol 改行種別
 * @returns {string} 改行文字列
 */
export function eolToString(eol: EolKind): string {
	switch (eol) {
		case 'crlf':
			return '\r\n';
		case 'cr':
			return '\r';
		default:
			return '\n';
	}
}

/**
 * 原文を行本文と行末改行に分解する（混在を保持）
 * @param {string} text 原文
 * @returns {SplitEolResult} 分解結果
 */
export function splitPreservingEol(text: string): SplitEolResult {
	const lines: string[] = [];
	const eols: LineEol[] = [];
	let index             = 0;

	if (text.length === 0) {
		return { lines: [''], eols: [null] };
	}

	while (index < text.length) {
		let end = index;
		while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
			end += 1;
		}

		lines.push(text.slice(index, end));

		if (end >= text.length) {
			eols.push(null);
			break;
		}

		if (text[end] === '\r' && end + 1 < text.length && text[end + 1] === '\n') {
			eols.push('crlf');
			index = end + 2;
		} else if (text[end] === '\r') {
			eols.push('cr');
			index = end + 1;
		} else {
			eols.push('lf');
			index = end + 1;
		}
	}

	return { lines, eols };
}

/**
 * 行本文 + 行末改行から CM6 用テキスト（LF のみ）を作る
 * @param {string[]} lines 行本文
 * @param {LineEol[]} eols 行末改行
 * @returns {string} CM6 テキスト
 */
export function toCm6Text(lines: string[], eols: LineEol[]): string {
	if (lines.length === 0) {
		return '';
	}

	const body    = lines.join('\n');
	const lastEol = eols[eols.length - 1];
	return lastEol === null ? body : `${body}\n`;
}

/**
 * CM6 テキストを内容行へ分解する
 * @param {string} cm6Text CM6 テキスト
 * @returns {Cm6LineInfo} 行情報
 */
export function getCm6LineInfo(cm6Text: string): Cm6LineInfo {
	if (cm6Text.length === 0) {
		return { lines: [''], endsWithNewline: false };
	}

	const endsWithNewline = cm6Text.endsWith('\n');
	const parts           = cm6Text.split('\n');
	const lines           = endsWithNewline ? parts.slice(0, -1) : parts;
	return { lines, endsWithNewline };
}

/**
 * CM6 テキストと行末マップから原文改行を復元する
 * @param {string} cm6Text CM6 テキスト
 * @param {LineEol[]} eols 行末マップ
 * @param {EolKind} fallback 不足時の既定改行
 * @returns {string} 復元テキスト
 */
export function reconstructWithLineEols(cm6Text: string, eols: LineEol[], fallback: EolKind): string {
	const { lines, endsWithNewline } = getCm6LineInfo(cm6Text);
	let result                       = '';

	for (let index = 0; index < lines.length; index += 1) {
		result += lines[index];

		const mapped = index < eols.length ? eols[index] : null;
		const isLast = index === lines.length - 1;

		if (isLast && !endsWithNewline) {
			continue;
		}

		const eol = mapped ?? fallback;
		result   += eolToString(eol);
	}

	return result;
}

/**
 * 全行の改行を統一したマップを作る
 * @param {string} cm6Text CM6 テキスト
 * @param {EolKind} target 統一先
 * @returns {LineEol[]} 行末マップ
 */
export function createUniformLineEols(cm6Text: string, target: EolKind): LineEol[] {
	const { lines, endsWithNewline } = getCm6LineInfo(cm6Text);
	const eols: LineEol[]            = lines.map(() => target);

	if (!endsWithNewline && eols.length > 0) {
		eols[eols.length - 1] = null;
	}

	return eols;
}

/**
 * 編集後の CM6 テキストに合わせて行末マップを同期する
 * @param {LineEol[]} previousEols 編集前マップ
 * @param {string} previousCm6 編集前 CM6 テキスト
 * @param {string} nextCm6 編集後 CM6 テキスト
 * @param {EolKind} fallback 新規行の改行
 * @returns {LineEol[]} 同期後マップ
 */
export function syncLineEols(
	previousEols: LineEol[],
	previousCm6: string,
	nextCm6: string,
	fallback: EolKind,
): LineEol[] {
	const previous = getCm6LineInfo(previousCm6);
	const next     = getCm6LineInfo(nextCm6);

	if (previous.lines.length === next.lines.length) {
		const eols = previousEols.slice(0, next.lines.length);
		while (eols.length < next.lines.length) {
			eols.push(fallback);
		}

		return finalizeTrailing(eols, next.endsWithNewline, fallback);
	}

	let prefix = 0;
	while (
		prefix < previous.lines.length
		&& prefix < next.lines.length
		&& previous.lines[prefix] === next.lines[prefix]
	) {
		prefix += 1;
	}

	let suffix = 0;
	while (
		suffix < previous.lines.length - prefix
		&& suffix < next.lines.length - prefix
		&& previous.lines[previous.lines.length - 1 - suffix] === next.lines[next.lines.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const result: LineEol[] = [];

	for (let index = 0; index < prefix; index += 1) {
		result.push(previousEols[index] ?? fallback);
	}

	const middleCount = next.lines.length - prefix - suffix;
	for (let index = 0; index < middleCount; index += 1) {
		result.push(fallback);
	}

	for (let index = previous.lines.length - suffix; index < previous.lines.length; index += 1) {
		result.push(previousEols[index] ?? fallback);
	}

	return finalizeTrailing(result, next.endsWithNewline, fallback);
}

/**
 * 末尾改行の有無に合わせて最終行の LineEol を調整する
 * @param {LineEol[]} eols マップ
 * @param {boolean} endsWithNewline 末尾改行あり
 * @param {EolKind} fallback 既定改行
 * @returns {LineEol[]} 調整後マップ
 */
function finalizeTrailing(eols: LineEol[], endsWithNewline: boolean, fallback: EolKind): LineEol[] {
	if (eols.length === 0) {
		return eols;
	}

	const next = eols.slice();
	if (!endsWithNewline) {
		next[next.length - 1] = null;
	} else if (next[next.length - 1] === null) {
		next[next.length - 1] = fallback;
	}

	return next;
}
