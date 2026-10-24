/**
 * 選択範囲から、ソース表示する行とプレビュー装飾する行を判定する
 * 状態は持たず、渡された EditorState の選択を読むだけである
 * @file
 */
import type { EditorState } from '@codemirror/state';
import type { Text } from '@codemirror/state';

/**
 * ドキュメント位置が属する行番号を返す
 * 行境界（前行の to と次行の from が同じ）では assoc で帰属行を決める
 * @param doc - 行へ位置を解決するドキュメント
 * @param pos - ドキュメント先頭からの文字位置。範囲外は先頭行または最終行
 * @param assoc - 行境界の帰属。0 以下は前行、正は次行。省略時は次行
 * @returns 行番号。1 始まり
 */
export function lineNumberAtPosition(doc: Text, pos: number, assoc: number = 1): number {
	if (pos <= 0) {
		return 1;
	}

	if (pos >= doc.length) {
		return doc.lines;
	}

	const line = doc.lineAt(pos);
	if (line.number > 1 && pos === line.from && assoc <= 0) {
		const previousLine = doc.line(line.number - 1);
		if (pos === previousLine.to) {
			return previousLine.number;
		}
	}

	return line.number;
}

/**
 * ソース表示する行番号を集める
 * カーソル位置と、選択範囲に含まれる行が対象
 * @param state - 選択範囲を読むエディタ状態。文書の変更はしない
 * @returns ソース表示する行番号。1 始まり。選択が空ならカーソル行だけ
 */
export function collectSourceLineNumbers(state: EditorState): Set<number> {
	const lines = new Set<number>();

	for (const range of state.selection.ranges) {
		const anchorLine = lineNumberAtPosition(
			state.doc,
			range.anchor,
			range.anchor === range.head ? (range.assoc ?? 1) : (range.anchor < range.head ? -1 : 1),
		);
		const headLine   = lineNumberAtPosition(
			state.doc,
			range.head,
			range.empty ? (range.assoc ?? 1) : (range.head >= range.anchor ? 1 : -1),
		);
		const start      = Math.min(anchorLine, headLine);
		const end        = Math.max(anchorLine, headLine);

		for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
			lines.add(lineNumber);
		}
	}

	return lines;
}

/**
 * 指定行をソース表示にするかを判定する
 * 選択から行集合を作り直すため、同じ判定を繰り返すときは isPreviewLineNumber を使う
 * @param state - 選択範囲を読むエディタ状態
 * @param lineNumber - 判定する行番号。1 始まり
 * @returns カーソルまたは選択がその行を含むなら true
 */
export function isSourceLine(state: EditorState, lineNumber: number): boolean {
	return collectSourceLineNumbers(state).has(lineNumber);
}

/**
 * 指定行がライブプレビュー装飾の対象かを判定する
 * ソース行の裏返しであり、選択の読み方は isSourceLine と同じ
 * @param state - 選択範囲を読むエディタ状態
 * @param lineNumber - 判定する行番号。1 始まり
 * @returns ソース行でなければ true
 */
export function isPreviewLine(state: EditorState, lineNumber: number): boolean {
	return !isSourceLine(state, lineNumber);
}

/**
 * 既に集めたソース行集合から、プレビュー行かを判定する
 * 行ごとの判定で選択を読み直さないための入口
 * @param lineNumber - 判定する行番号。1 始まり
 * @param sourceLineNumbers - collectSourceLineNumbers が返した行番号
 * @returns 集合に含まれなければ true
 */
export function isPreviewLineNumber(lineNumber: number, sourceLineNumbers: Set<number>): boolean {
	return !sourceLineNumbers.has(lineNumber);
}

/**
 * 現在のカーソルまたは選択範囲が指定範囲と交差するかを判定する
 * 空選択は範囲境界を含めず、記法の直前・直後ではプレビューを維持する
 * @param state - 選択範囲を読むエディタ状態
 * @param from - 判定範囲の開始位置。to 以上なら交差しない
 * @param to - 判定範囲の終端。from 以上なら交差しない
 * @returns 空選択が範囲の内側にある、または非空選択が範囲と重なれば true
 */
export function selectionIntersectsRange(state: EditorState, from: number, to: number): boolean {
	if (from >= to) {
		return false;
	}

	return state.selection.ranges.some((range) => {
		if (range.empty) {
			return range.head > from && range.head < to;
		}

		const selectionFrom = Math.min(range.from, range.to);
		const selectionTo   = Math.max(range.from, range.to);
		return selectionFrom < to && selectionTo > from;
	});
}
