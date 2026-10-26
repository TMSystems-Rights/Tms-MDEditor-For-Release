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
		// CRLF は 2 文字。LF だけでは足りない
		case 'crlf':
			return '\r\n';
		// CR 単独。次の文字は見ない
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
	// 改行を除いた行本文。空文書でも後で 1 要素を返す
	const lines: string[] = [];
	// 各行の末尾改行。最終行に終端が無いときは null を入れる
	const eols: LineEol[] = [];
	// 次に読む原文の位置。単位は文字インデックス
	let index             = 0;

	// 空文字は終端なしの 1 行。走査せず固定の 1 要素を返す
	if (text.length === 0) {
		// 空文書の結果。行は 1 つだけで終端改行は無い
		return {
			// 改行を除いた本文。空文字 1 つ
			lines: [''],
			// 最終行に終端が無い印
			eols: [null]
		};
	}

	while (index < text.length) {
		// この行の終端位置。改行または原文末尾。単位は文字インデックス
		let end = index;
		while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
			end += 1;
		}

		lines.push(text.slice(index, end));

		// 行末の改行が残っていない。最終行は終端なし
		if (end >= text.length) {
			eols.push(null);
			break;
		}

		// CR の直後が範囲内の LF のときだけ CRLF。どれか一つが欠けると CRLF にしない
		if (text[end] === '\r' && end + 1 < text.length && text[end + 1] === '\n') {
			eols.push('crlf');
			index = end + 2;
			// CR だけで次が LF ではない。CR 単独
		} else if (text[end] === '\r') {
			eols.push('cr');
			index = end + 1;
		} else {
			eols.push('lf');
			index = end + 1;
		}
	}

	// 行本文と、同じ長さの行末マップ
	return {
		// 改行を除いた行本文
		lines,
		// 各行の末尾改行。最終行に終端が無いときは null
		eols
	};
}

/**
 * 行本文と行末改行から、CodeMirror 用の LF テキストを作る
 * 行の途中の改行種別は捨て、最終行の終端があるときだけ末尾 LF を付ける
 * @param lines - 改行を含まない行本文。空配列は空文字
 * @param eols - 行末マップ。最後が null なら末尾改行を付けない
 * @returns LF だけの本文。元の CR や CRLF は含まない
 */
export function toCm6Text(lines: string[], eols: LineEol[]): string {
	// 行が無いときは末尾改行も付けない
	if (lines.length === 0) {
		return '';
	}

	// LF でつないだ本文。行ごとの改行種別は捨てている
	const body    = lines.join('\n');
	// 最終行の行末。null なら末尾 LF を付けない
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
	// 空文字は終端なしの 1 行。split すると空要素が増えるので固定値を返す
	if (cm6Text.length === 0) {
		// 空文書の行情報
		return {
			// 内容行。空文字 1 つ
			lines: [''],
			// 末尾 LF は無い
			endsWithNewline: false
		};
	}

	// 末尾が LF か。true のとき split の最後の空要素は行に数えない
	const endsWithNewline = cm6Text.endsWith('\n');
	// LF 区切り。末尾 LF があると最後に空文字が付く
	const parts           = cm6Text.split('\n');
	// 内容行。末尾 LF の空要素は捨て、無ければ split 結果をそのまま使う
	const lines           = endsWithNewline ? parts.slice(0, -1) : parts;
	// 内容行と、末尾 LF の有無
	return {
		// 末尾の空要素を除いた行本文
		lines,
		// テキストが LF で終わっているか
		endsWithNewline
	};
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
	// 行本文と末尾 LF の有無。行数の基準にする
	const { lines, endsWithNewline } = getCm6LineInfo(cm6Text);
	// 復元中の全文。行と改行を交互に足す
	let result                       = '';

	for (let index = 0; index < lines.length; index += 1) {
		result += lines[index];

		// この行の元改行。マップが短いときは null で fallback を使う
		const mapped = index < eols.length ? eols[index] : null;
		// 最終行か。末尾 LF が無いときだけ改行を足さない
		const isLast = index === lines.length - 1;

		// 最終行かつ末尾 LF が無いときだけ改行を足さない。どちらか一方では改行を付ける
		if (isLast && !endsWithNewline) {
			continue;
		}

		// マップが null の行は fallback。それ以外はマップの改行
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
	// 行本文と末尾 LF の有無。マップの長さは行数に合わせる
	const { lines, endsWithNewline } = getCm6LineInfo(cm6Text);
	// 全行を target にしたマップ。最終行の終端調整は後で行う
	const eols: LineEol[]            = lines.map(() => target);

	// 末尾 LF が無く、行があるときだけ最終行を終端なしにする。どちらか一方では変えない
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
export function syncLineEols(previousEols: LineEol[], previousCm6: string, nextCm6: string, fallback: EolKind): LineEol[] {
	// 編集前の行情報。共通部分を探す基準
	const previous = getCm6LineInfo(previousCm6);
	// 編集後の行情報。行数が違えば共通の前後を探す
	const next     = getCm6LineInfo(nextCm6);

	// ----- 行数が同じ -----
	// 行数が変わっていない。添字を保ち、足りない行だけ fallback にする
	if (previous.lines.length === next.lines.length) {
		// 編集前マップを編集後の行数へ切ったもの。長い分は捨て、短い分は下で足す
		const eols = previousEols.slice(0, next.lines.length);
		while (eols.length < next.lines.length) {
			eols.push(fallback);
		}

		return reusePreviousLineEols(previousEols, finalizeTrailing(eols, next.endsWithNewline, fallback));
	}

	// ----- 行数が変わった -----
	// 先頭から内容が一致する行数。単位は行。共通が無いときは 0
	let prefix = 0;
	while (prefix < previous.lines.length && prefix < next.lines.length && previous.lines[prefix] === next.lines[prefix]) {
		prefix += 1;
	}

	// 末尾から内容が一致する行数。prefix より前には重ならない。単位は行
	let suffix = 0;
	while (suffix < previous.lines.length - prefix && suffix < next.lines.length - prefix && previous.lines[previous.lines.length - 1 - suffix] === next.lines[next.lines.length - 1 - suffix]) {
		suffix += 1;
	}

	// 編集後の行末。先頭は元マップ、中間は fallback、末尾は元マップ
	const result: LineEol[] = [];

	for (let index = 0; index < prefix; index += 1) {
		result.push(previousEols[index] ?? fallback);
	}

	// 先頭と末尾の共通部分を除いた行数。0 なら中間の増減が無い
	const middleCount = next.lines.length - prefix - suffix;
	for (let index = 0; index < middleCount; index += 1) {
		result.push(fallback);
	}

	for (let index = previous.lines.length - suffix; index < previous.lines.length; index += 1) {
		result.push(previousEols[index] ?? fallback);
	}

	return reusePreviousLineEols(previousEols, finalizeTrailing(result, next.endsWithNewline, fallback));
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
	// 空マップは最終行が無いのでそのまま返す
	if (eols.length === 0) {
		return eols;
	}

	// 入力を変えないための複製
	const next = eols.slice();
	// 末尾 LF が無いので最終行は終端なし
	if (!endsWithNewline) {
		next[next.length - 1] = null;
		// 末尾 LF があるのに最終行が null。fallback の改行を戻す
	} else if (next[next.length - 1] === null) {
		next[next.length - 1] = fallback;
	}

	return next;
}
