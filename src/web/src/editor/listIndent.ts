/**
 * リスト行のインデントと、番号付きリストの振り直しを行う
 * リストでない選択は CodeMirror の indentMore / indentLess へ渡し、本ファイルはリスト行だけを所有する
 * @file
 */
import { indentLess, indentMore } from '@codemirror/commands';
import {
	EditorSelection,
	type ChangeSpec,
	type EditorState,
	type StateCommand,
} from '@codemirror/state';

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
	const match = LIST_LINE_PATTERN.exec(text);
	if (!match) {
		return null;
	}

	const isOrdered = Boolean(match[2]);
	return {
		indent     : match[1],
		numberText : isOrdered ? match[2] : '',
		separator  : isOrdered ? match[3] : '',
		bullet     : isOrdered ? '' : match[4],
		after      : match[5],
		content    : match[6],
		isOrdered,
	};
}

/**
 * リスト内容先頭のタスクマーカー（`[ ] ` / `[x] ` / `[X] `）の長さを返す
 * @param content - マーカーより後ろの本文。タスクでなければ 0
 * @returns マーカーと直後の空白を含む文字数。タスクでなければ 0
 */
export function taskMarkerPrefixLength(content: string): number {
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
	if (width <= 0) {
		return '';
	}

	if (!useTabs) {
		return ' '.repeat(width);
	}

	return `${'\t'.repeat(Math.floor(width / tabSize))}${' '.repeat(width % tabSize)}`;
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
function renumberFollowingOrderedLines(
	state: EditorState,
	startLineNumber: number,
	indent: string,
	startNumber: number,
	changes: ChangeSpec[],
): void {
	let number = startNumber;
	for (let lineNumber = startLineNumber + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		const line = state.doc.line(lineNumber);
		const info = parseListLine(line.text);
		if (!info) {
			if (line.text.trim() === '') {
				continue;
			}

			break;
		}

		const lineIndentWidth = measureIndent(info.indent, state.tabSize);
		const targetWidth     = measureIndent(indent, state.tabSize);
		if (lineIndentWidth < targetWidth) {
			break;
		}

		if (lineIndentWidth > targetWidth) {
			continue;
		}

		if (!info.isOrdered) {
			break;
		}

		if (info.numberText !== String(number)) {
			const from = line.from + info.indent.length;
			const to   = from + info.numberText.length;
			changes.push({ from, to, insert: String(number) });
		}

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
function nextOrderedNumberAtIndent(
	state: EditorState,
	lineNumber: number,
	indent: string,
): number {
	const targetWidth = measureIndent(indent, state.tabSize);
	for (let current = lineNumber - 1; current >= 1; current -= 1) {
		const line = state.doc.line(current);
		const info = parseListLine(line.text);
		if (!info) {
			if (line.text.trim() === '') {
				continue;
			}

			break;
		}

		const width = measureIndent(info.indent, state.tabSize);
		if (width < targetWidth) {
			break;
		}

		if (width > targetWidth) {
			continue;
		}

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
 * 選択中のリスト行を、1 段インデントまたはアウトデントする変更を作る
 * 範囲選択、またはリストでない行が 1 つでもあれば、全体を作らず null を返す
 * 文書中にタブが 1 つでもあれば、新しいインデントはタブを使う
 * @param state - 対象文書
 * @param forward - true で 1 段深く、false で 1 段浅くする
 * @returns 置換と、タスクマーカーの直後へ置いたキャレット。処理できないときは null
 */
function buildListIndentUpdate(state: EditorState, forward: boolean) {
	const tabSize = state.tabSize;
	const useTabs = state.doc.toString().includes('\t');

	const changes = [] as ChangeSpec[];
	const cursors = [] as ReturnType<typeof EditorSelection.cursor>[];

	for (const range of state.selection.ranges) {
		if (!range.empty) {
			return null;
		}

		const line = state.doc.lineAt(range.head);
		const info = parseListLine(line.text);
		if (!info) {
			return null;
		}

		const currentWidth = measureIndent(info.indent, tabSize);
		const nextWidth    = forward
			? currentWidth + tabSize
			: Math.max(0, currentWidth - tabSize);

		if (nextWidth === currentWidth) {
			return null;
		}

		const nextIndent = buildIndent(nextWidth, tabSize, useTabs);
		// Tab / Shift+Tab とも、移動先階層の直前兄弟から連番する（先頭なら 1）
		const nextNumber = info.isOrdered
			? nextOrderedNumberAtIndent(state, line.number, nextIndent)
			: 0;
		const marker     = info.isOrdered
			? `${nextNumber}${info.separator}`
			: info.bullet;
		const nextText   = `${nextIndent}${marker}${info.after}${info.content}`;

		changes.push({
			from  : line.from,
			to    : line.to,
			insert: nextText,
		});

		if (info.isOrdered) {
			// 旧階層の後続を詰める
			renumberFollowingOrderedLines(
				state,
				line.number,
				info.indent,
				Number(info.numberText),
				changes,
			);
			// 新階層の後続を挿入位置以降で振り直す
			renumberFollowingOrderedLines(
				state,
				line.number,
				nextIndent,
				nextNumber + 1,
				changes,
			);
		}

		const cursorCol = nextIndent.length
			+ marker.length
			+ info.after.length
			+ taskMarkerPrefixLength(info.content);
		cursors.push(EditorSelection.cursor(line.from + cursorCol));
	}

	return {
		changes,
		selection: EditorSelection.create(cursors),
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
	const update = buildListIndentUpdate(state, true);
	if (!update) {
		return indentMore({ state, dispatch });
	}

	dispatch(state.update({
		...update,
		scrollIntoView: true,
		userEvent     : 'input.indent',
	}));
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
	const update = buildListIndentUpdate(state, false);
	if (!update) {
		return indentLess({ state, dispatch });
	}

	dispatch(state.update({
		...update,
		scrollIntoView: true,
		userEvent     : 'input.indent',
	}));
	return true;
};
