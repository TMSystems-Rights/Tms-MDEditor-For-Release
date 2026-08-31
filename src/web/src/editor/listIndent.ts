import { indentLess, indentMore } from '@codemirror/commands';
import {
	EditorSelection,
	type ChangeSpec,
	type EditorState,
	type StateCommand,
} from '@codemirror/state';

export type ListLineInfo = {
	indent: string;
	numberText: string;
	separator: string;
	bullet: string;
	after: string;
	content: string;
	isOrdered: boolean;
};

const LIST_LINE_PATTERN   = /^(\s*)(?:(\d+)([.)])|([-*+]))(\s+)(.*)$/;
const TASK_CONTENT_PREFIX = /^\[[ xX]\]\s+/;

/**
 * 行テキストからリスト情報を解析する
 * @param {string} text 行テキスト
 * @returns {ListLineInfo | null}
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
 * リスト内容先頭のタスクマーカー（`[ ] ` / `[x] `）長を返す
 * @param {string} content リスト内容
 * @returns {number}
 */
export function taskMarkerPrefixLength(content: string): number {
	const match = TASK_CONTENT_PREFIX.exec(content);
	return match ? match[0].length : 0;
}

/**
 * インデント幅を算出する
 * @param {string} indent インデント文字列
 * @param {number} tabSize タブ幅
 * @returns {number}
 */
function measureIndent(indent: string, tabSize: number): number {
	let width = 0;
	for (const ch of indent) {
		width += ch === '\t' ? tabSize - (width % tabSize) : 1;
	}

	return width;
}

/**
 * インデント文字列を生成する
 * @param {number} width 幅
 * @param {number} tabSize タブ幅
 * @param {boolean} useTabs タブ使用
 * @returns {string}
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

/**
 * 同一階層の後続番号付きリストを振り直す変更を追加する
 * @param {EditorState} state 状態
 * @param {number} startLineNumber 開始行（この次から）
 * @param {string} indent 対象インデント
 * @param {number} startNumber 開始番号
 * @param {ChangeSpec[]} changes 変更配列
 * @returns {void}
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
 * 直前の同一インデント番号付きリスト番号を取得する
 * @param {EditorState} state 状態
 * @param {number} lineNumber 基準行
 * @param {string} indent インデント
 * @returns {number} 次に使うべき番号
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

/**
 * リスト行のインデント変更トランザクションを構築する
 * @param {EditorState} state 状態
 * @param {boolean} forward インデント方向
 * @returns {{ changes: ChangeSpec[]; selection: EditorSelection } | null}
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
 * リスト向け Tab インデント
 * @type {StateCommand}
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
 * リスト向け Shift+Tab アウトデント
 * @type {StateCommand}
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
