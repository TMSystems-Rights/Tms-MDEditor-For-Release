/**
 * リスト行のインデントと、番号付きリストの振り直しを行う
 * リストでない選択は CodeMirror の indentMore / indentLess へ渡し、本ファイルはリスト行だけを所有する
 * @file
 */
import { indentLess, indentMore } from '@codemirror/commands';
import { EditorSelection, type ChangeSpec, type EditorState, type StateCommand } from '@codemirror/state';

// ==============================================
// リスト行の解析
// ==============================================

/**
 * 1 行のリストマーカーを分解した結果
 * 番号付きと箇条書きで、使わない側の numberText、separator、bullet は空文字
 */
export type ListLineInfo = {
	/** マーカーより前の空白。タブとスペースの混在をそのまま持つ */
	indent: string;
	/** 番号付きの数字部分。箇条書きは空文字 */
	numberText: string;
	/** 番号の区切り。`.` または `)`。箇条書きは空文字 */
	separator: string;
	/** 箇条書きの記号。`-`、`*`、`+` のいずれか。番号付きは空文字 */
	bullet: string;
	/** マーカーと本文の間の空白。1 文字以上 */
	after: string;
	/** マーカーと区切り空白の後ろ。タスクマーカーを含むことがある */
	content: string;
	/** 番号付きリストのとき true。箇条書きは false */
	isOrdered: boolean;
};

/** 箇条書きまたは番号付きリストの 1 行。キャプチャはインデント、番号、区切り、記号、直後の空白、本文 */
const LIST_LINE_PATTERN   = /^(\s*)(?:(\d+)([.)])|([-*+]))(\s+)(.*)$/;
/** リスト本文先頭のタスクマーカーと、その直後の空白。`[ ]`、`[x]`、`[X]` */
const TASK_CONTENT_PREFIX = /^\[[ xX]\]\s+/;

/**
 * 行テキストからリスト情報を解析する
 * @param text - 1 行のテキスト。改行は含めない。パターンに合わない行はリストではない
 * @returns 分解したマーカー。リスト行でないときは null
 */
export function parseListLine(text: string): ListLineInfo | null {
	// リスト行のキャプチャ。箇条書きでも番号付きでも一致しない行は null
	const match = LIST_LINE_PATTERN.exec(text);
	// パターンに合わない行はリストではないので、分解しない
	if (!match) {
		return null;
	}

	// 番号のキャプチャがあるとき番号付き。箇条書きは false で、番号側の欄は空文字にする
	const isOrdered = Boolean(match[2]);
	// マーカーの分解。使わない側の番号、区切り、記号は空文字
	return {
		// マーカーより前の空白。タブとスペースの混在をそのまま持つ
		indent: match[1],
		// 番号の数字。箇条書きは空文字
		numberText: isOrdered ? match[2] : '',
		// 番号の区切り。`.` または `)`。箇条書きは空文字
		separator: isOrdered ? match[3] : '',
		// 箇条書きの記号。番号付きは空文字
		bullet: isOrdered ? '' : match[4],
		// マーカーと本文の間の空白。1 文字以上ある行だけがパターンに一致する
		after: match[5],
		// マーカーの後ろ。タスクマーカーを含むことがある
		content: match[6],
		// 番号付きなら true。箇条書きは false
		isOrdered
	};
}

/**
 * リスト内容先頭のタスクマーカー（`[ ] ` / `[x] ` / `[X] `）の長さを返す
 * @param content - マーカーより後ろの本文。タスクでなければ 0
 * @returns マーカーと直後の空白を含む文字数。タスクでなければ 0
 */
export function taskMarkerPrefixLength(content: string): number {
	// 本文先頭の `[ ]` / `[x]` / `[X]` と直後の空白。タスクでなければ null で、長さは 0
	const match = TASK_CONTENT_PREFIX.exec(content);
	return match ? match[0].length : 0;
}

// ==============================================
// インデント幅
// ==============================================

/**
 * インデント文字列の表示幅を、タブ幅を考慮して数える
 * @param indent - 行頭の空白。タブは次のタブ停止位置まで進める
 * @param tabSize - タブ幅（桁）
 * @returns スペース換算の幅。空文字は 0
 */
function measureIndent(indent: string, tabSize: number): number {
	// スペース換算の幅（桁）。空のインデントは 0 のまま
	let width = 0;
	for (const ch of indent) {
		width += ch === '\t' ? tabSize - (width % tabSize) : 1;
	}

	return width;
}

/**
 * 指定幅のインデント文字列を作る
 * @param width - スペース換算の幅。0 以下は空文字
 * @param tabSize - タブ幅（桁）。useTabs が true のときだけタブを混ぜる
 * @param useTabs - true のときタブを優先し、余りだけスペースにする
 * @returns インデント文字列。width が 0 以下のときは空文字
 */
function buildIndent(width: number, tabSize: number, useTabs: boolean): string {
	// 幅が無い、または負ならインデントを作らない。0 は空文字で、行頭に空白を足さない
	if (width <= 0) {
		return '';
	}

	// タブを使わないときは、幅と同じ個数のスペースだけにする。タブは混ぜない
	if (!useTabs) {
		return ' '.repeat(width);
	}

	return `${'\t'.repeat(Math.floor(width / tabSize))}${' '.repeat(width % tabSize)}`;
}

/**
 * リスト記号の後ろで本文が始まる桁を数える
 * Markdown では、子の項目はこの桁以上までインデントしないと子にならない
 * @param info - 行のリスト分解
 * @param tabSize - タブ幅（桁）
 * @returns 行頭から本文の開始までの幅（桁）。記号の文字は 1 文字 1 桁で数える
 */
function measureContentColumn(info: ListLineInfo, tabSize: number): number {
	// 行頭から、記号と直後の空白までの文字列
	const prefix = `${info.indent}${info.isOrdered ? `${info.numberText}${info.separator}` : info.bullet}${info.after}`;
	return measureIndent(prefix, tabSize);
}

/**
 * 番号の桁数が変わるとき、記号の後ろの空白を増減して本文の開始位置を保つ
 * `9.  ` を `10.` にするときは `10. ` にする。空白は 1 つ未満にしない
 * 本文の開始位置が動くと、その位置に合わせてインデントした子の項目が子でなくなるため
 * @param oldNumberText - 変える前の番号の数字
 * @param after - 変える前の記号の後ろの空白
 * @param newNumberText - 変えたあとの番号の数字
 * @returns 変えたあとに使う記号の後ろの空白。タブを含むときは after のまま
 */
export function adjustOrderedMarkerSpacing(oldNumberText: string, after: string, newNumberText: string): string {
	// タブを含む空白は桁の数え方が位置で変わるため、数え直さずそのまま残す
	if (!/^ +$/.test(after)) {
		return after;
	}

	// 番号と空白を合わせた文字数。区切りの `.` や `)` は前後で同じなので数えない
	const width = oldNumberText.length + after.length;
	return ' '.repeat(Math.max(1, width - newNumberText.length));
}

/**
 * 指定行より前にある、同じ幅でインデントした兄弟の項目を探す
 * 空行と、より深い行は飛ばす。より浅い行か、リストでない行に当たったら探すのをやめる
 * @param state - 検索する文書
 * @param lineNumber - 基準行。この行より前を見る。1 始まり
 * @param width - 基準行のインデント幅（桁）
 * @returns 直前の兄弟のリスト分解。兄弟が無ければ null
 */
function findPreviousSibling(state: EditorState, lineNumber: number, width: number): ListLineInfo | null {
	for (let current = lineNumber - 1; current >= 1; current -= 1) {
		// 基準行より前の行の本文
		const text = state.doc.line(current).text;
		// その行のリスト分解。リストでなければ null
		const info = parseListLine(text);
		// リストでない行。空行なら続きを探し、本文がある行で打ち切る
		if (!info) {
			// 空白だけの行は階層の切れ目にしない
			if (text.trim() === '') {
				continue;
			}

			return null;
		}

		// その行のインデント幅（桁）
		const lineWidth = measureIndent(info.indent, state.tabSize);
		// 同じ幅なら兄弟
		if (lineWidth === width) {
			return info;
		}

		// より浅い行は親。同じ階層の兄弟はもう無い
		if (lineWidth < width) {
			return null;
		}
	}

	return null;
}

/**
 * 指定行より前にある、親の項目のインデント幅を探す
 * 空行と、同じ幅かより深い行は飛ばす。リストでない行に当たったら探すのをやめる
 * @param state - 検索する文書
 * @param lineNumber - 基準行。この行より前を見る。1 始まり
 * @param width - 基準行のインデント幅（桁）
 * @returns 親のインデント幅（桁）。親が無ければ null
 */
function findParentIndentWidth(state: EditorState, lineNumber: number, width: number): number | null {
	for (let current = lineNumber - 1; current >= 1; current -= 1) {
		// 基準行より前の行の本文
		const text = state.doc.line(current).text;
		// その行のリスト分解。リストでなければ null
		const info = parseListLine(text);
		// リストでない行。空行なら続きを探し、本文がある行で打ち切る
		if (!info) {
			// 空白だけの行は階層の切れ目にしない
			if (text.trim() === '') {
				continue;
			}

			return null;
		}

		// その行のインデント幅（桁）
		const lineWidth = measureIndent(info.indent, state.tabSize);
		// 浅い行に当たったら、それが親
		if (lineWidth < width) {
			return lineWidth;
		}
	}

	return null;
}

// ==============================================
// 番号の振り直し
// ==============================================

/**
 * 同一階層の後続する番号付きリストを、startNumber から振り直す変更を changes へ追加する
 * 空行は飛ばす。より浅い行、リストでない行、箇条書きに当たったらそこで打ち切る
 * @param state - 振り直し前の文書。行の走査に使う
 * @param startLineNumber - この行の次から見る行番号。1 始まり
 * @param indent - 対象階層のインデント文字列。幅の比較に使う
 * @param startNumber - 後続の最初に付ける番号
 * @param changes - 番号の置換を追加する配列。本文が既にその番号なら追加しない
 */
function renumberFollowingOrderedLines(state: EditorState, startLineNumber: number, indent: string, startNumber: number, changes: ChangeSpec[]): void {
	// 次に付ける番号。空行や深い行を飛ばしても増やさず、同階層の番号付きを 1 行処理するたびに増える
	let number = startNumber;
	for (let lineNumber = startLineNumber + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		// 走査中の行。置換するのはこの行の番号部分だけ
		const line = state.doc.line(lineNumber);
		// その行のリスト分解。リストでなければ null
		const info = parseListLine(line.text);
		// リストでない行。空行なら階層は続いているとみて次へ、本文がある行で打ち切る
		if (!info) {
			// 空白だけの行は階層の切れ目にしない。番号は進めず次の行へ
			if (line.text.trim() === '') {
				continue;
			}

			break;
		}

		// 走査行のインデント幅（桁）。タブは tabSize で数える
		const lineIndentWidth = measureIndent(info.indent, state.tabSize);
		// 振り直し対象の階層の幅（桁）。文字列の一致ではなく幅で比べる
		const targetWidth     = measureIndent(indent, state.tabSize);
		// より浅い行に当たったら、この階層の続きは終わったので打ち切る
		if (lineIndentWidth < targetWidth) {
			break;
		}

		// より深い行は別階層なので、番号を変えず飛ばす
		if (lineIndentWidth > targetWidth) {
			continue;
		}

		// 同じ幅の箇条書きに当たったら、番号付きの続きではないので打ち切る
		if (!info.isOrdered) {
			break;
		}

		// 既に付けたい番号なら置換しない。違うときだけ数字から直後の空白までを置き換える
		if (info.numberText !== String(number)) {
			// 振り直した番号の数字
			const numberText = String(number);
			// 番号の開始（文字）。インデントの直後
			const from       = line.from + info.indent.length;
			// 置き換えの終了（文字）。数字、区切り、直後の空白まで。本文は含めない
			const to         = from + info.numberText.length + info.separator.length + info.after.length;
			// 数字と直後の空白を置き換える変更。桁数が変わっても本文の開始位置は保つ
			changes.push({
				// 番号の開始（文字、含む）
				from,
				// 直後の空白の終了（文字、含まない）
				to,
				// 振り直した番号、元の区切り、桁数に合わせた空白
				insert: `${numberText}${info.separator}${adjustOrderedMarkerSpacing(info.numberText, info.after, numberText)}`
			});
		}

		// 同階層の番号付きを 1 行処理したので、次の行へ付ける番号を 1 進める
		number += 1;
	}
}

/**
 * 直前の同一インデントにある番号付きリストの、次に使う番号を返す
 * @param state - 検索する文書
 * @param lineNumber - 基準行。この行より前を見る。1 始まり
 * @param indent - 対象階層のインデント文字列
 * @returns 直前の番号に 1 を足した値。同階層の番号が無いときは 1
 */
function nextOrderedNumberAtIndent(state: EditorState, lineNumber: number, indent: string): number {
	// 対象階層の幅（桁）。この幅の番号付きだけを直前の兄弟とみなす
	const targetWidth = measureIndent(indent, state.tabSize);
	for (let current = lineNumber - 1; current >= 1; current -= 1) {
		// 基準行より前の行。空行は飛ばし、階層が切れたら探索を終える
		const line = state.doc.line(current);
		// その行のリスト分解。リストでなければ null
		const info = parseListLine(line.text);
		// リストでない行。空行なら続きを探し、本文がある行で打ち切る
		if (!info) {
			// 空白だけの行は階層の切れ目にしない
			if (line.text.trim() === '') {
				continue;
			}

			break;
		}

		// その行のインデント幅（桁）
		const width = measureIndent(info.indent, state.tabSize);
		// より浅い行に当たったら、同じ階層の兄弟はもう無い
		if (width < targetWidth) {
			break;
		}

		// より深い行は別階層なので飛ばす
		if (width > targetWidth) {
			continue;
		}

		// 同じ幅の箇条書きに当たったら、番号の続きではない
		if (!info.isOrdered) {
			break;
		}

		return Number(info.numberText) + 1;
	}

	return 1;
}

// ==============================================
// インデントの変更
// ==============================================

/**
 * Tab で 1 段深くしたあとのインデント幅を決める
 * 基本はタブ幅だけ深くする。直前の兄弟の本文がそれより右から始まるときは、本文の開始位置まで深くする
 * `43.  ` のように番号が 2 桁以上の項目の下では、タブ幅だけでは子にならないため
 * @param state - 対象文書
 * @param lineNumber - 深くする行。1 始まり
 * @param currentWidth - その行のいまのインデント幅（桁）
 * @returns 深くしたあとのインデント幅（桁）
 */
function measureIndentForward(state: EditorState, lineNumber: number, currentWidth: number): number {
	// タブ幅だけ深くした幅（桁）
	const stepped = currentWidth + state.tabSize;
	// 直前の兄弟。深くしたあとは、この項目の子になる。無ければ null
	const sibling = findPreviousSibling(state, lineNumber, currentWidth);
	// 兄弟が無ければ、子にする相手がいないのでタブ幅だけ深くする
	if (!sibling) {
		return stepped;
	}

	return Math.max(stepped, measureContentColumn(sibling, state.tabSize));
}

/**
 * Shift+Tab で 1 段浅くしたあとのインデント幅を決める
 * 親の項目があれば、親と同じ幅にして親の兄弟にする。無ければタブ幅だけ浅くする
 * 子の位置が親の本文に合わせてタブ幅の倍数からずれていても、親の階層へそろえて戻すため
 * @param state - 対象文書
 * @param lineNumber - 浅くする行。1 始まり
 * @param currentWidth - その行のいまのインデント幅（桁）
 * @returns 浅くしたあとのインデント幅（桁）。0 未満にはしない
 */
function measureIndentBackward(state: EditorState, lineNumber: number, currentWidth: number): number {
	// 親のインデント幅（桁）。親が無ければ null
	const parentWidth = findParentIndentWidth(state, lineNumber, currentWidth);
	return parentWidth ?? Math.max(0, currentWidth - state.tabSize);
}

/**
 * 選択中のリスト行を、1 段インデントまたはアウトデントする変更を作る
 * 範囲選択、またはリストでない行が 1 つでもあれば、全体を作らず null を返す
 * 文書中にタブが 1 つでもあれば、新しいインデントはタブを使う
 * @param state - 対象文書
 * @param forward - true で 1 段深く、false で 1 段浅くする
 * @returns 置換と、タスクマーカーの直後へ置いたキャレット。処理できないときは null
 */
function buildListIndentUpdate(state: EditorState, forward: boolean) {
	// タブ幅（桁）。1 段の増減はこの幅
	const tabSize = state.tabSize;
	// 文書にタブが 1 つでもあるとき true。新しいインデントもタブを使う。無ければ false でスペースだけ
	const useTabs = state.doc.toString().includes('\t');

	// 行の置換。1 範囲でも処理できないときは、この配列を返さず null にする
	const changes = [] as ChangeSpec[];
	// タスクマーカーの直後へ置くキャレット。範囲の数だけ積む
	const cursors = [] as ReturnType<typeof EditorSelection.cursor>[];

	for (const range of state.selection.ranges) {
		// 範囲選択が 1 つでもあると、リストのインデントとしては処理しない
		if (!range.empty) {
			return null;
		}

		// キャレットがある行。この行だけを 1 段動かす
		const line = state.doc.lineAt(range.head);
		// リスト分解。リストでなければ null
		const info = parseListLine(line.text);
		// リストでない行が 1 つでもあると、選択全体をリスト処理しない
		if (!info) {
			return null;
		}

		// いまのインデント幅（桁）
		const currentWidth = measureIndent(info.indent, tabSize);
		// 1 段動かしたあとの幅（桁）。深くするときは直前の兄弟の子になる位置、浅くするときは親と同じ位置
		const nextWidth    = forward ? measureIndentForward(state, line.number, currentWidth) : measureIndentBackward(state, line.number, currentWidth);

		// 幅が変わらないとき（既に 0 でアウトデントしたなど）は変更を作らない。呼び出し側は indentLess へ委譲する
		if (nextWidth === currentWidth) {
			return null;
		}

		// 移動先のインデント文字列。タブを使う文書ではタブを優先し、余りだけスペース
		const nextIndent = buildIndent(nextWidth, tabSize, useTabs);
		// Tab / Shift+Tab とも、移動先階層の直前兄弟から連番する（先頭なら 1）
		const nextNumber = info.isOrdered ? nextOrderedNumberAtIndent(state, line.number, nextIndent) : 0;
		// 行頭に出すマーカー。番号付きは新しい番号と区切り、箇条書きは元の記号
		const marker     = info.isOrdered ? `${nextNumber}${info.separator}` : info.bullet;
		// マーカーの後ろの空白。階層を移る行は、移った先で番号の桁数が変わっても元の空白のまま残す
		const after      = info.after;
		// 置換後の行テキスト。本文とタスクマーカーはそのまま
		const nextText   = `${nextIndent}${marker}${after}${info.content}`;

		// その行全体を、新しいインデントとマーカーで置き換える
		changes.push({
			// 行の開始（文字、含む）
			from: line.from,
			// 行の終了（文字、含まない）。改行は含めない
			to: line.to,
			// 置換後の 1 行
			insert: nextText
		});

		// 番号付きのときだけ、旧階層と新階層の後続番号を振り直す。箇条書きは番号を持たない
		if (info.isOrdered) {
			// 旧階層の後続を詰める
			renumberFollowingOrderedLines(state, line.number, info.indent, Number(info.numberText), changes);
			// 新階層の後続を挿入位置以降で振り直す
			renumberFollowingOrderedLines(state, line.number, nextIndent, nextNumber + 1, changes);
		}

		// キャレットを置く、行頭からの文字数。タスクマーカーの直後。タスクでなければマーカーの直後
		const cursorCol = nextIndent.length + marker.length + after.length + taskMarkerPrefixLength(info.content);
		cursors.push(EditorSelection.cursor(line.from + cursorCol));
	}

	// 行の置換と、タスクマーカー直後のキャレット。範囲が空なら両方空
	return {
		// 行置換と番号の振り直し
		changes,
		// 各範囲のキャレット。主選択の順は維持する
		selection: EditorSelection.create(cursors)
	};
}

/**
 * リスト行を 1 段深くインデントするコマンド
 * 選択が空でない、またはリスト行でないときは CodeMirror の indentMore へ委譲する
 * @param view - コマンド対象
 * @param view.state - インデントする文書。主選択の各範囲を見る
 * @param view.dispatch - 成功時の適用先。委譲したときは indentMore が使う
 * @returns リストとして処理した、または委譲先が処理したとき true
 */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
	// リストとして 1 段深くする変更。範囲選択や非リストなら null
	const update = buildListIndentUpdate(state, true);
	// リストとして処理できないときは、CodeMirror のインデントへ委譲する
	if (!update) {
		return indentMore({ state, dispatch });
	}

	// リスト行の置換と、表示域へのスクロール。入力の種別はインデント
	dispatch(
		state.update({
			// 行置換とキャレット。buildListIndentUpdate が作ったもの
			...update,
			// 移動した行を表示域へ入れる
			scrollIntoView: true,
			// インデント操作として記録する。通常の文字入力とは分ける
			userEvent: 'input.indent'
		})
	);
	return true;
};

/**
 * リスト行を 1 段浅くインデントするコマンド
 * 選択が空でない、またはリスト行でないときは CodeMirror の indentLess へ委譲する
 * 幅が既に 0 のリスト行も、変更を作らず indentLess へ委譲する
 * @param view - コマンド対象
 * @param view.state - アウトデントする文書。主選択の各範囲を見る
 * @param view.dispatch - 成功時の適用先。委譲したときは indentLess が使う
 * @returns リストとして処理した、または委譲先が処理したとき true
 */
export const dedentListItem: StateCommand = ({ state, dispatch }) => {
	// リストとして 1 段浅くする変更。幅が既に 0、範囲選択、非リストなら null
	const update = buildListIndentUpdate(state, false);
	// リストとして処理できないときは、CodeMirror のアウトデントへ委譲する
	if (!update) {
		return indentLess({ state, dispatch });
	}

	// リスト行の置換と、表示域へのスクロール。入力の種別はインデント
	dispatch(
		state.update({
			// 行置換とキャレット。buildListIndentUpdate が作ったもの
			...update,
			// 移動した行を表示域へ入れる
			scrollIntoView: true,
			// インデント操作として記録する。通常の文字入力とは分ける
			userEvent: 'input.indent'
		})
	);
	return true;
};
