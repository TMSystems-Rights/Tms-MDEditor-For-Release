/**
 * 行ごとの改行を、CodeMirror が使う LF 本文とは別に保持する
 * ファイルへの書き込みは持たず、渡された文字列と配列を変換する
 * @file
 */
import type { EolKind } from '../types/app';

/**
 * 1 行の末尾改行
 * null は終端改行が無いことで、最終行だけに使う
 */
export type LineEol = EolKind | null;

/**
 * 原文を行本文と行末改行へ分けた結果
 * `lines` と `eols` は同じ長さで、同じ添字が 1 行に対応する
 */
export type SplitEolResult = {
	/** 改行を除いた行本文。空文書でも 1 要素の空文字 */
	lines: string[];
	/** 各行の末尾改行。最終行に終端が無いときは null */
	eols: LineEol[];
};

/**
 * CodeMirror 用テキストの行情報
 * 改行は LF に正規化済みで、元の CR や CRLF は含まない
 */
export type Cm6LineInfo = {
	/** LF で分けた行本文。末尾改行の後の空要素は含めない */
	lines: string[];
	/** テキストが LF で終わっているか。false の最終行は終端改行なし */
	endsWithNewline: boolean;
};

/**
 * 行末マップの内容が同じか判定する
 * 長さかいずれかの要素が違えば false。配列の同一性は見ない
 * @param left - 比較元の行末マップ
 * @param right - 比較先の行末マップ
 * @returns 長さと各要素が同じ場合 true
 */
export function areLineEolsEqual(left: LineEol[], right: LineEol[]): boolean {
	return left.length === right.length && left.every((eol, index) => eol === right[index]);
}

/**
 * 改行種別を改行文字へ変換する
 * CRLF は `\r\n`、CR は `\r`、それ以外は `\n`
 * @param eol - 改行種別
 * @returns その種別の改行文字列
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
 * 原文を行本文と行末改行に分解する
 * 混在した CRLF、LF、CR を行ごとに残す。空文字は終端なしの 1 行として返す
 * @param text - 分解する原文。改行の混在を保持する
 * @returns 行本文と、同じ長さの行末マップ
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
 * 行本文と行末改行から、CodeMirror 用の LF テキストを作る
 * 行の途中の改行種別は捨て、最終行の終端があるときだけ末尾 LF を付ける
 * @param lines - 改行を含まない行本文。空配列は空文字
 * @param eols - 行末マップ。最後が null なら末尾改行を付けない
 * @returns LF だけの本文。元の CR や CRLF は含まない
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
 * CodeMirror テキストを内容行へ分解する
 * 空文字は終端なしの 1 行。末尾 LF の後にできる空要素は行に数えない
 * @param cm6Text - LF に正規化した本文
 * @returns 行本文と、末尾改行の有無
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
 * CodeMirror テキストと行末マップから原文の改行を復元する
 * マップが短い行は `fallback` を使う。末尾改行が無い最終行には改行を付けない
 * @param cm6Text - LF に正規化した本文
 * @param eols - 行ごとの元改行。不足分は `fallback`
 * @param fallback - マップに無い行、または null の終端行へ使う既定改行
 * @returns 行末を戻した全文
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
 * 末尾改行が無いテキストの最終行だけ null にする
 * @param cm6Text - LF に正規化した本文。行数の根拠にする
 * @param target - 終端がある行へ入れる改行
 * @returns 行数と同じ長さの行末マップ
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
 * 編集後の CodeMirror テキストに合わせて行末マップを同期する
 * 行数が同じなら添字を保ち、変わった範囲の新しい行には `fallback` を入れる。内容が同じなら編集前の配列を返す
 * @param previousEols - 編集前の行末マップ
 * @param previousCm6 - 編集前の LF 本文。共通の前後を見つけるために使う
 * @param nextCm6 - 編集後の LF 本文
 * @param fallback - 新しく増えた行へ入れる改行
 * @returns 編集後の行数に合う行末マップ。内容が同じなら `previousEols` そのもの
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

		return reusePreviousLineEols(
			previousEols,
			finalizeTrailing(eols, next.endsWithNewline, fallback),
		);
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

	return reusePreviousLineEols(
		previousEols,
		finalizeTrailing(result, next.endsWithNewline, fallback),
	);
}

/**
 * 内容が同じなら既存の配列を再利用する
 * 参照が変わらないことで、変更なしの編集を呼び出し側が区別できる
 * @param previousEols - 編集前のマップ。同一内容のときに返す
 * @param nextEols - 編集後に計算したマップ
 * @returns 内容が同じなら `previousEols`、違えば `nextEols`
 */
function reusePreviousLineEols(previousEols: LineEol[], nextEols: LineEol[]): LineEol[] {
	return areLineEolsEqual(previousEols, nextEols) ? previousEols : nextEols;
}

/**
 * 末尾改行の有無に合わせて最終行の行末を調整する
 * 末尾改行が無ければ最終行を null、あれば null を `fallback` に戻す。入力配列は変えない
 * @param eols - 調整前のマップ。空ならそのまま返す
 * @param endsWithNewline - 編集後テキストが LF で終わるか
 * @param fallback - 終端があるのに最終行が null のとき入れる改行
 * @returns 最終行だけを直した新しいマップ。空のときは同じ配列
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
