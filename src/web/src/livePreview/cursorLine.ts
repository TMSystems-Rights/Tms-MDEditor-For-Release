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
	// 文書の先頭以前は行境界を解決しない。常に先頭行
	if (pos <= 0) {
		return 1;
	}

	// 文書の終端以降は最終行。空文書でも lines は 1 以上
	if (pos >= doc.length) {
		return doc.lines;
	}

	// 位置が属する行。行境界では lineAt の既定で次行側
	const line = doc.lineAt(pos);
	// 2行目以降、行頭、かつ前行側の帰属が揃ったときだけ前行を見る。どれか一つが欠けても入らない
	if (line.number > 1 && pos === line.from && assoc <= 0) {
		// 直前の行。行頭がこの行の終端と一致するか調べる
		const previousLine = doc.line(line.number - 1);
		// 行頭が前行の終端と同じ境界なら、その前行に帰属させる
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
	// ソース表示する行番号。1始まり。選択が空ならカーソル行だけが入る
	const lines = new Set<number>();

	for (const range of state.selection.ranges) {
		// アンカー側の行番号。1始まり。空選択は assoc、範囲選択は端の外側へ帰属させる
		const anchorLine = lineNumberAtPosition(state.doc, range.anchor, range.anchor === range.head ? (range.assoc ?? 1) : range.anchor < range.head ? -1 : 1);
		// ヘッド側の行番号。1始まり。空選択は assoc、範囲選択は端の外側へ帰属させる
		const headLine   = lineNumberAtPosition(state.doc, range.head, range.empty ? (range.assoc ?? 1) : range.head >= range.anchor ? 1 : -1);
		// 選択が覆う最初の行番号。1始まり
		const start      = Math.min(anchorLine, headLine);
		// 選択が覆う最後の行番号。1始まり。start と同じなら 1 行だけ
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
	// 判定範囲が空なら交差しない。境界上のカーソルも対象にしない
	if (from >= to) {
		return false;
	}

	return state.selection.ranges.some((range) => {
		// 空選択は範囲の内側だけ交差とみなす。境界の from と to は含めない
		if (range.empty) {
			return range.head > from && range.head < to;
		}

		// 選択の開始。from と to の小さい方。文字位置
		const selectionFrom = Math.min(range.from, range.to);
		// 選択の終端。from と to の大きい方。文字位置
		const selectionTo   = Math.max(range.from, range.to);
		return selectionFrom < to && selectionTo > from;
	});
}
