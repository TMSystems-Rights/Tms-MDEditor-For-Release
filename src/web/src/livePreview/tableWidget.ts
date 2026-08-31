import { redo, undo } from '@codemirror/commands';
import { Decoration, type EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState } from '@codemirror/state';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import {
	applySanitizedAttributes,
	isBreakHtmlTag,
	parseHtmlTag,
	sanitizeHtmlAttributes,
	type SanitizedHtmlAttributes,
} from './htmlSanitizer';
import { appendHighlightedCodeText, appendHighlightedInlineCode } from '../editor/codeHighlight';
import {
	collectInlineCodeContentRanges,
	getCodeLanguageGeneration,
	parseInlineCodeLanguagePrefix,
	requestCodeLanguage,
	resolveCodeLanguage,
} from '../editor/codeLanguage';
import type { DecorationEntry } from './inlineDecorations';

export { isBreakHtmlTag };

/**
 * テーブルセル内の表示用 AST（記法マークは含めない）
 */
export type TableCellNode =
	| { kind: 'text'; text: string }
	| { kind: 'br' }
	| {
		kind: 'html';
		tagName: string;
		attributes: SanitizedHtmlAttributes;
		children: TableCellNode[];
	}
	| { kind: 'em' | 'strong' | 'strike' | 'highlight' | 'code'; children: TableCellNode[] }
	| { kind: 'link'; href: string; children: TableCellNode[] }
	| { kind: 'wikilink'; children: TableCellNode[] };

export type TableData = {
	headers: TableCellNode[][];
	rows: TableCellNode[][][];
	headerSources: TableCellSource[];
	rowSources: TableCellSource[][];
	tableFrom: number;
	tableTo: number;
};

type TableCellRange = {
	from: number;
	to: number;
};

export type TableCellSource = {
	from: number;
	to: number;
	text: string;
	editableText: string;
	inlineRanges: TableCellInlineRange[];
};

export type TableCellInlineKind = 'em' | 'strong' | 'strike' | 'highlight' | 'code' | 'link' | 'wikilink';

export type TableCellInlineRange = {
	id: number;
	kind: TableCellInlineKind;
	from: number;
	to: number;
	markRanges: TableCellRange[];
	codeLanguage?: string;
};

type EditableCellData = {
	text: string;
	inlineRanges: TableCellInlineRange[];
};

type TableRowData = {
	nodes: TableCellNode[][];
	sources: TableCellSource[];
};

export type TableCellPosition = {
	row: number;
	column: number;
};

export type TableVerticalEntryTarget = {
	tableFrom: number;
	position: TableCellPosition;
	sourceFrom: number;
};

export type TableCellVerticalNavigation = {
	direction: 'up' | 'down';
	target: TableCellPosition | null;
};

export type TableDocumentChange = {
	from: number;
	to: number;
	insert: string;
};

type HtmlStackFrame = {
	tagName: string;
	attributes: SanitizedHtmlAttributes;
	children: TableCellNode[];
};

/**
 * `|` がバックスラッシュでエスケープされているか判定する。
 * @param {string} text 行文字列
 * @param {number} index `|` の位置
 * @returns {boolean}
 */
function isEscapedPipe(text: string, index: number): boolean {
	let backslashCount = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
		backslashCount += 1;
	}

	return backslashCount % 2 === 1;
}

/**
 * セル境界の前後空白を除く。
 * @param {string} text 行文字列
 * @param {number} from 行内開始位置
 * @param {number} to 行内終了位置
 * @param {number} lineFrom 行の絶対開始位置
 * @returns {TableCellRange}
 */
function trimCellRange(
	text: string,
	from: number,
	to: number,
	lineFrom: number,
): TableCellRange {
	let start = from;
	let end   = to;

	while (start < end && /\s/.test(text[start]!)) {
		start += 1;
	}

	while (end > start && /\s/.test(text[end - 1]!)) {
		end -= 1;
	}

	return {
		from: lineFrom + start,
		to  : lineFrom + end,
	};
}

/**
 * Markdown テーブル行の `|` 区切りから、空セルを含む列範囲を復元する。
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} rowNode TableHeader / TableRow ノード
 * @returns {TableCellRange[]}
 */
function extractCellRangesFromRowLine(state: EditorState, rowNode: SyntaxNode): TableCellRange[] {
	const line                  = state.doc.lineAt(rowNode.from);
	const pipeIndexes: number[] = [];

	for (let index = 0; index < line.text.length; index += 1) {
		if (line.text[index] === '|' && !isEscapedPipe(line.text, index)) {
			pipeIndexes.push(index);
		}
	}

	if (pipeIndexes.length === 0) {
		return [trimCellRange(line.text, rowNode.from - line.from, rowNode.to - line.from, line.from)];
	}

	const ranges: TableCellRange[] = [];
	let segmentStart               = pipeIndexes[0] === 0 ? 1 : 0;
	for (const pipeIndex of pipeIndexes) {
		if (pipeIndex >= segmentStart) {
			ranges.push(trimCellRange(line.text, segmentStart, pipeIndex, line.from));
		}

		segmentStart = pipeIndex + 1;
	}

	if (segmentStart < line.text.length || pipeIndexes[pipeIndexes.length - 1] !== line.text.length - 1) {
		ranges.push(trimCellRange(line.text, segmentStart, line.text.length, line.from));
	}

	return ranges;
}

/**
 * 行ノード直下の TableCell ノードを取得する。
 * @param {SyntaxNode} rowNode TableHeader / TableRow ノード
 * @returns {SyntaxNode[]}
 */
function collectTableCellNodes(rowNode: SyntaxNode): SyntaxNode[] {
	const cells: SyntaxNode[] = [];
	for (let cell = rowNode.firstChild; cell; cell = cell.nextSibling) {
		if (cell.name === 'TableCell') {
			cells.push(cell);
		}
	}

	return cells;
}

/**
 * セル範囲に対応する TableCell ノードを探す。
 * @param {SyntaxNode[]} cells TableCell ノード一覧
 * @param {Set<SyntaxNode>} used 使用済みノード
 * @param {TableCellRange} range セル範囲
 * @returns {SyntaxNode | null}
 */
function findCellNodeForRange(
	cells: SyntaxNode[],
	used: Set<SyntaxNode>,
	range: TableCellRange,
): SyntaxNode | null {
	for (const cell of cells) {
		if (used.has(cell)) {
			continue;
		}

		if (cell.from >= range.from && cell.to <= range.to) {
			used.add(cell);
			return cell;
		}
	}

	return null;
}

const TABLE_CELL_INLINE_KINDS = new Map<string, TableCellInlineKind>([
	['Emphasis', 'em'],
	['StrongEmphasis', 'strong'],
	['Strikethrough', 'strike'],
	['Highlight', 'highlight'],
	['InlineCode', 'code'],
	['Link', 'link'],
	['WikiLink', 'wikilink'],
]);

/**
 * Markdownソース位置を、HTML改行タグを1文字へ畳み込んだ編集文字列上の位置へ変換する。
 * @param {number} position Markdownソース上の絶対位置
 * @param {TableCellRange} cellRange セル範囲
 * @param {TableCellRange[]} breakRanges HTML改行タグ範囲
 * @returns {number}
 */
function toEditableCellOffset(
	position: number,
	cellRange: TableCellRange,
	breakRanges: TableCellRange[],
): number {
	let offset = position - cellRange.from;
	for (const breakRange of breakRanges) {
		if (breakRange.to > position) {
			break;
		}

		offset -= breakRange.to - breakRange.from - 1;
	}

	return Math.max(0, offset);
}

/**
 * インライン要素自身が所有する記法トークン範囲を返す。
 * 入れ子要素のマーカーは、その入れ子要素側で個別に扱う。
 * @param {SyntaxNode} node インライン構文ノード
 * @returns {TableCellRange[]}
 */
function collectOwnedInlineMarkRanges(node: SyntaxNode): TableCellRange[] {
	const ranges: TableCellRange[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.name.endsWith('Mark') || child.name === 'URL' || child.name === 'LinkTitle') {
			ranges.push({ from: child.from, to: child.to });
		}
	}

	return ranges;
}

/**
 * InlineCode の `{java}` 接頭辞（直後の空白含む）を、既知言語なら隠し対象として返す
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} node InlineCode ノード
 * @returns {{ from: number; to: number; language: string } | null}
 */
function extractInlineCodeLanguagePrefixRange(
	state: EditorState,
	node: SyntaxNode,
): { from: number; to: number; language: string } | null {
	const contentRange = collectInlineCodeContentRanges(node)[0];
	if (!contentRange) {
		return null;
	}

	const content = state.doc.sliceString(contentRange.from, contentRange.to);
	const prefix  = parseInlineCodeLanguagePrefix(content);
	if (!prefix || !resolveCodeLanguage(prefix.language)) {
		return null;
	}

	return {
		from    : contentRange.from,
		to      : contentRange.from + prefix.prefixLength,
		language: prefix.language,
	};
}

/**
 * セルのMarkdownソースから編集用文字列とインライン装飾範囲を返す。
 * HTML改行タグだけを実改行へ変換し、インラインコード内などHTMLTagとして解析されない
 * `<br>` は文字列のまま保持する。
 * @param {EditorState} state エディタ状態
 * @param {TableCellRange} range セル範囲
 * @param {SyntaxNode | null} cellNode 対応するTableCellノード
 * @returns {EditableCellData}
 */
function extractEditableCellData(
	state: EditorState,
	range: TableCellRange,
	cellNode: SyntaxNode | null,
): EditableCellData {
	if (!cellNode) {
		return {
			text        : state.doc.sliceString(range.from, range.to),
			inlineRanges: [],
		};
	}

	const breakRanges: TableCellRange[] = [];
	cellNode.cursor().iterate((ref: SyntaxNodeRef) => {
		if (ref.name !== 'HTMLTag') {
			return;
		}

		const raw = state.doc.sliceString(ref.from, ref.to);
		if (isBreakHtmlTag(raw)) {
			breakRanges.push({ from: ref.from, to: ref.to });
		}
	});

	breakRanges.sort((a, b) => a.from - b.from);
	let result = '';
	let cursor = range.from;
	for (const breakRange of breakRanges) {
		result += state.doc.sliceString(cursor, breakRange.from);
		result += '\n';
		cursor  = breakRange.to;
	}

	result += state.doc.sliceString(cursor, range.to);

	const inlineRanges: TableCellInlineRange[] = [];
	cellNode.cursor().iterate((ref: SyntaxNodeRef) => {
		const kind = TABLE_CELL_INLINE_KINDS.get(ref.name);
		if (!kind) {
			return;
		}

		const markRanges = collectOwnedInlineMarkRanges(ref.node);
		let codeLanguage: string | undefined;
		if (kind === 'code') {
			const languagePrefix = extractInlineCodeLanguagePrefixRange(state, ref.node);
			if (languagePrefix) {
				markRanges.push({ from: languagePrefix.from, to: languagePrefix.to });
				codeLanguage = languagePrefix.language;
			}
		}

		inlineRanges.push({
			id        : 0,
			kind,
			from      : toEditableCellOffset(ref.from, range, breakRanges),
			to        : toEditableCellOffset(ref.to, range, breakRanges),
			codeLanguage,
			markRanges: markRanges.map((markRange) => ({
				from: toEditableCellOffset(markRange.from, range, breakRanges),
				to  : toEditableCellOffset(markRange.to, range, breakRanges),
			})),
		});
	});

	inlineRanges.sort((a, b) => a.from - b.from || b.to - a.to);
	inlineRanges.forEach((inlineRange, index) => {
		inlineRange.id = index;
	});

	return { text: result, inlineRanges };
}

/**
 * TableHeader / TableRow から空セルを含むセル配列を抽出する。
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} rowNode TableHeader / TableRow ノード
 * @returns {TableCellNode[][]}
 */
function extractTableRowData(state: EditorState, rowNode: SyntaxNode): TableRowData {
	const ranges                   = extractCellRangesFromRowLine(state, rowNode);
	const cells                    = collectTableCellNodes(rowNode);
	const used                     = new Set<SyntaxNode>();
	const matchedCells             = ranges.map((range) => {
		if (range.from >= range.to) {
			return null;
		}

		return findCellNodeForRange(cells, used, range);
	});
	const nodes: TableCellNode[][] = ranges.map((range, index) => {
		const cell = matchedCells[index] ?? null;
		if (cell) {
			return extractTableCellNodes(state, cell);
		}

		const raw = state.doc.sliceString(range.from, range.to);
		return raw ? [{ kind: 'text', text: raw }] : [];
	});
	const sources = ranges.map((range, index) => {
		const editable = extractEditableCellData(state, range, matchedCells[index] ?? null);
		return {
			...range,
			text        : state.doc.sliceString(range.from, range.to),
			editableText: editable.text,
			inlineRanges: editable.inlineRanges,
		};
	});
	return { nodes, sources };
}

/**
 * HTML 開タグをスタックへ積む
 * @param {TableCellNode[]} current 現在の子配列
 * @param {HtmlStackFrame[]} stack スタック
 * @param {string} tagName タグ名
 * @param {SanitizedHtmlAttributes} attributes 属性
 * @returns {TableCellNode[]}
 */
function pushHtmlOpen(
	current: TableCellNode[],
	stack: HtmlStackFrame[],
	tagName: string,
	attributes: SanitizedHtmlAttributes,
): TableCellNode[] {
	const node: TableCellNode = {
		kind: 'html',
		tagName,
		attributes,
		children: [],
	};
	current.push(node);
	stack.push({
		tagName,
		attributes,
		children: node.children,
	});
	return node.children;
}

/**
 * HTML 閉タグでスタックを閉じる
 * @param {HtmlStackFrame[]} stack スタック
 * @param {string} tagName タグ名
 * @param {TableCellNode[]} root ルート配列
 * @returns {TableCellNode[]}
 */
function closeHtmlTag(
	stack: HtmlStackFrame[],
	tagName: string,
	root: TableCellNode[],
): TableCellNode[] {
	let openIndex = -1;
	for (let index = stack.length - 1; index >= 0; index -= 1) {
		if (stack[index]!.tagName === tagName) {
			openIndex = index;
			break;
		}
	}

	if (openIndex < 0) {
		return stack.length > 0 ? stack[stack.length - 1]!.children : root;
	}

	stack.length = openIndex;
	return stack.length > 0 ? stack[stack.length - 1]!.children : root;
}

/**
 * セル部分木を TableCellNode 配列へ変換する
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} node ノード
 * @returns {TableCellNode[]}
 */
function extractInlineNodes(state: EditorState, node: SyntaxNode): TableCellNode[] {
	const root: TableCellNode[]       = [];
	const htmlStack: HtmlStackFrame[] = [];
	let current: TableCellNode[]      = root;
	let cursor                        = node.from;

	/**
	 *
	 */
	const flushText = (to: number): void => {
		if (to <= cursor) {
			return;
		}

		const text = state.doc.sliceString(cursor, to);
		if (text) {
			current.push({ kind: 'text', text });
		}

		cursor = to;
	};

	for (let child: SyntaxNode | null = node.firstChild; child; child = child.nextSibling) {
		flushText(child.from);

		const name = child.name;
		if (name.endsWith('Mark') || name === 'URL' || name === 'LinkTitle') {
			cursor = child.to;
			continue;
		}

		if (name === 'HTMLTag') {
			const raw = state.doc.sliceString(child.from, child.to);
			if (isBreakHtmlTag(raw)) {
				current.push({ kind: 'br' });
				cursor = child.to;
				continue;
			}

			const parsed = parseHtmlTag(raw);
			if (!parsed || !parsed.allowed) {
				// 非許可タグはソース文字列のまま残す（無効化）
				current.push({ kind: 'text', text: raw });
				cursor = child.to;
				continue;
			}

			if (parsed.kind === 'selfClosing') {
				if (parsed.name === 'br') {
					current.push({ kind: 'br' });
				} else {
					current.push({
						kind      : 'html',
						tagName   : parsed.name,
						attributes: sanitizeHtmlAttributes(parsed.attributes),
						children  : [],
					});
				}
				cursor = child.to;
				continue;
			}

			if (parsed.kind === 'open') {
				current = pushHtmlOpen(
					current,
					htmlStack,
					parsed.name,
					sanitizeHtmlAttributes(parsed.attributes),
				);
				cursor  = child.to;
				continue;
			}

			if (parsed.kind === 'close') {
				current = closeHtmlTag(htmlStack, parsed.name, root);
				cursor  = child.to;
				continue;
			}

			current.push({ kind: 'text', text: raw });
			cursor = child.to;
			continue;
		}

		if (name === 'Emphasis') {
			current.push({ kind: 'em', children: extractInlineNodes(state, child) });
			cursor = child.to;
			continue;
		}

		if (name === 'StrongEmphasis') {
			current.push({ kind: 'strong', children: extractInlineNodes(state, child) });
			cursor = child.to;
			continue;
		}

		if (name === 'Strikethrough') {
			current.push({ kind: 'strike', children: extractInlineNodes(state, child) });
			cursor = child.to;
			continue;
		}

		if (name === 'Highlight') {
			current.push({ kind: 'highlight', children: extractInlineNodes(state, child) });
			cursor = child.to;
			continue;
		}

		if (name === 'InlineCode') {
			current.push({ kind: 'code', children: extractInlineNodes(state, child) });
			cursor = child.to;
			continue;
		}

		if (name === 'Link') {
			let href = '';
			child.cursor().iterate((ref: SyntaxNodeRef) => {
				if (ref.name === 'URL') {
					href = state.doc.sliceString(ref.from, ref.to).trim();
				}
			});
			current.push({ kind: 'link', href, children: extractInlineNodes(state, child) });
			cursor = child.to;
			continue;
		}

		if (name === 'WikiLink') {
			current.push({ kind: 'wikilink', children: extractInlineNodes(state, child) });
			cursor = child.to;
			continue;
		}

		// 未知の入れ子は中身だけ取り込む
		if (child.firstChild) {
			current.push(...extractInlineNodes(state, child));
			cursor = child.to;
			continue;
		}

		const leaf = state.doc.sliceString(child.from, child.to);
		if (leaf) {
			current.push({ kind: 'text', text: leaf });
		}

		cursor = child.to;
	}

	flushText(node.to);
	return root;
}

/**
 * TableCell ノードから表示 AST を抽出する
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} cellNode TableCell ノード
 * @returns {TableCellNode[]}
 */
export function extractTableCellNodes(state: EditorState, cellNode: SyntaxNode): TableCellNode[] {
	return extractInlineNodes(state, cellNode);
}

/**
 * セル AST をトリムなしでプレーンテキスト化する
 * @param {TableCellNode[]} nodes セル AST
 * @returns {string}
 */
function flattenTableCellText(nodes: TableCellNode[]): string {
	const parts: string[] = [];
	/**
	 * @param {TableCellNode[]} items ノード
	 * @returns {void}
	 */
	const walk = (items: TableCellNode[]): void => {
		for (const item of items) {
			if (item.kind === 'text') {
				parts.push(item.text);
				continue;
			}

			if (item.kind === 'br') {
				parts.push('\n');
				continue;
			}

			walk(item.children);
		}
	};

	walk(nodes);
	return parts.join('');
}

/**
 * セル AST をプレーンテキストへ変換する
 * @param {TableCellNode[]} nodes セル AST
 * @returns {string}
 */
export function tableCellNodesToPlainText(nodes: TableCellNode[]): string {
	return flattenTableCellText(nodes).trim();
}

/**
 * Table ノードからヘッダ・行データを抽出する
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} tableNode Table ノード
 * @returns {TableData}
 */
export function extractTableData(state: EditorState, tableNode: SyntaxNode): TableData {
	const headers: TableCellNode[][]       = [];
	const rows: TableCellNode[][][]        = [];
	const headerSources: TableCellSource[] = [];
	const rowSources: TableCellSource[][]  = [];

	for (let child = tableNode.firstChild; child; child = child.nextSibling) {
		if (child.name === 'TableHeader') {
			const row = extractTableRowData(state, child);
			headers.push(...row.nodes);
			headerSources.push(...row.sources);
			continue;
		}

		if (child.name === 'TableRow') {
			const row = extractTableRowData(state, child);
			rows.push(row.nodes);
			rowSources.push(row.sources);
		}
	}

	return {
		headers,
		rows,
		headerSources,
		rowSources,
		tableFrom: tableNode.from,
		tableTo  : tableNode.to,
	};
}

/**
 * セル AST を DOM へ展開する
 * @param {HTMLElement} parent 親要素
 * @param {TableCellNode[]} nodes セル AST
 * @returns {void}
 */
export function appendTableCellNodes(parent: HTMLElement, nodes: TableCellNode[]): void {
	for (const node of nodes) {
		if (node.kind === 'text') {
			parent.appendChild(document.createTextNode(node.text));
			continue;
		}

		if (node.kind === 'br') {
			parent.appendChild(document.createElement('br'));
			continue;
		}

		if (node.kind === 'html') {
			const el = document.createElement(node.tagName);
			applySanitizedAttributes(el, node.attributes);
			el.classList.add('cm-md-html', `cm-md-html-${node.tagName}`);
			appendTableCellNodes(el, node.children);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'em') {
			const el     = document.createElement('em');
			el.className = 'cm-md-em';
			appendTableCellNodes(el, node.children);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'strong') {
			const el     = document.createElement('strong');
			el.className = 'cm-md-strong';
			appendTableCellNodes(el, node.children);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'strike') {
			const el     = document.createElement('span');
			el.className = 'cm-md-strike';
			appendTableCellNodes(el, node.children);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'highlight') {
			const el     = document.createElement('mark');
			el.className = 'cm-md-highlight';
			appendTableCellNodes(el, node.children);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'code') {
			const el     = document.createElement('code');
			el.className = 'cm-md-code';
			appendHighlightedInlineCode(el, flattenTableCellText(node.children));
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'link') {
			const el     = document.createElement('span');
			el.className = 'cm-md-link';
			if (node.href) {
				el.dataset.href = node.href;
			}

			appendTableCellNodes(el, node.children);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'wikilink') {
			const el     = document.createElement('span');
			el.className = 'cm-md-wikilink';
			appendTableCellNodes(el, node.children);
			parent.appendChild(el);
		}
	}
}

/**
 * セル内容を DOM に設定する
 * @param {HTMLElement} cell セル要素
 * @param {TableCellNode[]} nodes セル AST
 * @returns {void}
 */
export function fillTableCellContent(cell: HTMLElement, nodes: TableCellNode[]): void {
	cell.textContent = '';
	appendTableCellNodes(cell, nodes);
}

/**
 * 表の最大列数を返す。
 * @param {TableData} data 表データ
 * @returns {number}
 */
export function getTableColumnCount(data: TableData): number {
	return Math.max(
		data.headerSources.length,
		...data.rowSources.map((row) => row.length),
		0,
	);
}

/**
 * 表示上の行番号（ヘッダ=0）からセルソースを返す。
 * @param {TableData} data 表データ
 * @param {TableCellPosition} position セル位置
 * @returns {TableCellSource | null}
 */
export function getTableCellSource(
	data: TableData,
	position: TableCellPosition,
): TableCellSource | null {
	if (position.row === 0) {
		return data.headerSources[position.column] ?? null;
	}

	return data.rowSources[position.row - 1]?.[position.column] ?? null;
}

/**
 * 縦移動でテーブル外から入る場合のフォーカス先を返す。
 * 上側からはヘッダー行、下側からは末尾行の第1列へ入る。
 * @param {EditorState} state エディタ状態
 * @param {number} from 移動前の文書位置
 * @param {number} to 通常の縦移動で求めた文書位置
 * @param {boolean} forward 下方向への移動なら true
 * @returns {TableVerticalEntryTarget | null} セルフォーカス先
 */
export function getTableVerticalEntryTarget(
	state: EditorState,
	from: number,
	to: number,
	forward: boolean,
): TableVerticalEntryTarget | null {
	const resolvePosition       = forward || to === 0 ? to : to - 1;
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(
		resolvePosition,
		forward ? 1 : -1,
	);
	while (node && node.name !== 'Table') {
		node = node.parent;
	}

	if (!node) {
		return null;
	}

	const enteredFromOutside = forward
		? from < node.from
		: from >= node.to;
	if (!enteredFromOutside) {
		return null;
	}

	const data     = extractTableData(state, node);
	const position = {
		row   : forward ? 0 : data.rowSources.length,
		column: 0,
	};
	const source   = getTableCellSource(data, position);
	if (!source) {
		return null;
	}

	return {
		tableFrom: data.tableFrom,
		position,
		sourceFrom: source.from,
	};
}

/**
 * 指定位置のテーブルウィジェットが現在のビューへ描画されているか返す。
 * @param {EditorView} view エディタビュー
 * @param {number} tableFrom 表開始位置
 * @returns {boolean} 描画済みなら true
 */
export function hasRenderedTableWidget(view: EditorView, tableFrom: number): boolean {
	return view.dom.querySelector(
		`.cm-md-table-wrap[data-table-from="${tableFrom}"]`,
	) !== null;
}

/**
 * contenteditable から取得した文字列を Markdown 表セル用に正規化する。
 * 改行は br、未エスケープのパイプはエスケープへ変換する。
 * @param {string} value 入力値
 * @returns {string}
 */
export function normalizeTableCellSource(value: string): string {
	const singleLine = value
		.replaceAll('\u00a0', ' ')
		.replace(/\r\n?/g, '\n')
		.replaceAll('\n', '<br>');
	let result       = '';

	for (let index = 0; index < singleLine.length; index += 1) {
		const character = singleLine[index]!;
		if (character !== '|') {
			result += character;
			continue;
		}

		let backslashCount = 0;
		for (let cursor = index - 1; cursor >= 0 && singleLine[cursor] === '\\'; cursor -= 1) {
			backslashCount += 1;
		}

		if (backslashCount % 2 === 0) {
			result += '\\';
		}

		result += character;
	}

	return result;
}

/**
 * 正規化後の Markdown ソース上でのキャレット位置を返す。
 * @param {string} value 正規化前の入力値
 * @param {number} offset 正規化前のキャレット位置
 * @returns {number}
 */
export function getNormalizedTableCellCaretOffset(value: string, offset: number): number {
	const boundedOffset = Math.max(0, Math.min(offset, value.length));
	return normalizeTableCellSource(value.slice(0, boundedOffset)).length;
}

/**
 * Markdown正規化後に再描画される編集用文字列上のキャレット位置を返す。
 * 改行は編集画面でも1文字のまま、未エスケープのパイプに追加されるバックスラッシュだけを加味する。
 * @param {string} value 正規化前の入力値
 * @param {number} offset 正規化前のキャレット位置
 * @returns {number}
 */
export function getTableCellEditableCaretOffset(value: string, offset: number): number {
	const boundedOffset = Math.max(0, Math.min(offset, value.length));
	const prefix        = value
		.slice(0, boundedOffset)
		.replaceAll('\u00a0', ' ')
		.replace(/\r\n?/g, '\n');
	let result          = prefix.length;

	for (let index = 0; index < prefix.length; index += 1) {
		if (prefix[index] === '|' && !isEscapedPipe(prefix, index)) {
			result += 1;
		}
	}

	return result;
}

/**
 * 表セル内の全選択ショートカットか判定する。
 * CodeMirror 本体へ伝播すると表全体のソース位置が選択されるため、セル側で処理する。
 * @param {Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key'>} event キーイベント
 * @returns {boolean}
 */
export function isTableCellSelectAllKey(
	event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key'>,
): boolean {
	return (event.ctrlKey || event.metaKey)
		&& !event.altKey
		&& event.key.toLowerCase() === 'a';
}

/**
 * 表セル内へソフト改行を入力するShift+Enterか判定する。
 * @param {Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>} event キーイベント
 * @returns {boolean}
 */
export function isTableCellSoftBreakKey(
	event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>,
): boolean {
	return event.key === 'Enter'
		&& event.shiftKey
		&& !event.ctrlKey
		&& !event.metaKey
		&& !event.altKey;
}

/**
 * 修飾キーなしの上下キーを表セルの縦移動方向へ変換する。
 * 左右キーはブラウザー標準のセル移動へ任せる。
 * @param {Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>} event キーイベント
 * @returns {'up' | 'down' | null}
 */
export function getTableCellVerticalArrowDirection(
	event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>,
): 'up' | 'down' | null {
	if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
		return null;
	}

	if (event.key === 'ArrowUp') {
		return 'up';
	}

	return event.key === 'ArrowDown' ? 'down' : null;
}

/**
 * 表セルの上下キー移動を解決する。
 * 上下端でも操作済みとして返し、ブラウザー標準処理による左右セルへの流出を防ぐ。
 * @param {TableData} data 表データ
 * @param {TableCellPosition} position 現在位置
 * @param {Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>} event キーイベント
 * @returns {TableCellVerticalNavigation | null}
 */
export function getTableCellVerticalNavigation(
	data: TableData,
	position: TableCellPosition,
	event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>,
): TableCellVerticalNavigation | null {
	const direction = getTableCellVerticalArrowDirection(event);
	if (!direction) {
		return null;
	}

	return {
		direction,
		target: getAdjacentTableCellPosition(data, position, direction),
	};
}

/**
 * セル編集を文書へ反映する変更を構築する。
 * @param {TableData} data 表データ
 * @param {TableCellPosition} position セル位置
 * @param {string} value 新しいセルソース
 * @returns {TableDocumentChange | null}
 */
export function buildTableCellChange(
	data: TableData,
	position: TableCellPosition,
	value: string,
): TableDocumentChange | null {
	const source = getTableCellSource(data, position);
	if (!source) {
		return null;
	}

	return {
		from  : source.from,
		to    : source.to,
		insert: normalizeTableCellSource(value),
	};
}

/**
 * Tab / Shift+Tab / Enter / 上下キーの移動先を返す。
 * @param {TableData} data 表データ
 * @param {TableCellPosition} position 現在位置
 * @param {'next' | 'previous' | 'up' | 'down'} direction 移動方向
 * @returns {TableCellPosition | null}
 */
export function getAdjacentTableCellPosition(
	data: TableData,
	position: TableCellPosition,
	direction: 'next' | 'previous' | 'up' | 'down',
): TableCellPosition | null {
	const columnCount = getTableColumnCount(data);
	const rowCount    = 1 + data.rowSources.length;
	if (columnCount === 0 || position.row < 0 || position.column < 0) {
		return null;
	}

	if (direction === 'up' || direction === 'down') {
		const row = position.row + (direction === 'down' ? 1 : -1);
		return row >= 0 && row < rowCount
			? { row, column: Math.min(position.column, columnCount - 1) }
			: null;
	}

	const currentIndex = position.row * columnCount + position.column;
	const targetIndex  = currentIndex + (direction === 'next' ? 1 : -1);
	if (targetIndex < 0 || targetIndex >= rowCount * columnCount) {
		return null;
	}

	return {
		row   : Math.floor(targetIndex / columnCount),
		column: targetIndex % columnCount,
	};
}

/**
 * 最終セルでの Tab 用に空行追加変更を構築する。
 * @param {EditorState} state エディタ状態
 * @param {TableData} data 表データ
 * @returns {TableDocumentChange | null}
 */
export function buildAppendTableRowChange(
	state: EditorState,
	data: TableData,
): TableDocumentChange | null {
	const columnCount = getTableColumnCount(data);
	if (columnCount === 0) {
		return null;
	}

	const separator = data.tableTo > 0 && state.doc.sliceString(data.tableTo - 1, data.tableTo) === '\n'
		? ''
		: '\n';
	return {
		from  : data.tableTo,
		to    : data.tableTo,
		insert: `${separator}| ${Array.from({ length: columnCount }, () => '').join(' | ')} |`,
	};
}

/**
 * contenteditable 内のキャレットオフセットを返す。
 * @param {HTMLElement} cell セル
 * @returns {number}
 */
const TABLE_CELL_INLINE_CLASSES: Record<TableCellInlineKind, string> = {
	em       : 'cm-md-em',
	strong   : 'cm-md-strong',
	strike   : 'cm-md-strike',
	highlight: 'cm-md-highlight',
	code     : 'cm-md-code',
	link     : 'cm-md-link',
	wikilink : 'cm-md-wikilink',
};

/**
 * キャレットを含むインライン要素のIDを返す。
 * 入れ子の場合は、それぞれの要素が所有する記法を表示するため全件を返す。
 * @param {TableCellInlineRange[]} inlineRanges インライン範囲
 * @param {number} caretOffset 編集文字列上のキャレット位置
 * @returns {number[]}
 */
export function getActiveTableCellInlineRangeIds(
	inlineRanges: TableCellInlineRange[],
	caretOffset: number,
): number[] {
	return inlineRanges
		.filter((inlineRange) => inlineRange.from < caretOffset && caretOffset < inlineRange.to)
		.map((inlineRange) => inlineRange.id);
}

/**
 * プレビュー表示上のキャレット位置を、記法を含む編集文字列上の位置へ変換する。
 * @param {string} text 編集用Markdown文字列
 * @param {TableCellInlineRange[]} inlineRanges インライン範囲
 * @param {number} previewOffset 記法を除いたプレビュー文字列上の位置
 * @returns {number}
 */
export function getTableCellEditableOffsetFromPreview(
	text: string,
	inlineRanges: TableCellInlineRange[],
	previewOffset: number,
): number {
	const markRanges    = inlineRanges
		.flatMap((inlineRange) => inlineRange.markRanges)
		.sort((a, b) => a.from - b.from || a.to - b.to);
	const visibleLength = text.length - markRanges.reduce(
		(total, markRange) => total + Math.max(0, markRange.to - markRange.from),
		0,
	);
	const boundedOffset = Math.max(0, Math.min(previewOffset, visibleLength));
	let visibleOffset   = 0;
	let sourceOffset    = 0;
	while (sourceOffset < text.length) {
		const markRange = markRanges.find(
			(range) => range.from <= sourceOffset && sourceOffset < range.to,
		);
		if (markRange) {
			sourceOffset = markRange.to;
			continue;
		}

		if (visibleOffset === boundedOffset) {
			return sourceOffset;
		}

		visibleOffset += 1;
		sourceOffset  += 1;
	}

	return text.length;
}

/**
 * セルを、ソースを保持したインラインライブプレビューDOMで埋める。
 * @param {HTMLElement} cell 編集対象セル
 * @param {string} text 編集用Markdown文字列
 * @param {TableCellInlineRange[]} inlineRanges インライン範囲
 * @returns {void}
 */
export function fillEditableTableCellContent(
	cell: HTMLElement,
	text: string,
	inlineRanges: TableCellInlineRange[],
): void {
	cell.textContent = '';
	const boundaries = new Set<number>([0, text.length]);
	for (const inlineRange of inlineRanges) {
		boundaries.add(Math.max(0, Math.min(text.length, inlineRange.from)));
		boundaries.add(Math.max(0, Math.min(text.length, inlineRange.to)));
		for (const markRange of inlineRange.markRanges) {
			boundaries.add(Math.max(0, Math.min(text.length, markRange.from)));
			boundaries.add(Math.max(0, Math.min(text.length, markRange.to)));
		}
	}

	const sortedBoundaries              = [...boundaries].sort((a, b) => a - b);
	let codeWrapper: HTMLElement | null = null;
	let codeWrapperId: number | null    = null;

	/**
	 * インラインコード全体を1つの背景で囲む親要素を返す
	 * @param {number} from セグメント開始
	 * @param {number} to セグメント終了
	 * @returns {HTMLElement}
	 */
	const getSegmentParent = (from: number, to: number): HTMLElement => {
		const codeOwner = inlineRanges.find((inlineRange) => (
			inlineRange.kind === 'code'
			&& inlineRange.from <= from
			&& to <= inlineRange.to
		));
		if (!codeOwner) {
			codeWrapper   = null;
			codeWrapperId = null;
			return cell;
		}

		if (codeWrapper === null || codeWrapperId !== codeOwner.id) {
			codeWrapper           = cell.ownerDocument.createElement('span');
			codeWrapper.className = 'cm-md-code';
			codeWrapperId         = codeOwner.id;
			cell.appendChild(codeWrapper);
		}

		return codeWrapper;
	};

	for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
		const from = sortedBoundaries[index]!;
		const to   = sortedBoundaries[index + 1]!;
		if (from >= to) {
			continue;
		}

		const segment      = text.slice(from, to);
		const parent       = getSegmentParent(from, to);
		const markerOwners = inlineRanges.filter((inlineRange) => inlineRange.markRanges.some(
			(markRange) => markRange.from <= from && to <= markRange.to,
		));
		if (markerOwners.length > 0) {
			const marker                = cell.ownerDocument.createElement('span');
			marker.className            = 'cm-md-table-source-mark';
			marker.dataset.inlineOwners = markerOwners.map((owner) => owner.id).join(',');
			marker.textContent          = segment;
			parent.appendChild(marker);
			continue;
		}

		const classNames = new Set(inlineRanges
			.filter((inlineRange) => inlineRange.from <= from && to <= inlineRange.to)
			.map((inlineRange) => TABLE_CELL_INLINE_CLASSES[inlineRange.kind]));
		if (parent !== cell) {
			classNames.delete('cm-md-code');
		}

		const codeOwner = inlineRanges.find((inlineRange) => (
			inlineRange.kind === 'code'
			&& inlineRange.codeLanguage
			&& inlineRange.from <= from
			&& to <= inlineRange.to
		));
		const language  = codeOwner?.codeLanguage
			? requestCodeLanguage(codeOwner.codeLanguage)
			: null;

		if (classNames.size === 0 && !language) {
			parent.appendChild(cell.ownerDocument.createTextNode(segment));
			continue;
		}

		const content     = cell.ownerDocument.createElement('span');
		content.className = [...classNames].join(' ');
		if (language) {
			appendHighlightedCodeText(content, segment, language);
		} else {
			content.textContent = segment;
		}

		parent.appendChild(content);
	}
}

/**
 * セル内の論理テキスト位置としてキャレット位置を返す。
 * 非表示のMarkdown記法テキストも文字数へ含める。
 * @param {HTMLElement} cell 編集対象セル
 * @returns {number}
 */
function getCellCaretOffset(cell: HTMLElement, countBreaks: boolean = false): number {
	const selection = cell.ownerDocument.defaultView?.getSelection();
	if (!selection || selection.rangeCount === 0) {
		return cell.textContent?.length ?? 0;
	}

	const range = selection.getRangeAt(0);
	if (!cell.contains(range.endContainer)) {
		return cell.textContent?.length ?? 0;
	}

	let offset = 0;
	let found  = false;
	/**
	 * @param {Node} node 対象ノード
	 * @returns {number}
	 */
	const getNodeLength = (node: Node): number => {
		if (node.nodeType === Node.TEXT_NODE) {
			return node.textContent?.length ?? 0;
		}

		if (countBreaks && node instanceof HTMLElement && node.tagName === 'BR') {
			return 1;
		}

		return [...node.childNodes].reduce((total, child) => total + getNodeLength(child), 0);
	};
	/**
	 * @param {Node} node 探索ノード
	 * @returns {void}
	 */
	const walk = (node: Node): void => {
		if (found) {
			return;
		}

		if (node === range.endContainer) {
			if (node.nodeType === Node.TEXT_NODE) {
				offset += Math.min(range.endOffset, node.textContent?.length ?? 0);
			} else {
				for (let index = 0; index < Math.min(range.endOffset, node.childNodes.length); index += 1) {
					offset += getNodeLength(node.childNodes[index]!);
				}
			}

			found = true;
			return;
		}

		if (node.nodeType === Node.TEXT_NODE) {
			offset += node.textContent?.length ?? 0;
			return;
		}

		if (countBreaks && node instanceof HTMLElement && node.tagName === 'BR') {
			offset += 1;
			return;
		}

		for (const child of node.childNodes) {
			walk(child);
			if (found) {
				return;
			}
		}
	};

	walk(cell);
	return found ? offset : cell.textContent?.length ?? 0;
}

/**
 * キャレット位置に応じて、該当インライン要素のMarkdown記法だけを表示する。
 * @param {HTMLElement} cell 編集対象セル
 * @returns {void}
 */
function updateTableCellInlineMarks(cell: HTMLElement): void {
	let inlineRanges: TableCellInlineRange[] = [];
	try {
		inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
	} catch {
		inlineRanges = [];
	}

	const activeIds = new Set(getActiveTableCellInlineRangeIds(inlineRanges, getCellCaretOffset(cell)));
	for (const marker of cell.querySelectorAll<HTMLElement>('.cm-md-table-source-mark')) {
		const owners = (marker.dataset.inlineOwners ?? '')
			.split(',')
			.filter(Boolean)
			.map(Number);
		marker.classList.toggle(
			'cm-md-table-source-mark-active',
			owners.some((owner) => activeIds.has(owner)),
		);
	}
}

/**
 * 現在のセル選択範囲へ実改行を挿入する。
 * @param {HTMLElement} cell 編集中セル
 * @returns {boolean} 挿入できたか
 */
function insertTableCellLineBreak(cell: HTMLElement): boolean {
	const selection = cell.ownerDocument.defaultView?.getSelection();
	if (!selection || selection.rangeCount === 0) {
		return false;
	}

	const range = selection.getRangeAt(0);
	if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) {
		return false;
	}

	range.deleteContents();
	const lineBreak = cell.ownerDocument.createTextNode('\n');
	range.insertNode(lineBreak);
	range.setStartAfter(lineBreak);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
	return true;
}

/**
 * セル内へキャレットまたは全選択を設定する。
 * @param {HTMLElement} cell セル
 * @param {number} offset キャレット位置
 * @param {boolean} selectAll 全選択するか
 * @returns {void}
 */
function setCellSelection(cell: HTMLElement, offset: number, selectAll: boolean): void {
	const selection = cell.ownerDocument.defaultView?.getSelection();
	if (!selection) {
		return;
	}

	const range = cell.ownerDocument.createRange();
	range.selectNodeContents(cell);
	if (!selectAll) {
		let remaining                                     = Math.max(0, Math.min(offset, cell.textContent?.length ?? 0));
		let target: { node: Node; offset: number } | null = null;
		/**
		 * @param {Node} node 探索ノード
		 * @returns {void}
		 */
		const walk = (node: Node): void => {
			if (target) {
				return;
			}

			if (node.nodeType === Node.TEXT_NODE) {
				const length = node.textContent?.length ?? 0;
				if (remaining <= length) {
					target = { node, offset: remaining };
					return;
				}

				remaining -= length;
				return;
			}

			for (const child of node.childNodes) {
				walk(child);
				if (target) {
					return;
				}
			}
		};

		walk(cell);
		const resolvedTarget = target as { node: Node; offset: number } | null;
		if (resolvedTarget) {
			range.setStart(resolvedTarget.node, resolvedTarget.offset);
			range.collapse(true);
		} else {
			range.collapse(false);
		}
	}

	selection.removeAllRanges();
	selection.addRange(range);
	updateTableCellInlineMarks(cell);
}

/**
 * セルをソース編集状態へ切り替える。
 * @param {HTMLElement} cell セル
 * @returns {void}
 */
function activateTableCell(cell: HTMLElement): void {
	if (cell.dataset.editing === 'true') {
		return;
	}

	cell.dataset.editing = 'true';
	cell.classList.add('cm-md-table-cell-editing');
	let inlineRanges: TableCellInlineRange[] = [];
	try {
		inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
	} catch {
		inlineRanges = [];
	}

	fillEditableTableCellContent(
		cell,
		cell.dataset.editableText ?? cell.dataset.source ?? '',
		inlineRanges,
	);
	updateTableCellInlineMarks(cell);
}

/**
 * 指定セルへフォーカスを戻す。
 * @param {EditorView} view エディタビュー
 * @param {number} tableFrom 表開始位置
 * @param {TableCellPosition} position セル位置
 * @param {number} offset キャレット位置
 * @param {boolean} selectAll 全選択するか
 * @returns {void}
 */
export function restoreTableCellFocus(
	view: EditorView,
	tableFrom: number,
	position: TableCellPosition,
	offset: number,
	selectAll: boolean,
): void {
	window.setTimeout(() => {
		const selector = [
			`.cm-md-table-wrap[data-table-from="${tableFrom}"]`,
			`[data-table-row="${position.row}"][data-table-column="${position.column}"]`,
		].join(' ');
		const cell     = view.dom.querySelector<HTMLElement>(selector);
		if (!cell) {
			return;
		}

		activateTableCell(cell);
		cell.focus({ preventScroll: true });
		setCellSelection(cell, offset, selectAll);
	}, 0);
}

/**
 * 表の上下端から、表外の隣接行へ移動する文書位置を返す。
 * @param {EditorState} state エディタ状態
 * @param {number} tableFrom 表開始位置
 * @param {number} tableTo 表終了位置
 * @param {boolean} forward 下方向なら true
 * @returns {number | null} 移動先行の先頭位置。文書端なら null
 */
export function getTableVerticalExitPosition(
	state: EditorState,
	tableFrom: number,
	tableTo: number,
	forward: boolean,
): number | null {
	const boundaryPosition = forward
		? Math.max(tableFrom, tableTo - 1)
		: tableFrom;

	const boundaryLine = state.doc.lineAt(boundaryPosition);
	const targetLine   = boundaryLine.number + (forward ? 1 : -1);
	if (targetLine < 1 || targetLine > state.doc.lines) {
		return null;
	}

	return state.doc.line(targetLine).from;
}

/**
 * 表セルから表外の隣接行へCodeMirrorのキャレットを移す。
 * @param {EditorView} view エディタビュー
 * @param {number} tableFrom 表開始位置
 * @param {number} tableTo 表終了位置
 * @param {boolean} forward 下方向なら true
 * @returns {boolean} 移動できたか
 */
function moveTableCellFocusOutside(
	view: EditorView,
	tableFrom: number,
	tableTo: number,
	forward: boolean,
): boolean {
	const target = getTableVerticalExitPosition(view.state, tableFrom, tableTo, forward);
	if (target === null) {
		return false;
	}

	view.dispatch({
		selection    : EditorSelection.cursor(target),
		scrollIntoView: true,
		userEvent    : 'select.vertical',
	});
	view.focus();
	return true;
}

/**
 * CodeMirror側へ渡った上下キーを、編集中の描画済み表セルで処理する。
 * 空セルでkeydownの送信先がセル外になる場合を補完し、上下端では表外へ移動する。
 * @param {EditorView} view エディタビュー
 * @param {boolean} forward 下方向なら true
 * @returns {boolean} 表セルの上下移動として処理したか
 */
export function moveActiveTableCellVertically(view: EditorView, forward: boolean): boolean {
	const cell = view.dom.querySelector<HTMLElement>('.cm-md-table-cell-editing');
	if (!cell) {
		return false;
	}

	const wrap      = cell.closest<HTMLElement>('.cm-md-table-wrap');
	const tableFrom = Number(wrap?.dataset.tableFrom);
	const tableTo   = Number(wrap?.dataset.tableTo);
	const row       = Number(cell.dataset.tableRow);
	const column    = Number(cell.dataset.tableColumn);
	if (
		!wrap
		|| !Number.isInteger(tableFrom)
		|| !Number.isInteger(tableTo)
		|| !Number.isInteger(row)
		|| !Number.isInteger(column)
	) {
		return false;
	}

	const targetRow  = row + (forward ? 1 : -1);
	const targetCell = wrap.querySelector<HTMLElement>(
		`[data-table-row="${targetRow}"][data-table-column="${column}"]`,
	);
	if (targetCell) {
		restoreTableCellFocus(
			view,
			tableFrom,
			{ row: targetRow, column },
			getCellCaretOffset(cell, true),
			false,
		);
	} else if (!moveTableCellFocusOutside(view, tableFrom, tableTo, forward)) {
		restoreTableCellFocus(view, tableFrom, { row, column }, getCellCaretOffset(cell, true), false);
	}
	return true;
}

/**
 * テーブル HTML ウィジェット
 */
export class TableWidget extends WidgetType {
	readonly data: TableData;
	readonly languageGeneration: number;

	/**
	 * @param {TableData} data テーブルデータ
	 */
	constructor(data: TableData) {
		super();
		this.data               = data;
		this.languageGeneration = getCodeLanguageGeneration();
	}

	/**
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		if (!(other instanceof TableWidget)) {
			return false;
		}

		return other.languageGeneration === this.languageGeneration
			&& JSON.stringify(other.data) === JSON.stringify(this.data);
	}

	/**
	 * @returns {HTMLElement}
	 */
	toDOM(view: EditorView): HTMLElement {
		const wrap     = document.createElement('div');
		wrap.className = 'cm-md-table-wrap';
		wrap.setAttribute('contenteditable', 'false');
		wrap.dataset.tableFrom = String(this.data.tableFrom);
		wrap.dataset.tableTo   = String(this.data.tableTo);

		const table       = document.createElement('table');
		table.className   = 'cm-md-table';
		const columnCount = getTableColumnCount(this.data);

		/**
		 * 編集可能セルを生成する。
		 * @param {'th' | 'td'} tagName 要素名
		 * @param {TableCellNode[]} nodes 表示ノード
		 * @param {TableCellSource | undefined} source セルソース
		 * @param {TableCellPosition} position セル位置
		 * @returns {HTMLTableCellElement}
		 */
		const createCell = (
			tagName: 'th' | 'td',
			nodes: TableCellNode[],
			source: TableCellSource | undefined,
			position: TableCellPosition,
		): HTMLTableCellElement => {
			const cell = document.createElement(tagName);

			cell.dataset.tableRow     = String(position.row);
			cell.dataset.tableColumn  = String(position.column);
			cell.dataset.source       = source?.text ?? '';
			cell.dataset.editableText = source?.editableText ?? '';
			cell.dataset.inlineRanges = JSON.stringify(source?.inlineRanges ?? []);
			cell.contentEditable      = view.state.readOnly || !source ? 'false' : 'plaintext-only';
			cell.spellcheck           = false;
			cell.setAttribute('aria-label', `表 ${position.row + 1} 行 ${position.column + 1} 列`);
			fillTableCellContent(cell, nodes);

			if (!source || view.state.readOnly) {
				return cell;
			}

			let composing                = false;
			let compositionCommitPending = false;
			/**
			 * セルの表示値を CodeMirror 文書へ反映する。
			 * @param {string} userEvent CodeMirror のユーザーイベント名
			 * @returns {void}
			 */
			const dispatchCellValue = (userEvent: string): void => {
				const value       = cell.textContent ?? '';
				const caretOffset = getTableCellEditableCaretOffset(value, getCellCaretOffset(cell));
				const change      = buildTableCellChange(this.data, position, value);
				if (!change || change.insert === source.text) {
					return;
				}

				view.dispatch({ changes: change, userEvent });
				restoreTableCellFocus(
					view,
					this.data.tableFrom,
					position,
					Math.min(caretOffset, change.insert.length),
					false,
				);
			};

			cell.addEventListener('mouseup', () => {
				if (cell.dataset.editing === 'true') {
					updateTableCellInlineMarks(cell);
				}
			});
			cell.addEventListener('keyup', () => updateTableCellInlineMarks(cell));
			cell.addEventListener('focus', () => {
				if (cell.dataset.editing === 'true') {
					return;
				}

				window.setTimeout(() => {
					if (cell.dataset.editing === 'true') {
						return;
					}

					let inlineRanges: TableCellInlineRange[] = [];
					try {
						inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
					} catch {
						inlineRanges = [];
					}

					const editableText   = cell.dataset.editableText ?? cell.dataset.source ?? '';
					const previewOffset  = getCellCaretOffset(cell, true);
					const editableOffset = getTableCellEditableOffsetFromPreview(
						editableText,
						inlineRanges,
						previewOffset,
					);
					activateTableCell(cell);
					setCellSelection(cell, editableOffset, false);
				}, 0);
			});
			cell.addEventListener('blur', () => {
				if (composing || compositionCommitPending) {
					composing                = false;
					compositionCommitPending = false;
					dispatchCellValue('input.type.compose');
				}

				cell.dataset.editing = 'false';
				cell.classList.remove('cm-md-table-cell-editing');
				fillTableCellContent(cell, nodes);
			});
			cell.addEventListener('compositionstart', () => {
				composing                = true;
				compositionCommitPending = false;
			});
			cell.addEventListener('compositionend', () => {
				composing                = false;
				compositionCommitPending = true;
				window.setTimeout(() => {
					if (!compositionCommitPending) {
						return;
					}

					compositionCommitPending = false;
					dispatchCellValue('input.type.compose');
				}, 0);
			});
			cell.addEventListener('input', (event) => {
				const inputEvent = event as InputEvent;
				if (composing || inputEvent.isComposing) {
					return;
				}

				const userEvent          = compositionCommitPending
					? 'input.type.compose'
					: 'input.type';
				compositionCommitPending = false;
				dispatchCellValue(userEvent);
			});
			cell.addEventListener('keydown', (event) => {
				if (event.isComposing || composing) {
					return;
				}

				if (isTableCellSelectAllKey(event)) {
					event.preventDefault();
					event.stopPropagation();
					setCellSelection(cell, 0, true);
					return;
				}

				if (isTableCellSoftBreakKey(event)) {
					event.preventDefault();
					event.stopPropagation();
					if (insertTableCellLineBreak(cell)) {
						dispatchCellValue('input.type');
					}
					return;
				}

				const modKey = event.ctrlKey || event.metaKey;
				if (modKey && !event.altKey && event.key.toLowerCase() === 'z') {
					event.preventDefault();
					event.stopPropagation();
					const command = event.shiftKey ? redo : undo;
					if (command(view)) {
						restoreTableCellFocus(view, this.data.tableFrom, position, 0, true);
					}
					return;
				}

				if (modKey && !event.altKey && event.key.toLowerCase() === 'y') {
					event.preventDefault();
					event.stopPropagation();
					if (redo(view)) {
						restoreTableCellFocus(view, this.data.tableFrom, position, 0, true);
					}
					return;
				}

				const verticalNavigation = getTableCellVerticalNavigation(this.data, position, event);
				if (verticalNavigation) {
					event.preventDefault();
					event.stopPropagation();
					if (verticalNavigation.target) {
						restoreTableCellFocus(
							view,
							this.data.tableFrom,
							verticalNavigation.target,
							getCellCaretOffset(cell, true),
							false,
						);
					} else if (!moveTableCellFocusOutside(
						view,
						this.data.tableFrom,
						this.data.tableTo,
						verticalNavigation.direction === 'down',
					)) {
						restoreTableCellFocus(
							view,
							this.data.tableFrom,
							position,
							getCellCaretOffset(cell, true),
							false,
						);
					}
					return;
				}

				if (event.key !== 'Tab' && event.key !== 'Enter') {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				const direction = event.key === 'Enter'
					? 'down'
					: event.shiftKey ? 'previous' : 'next';
				const target    = getAdjacentTableCellPosition(this.data, position, direction);
				if (target) {
					restoreTableCellFocus(view, this.data.tableFrom, target, 0, true);
					return;
				}

				if (event.key !== 'Tab' || event.shiftKey) {
					return;
				}

				const change = buildAppendTableRowChange(view.state, this.data);
				if (!change) {
					return;
				}

				view.dispatch({ changes: change, userEvent: 'input.type' });
				restoreTableCellFocus(
					view,
					this.data.tableFrom,
					{ row: this.data.rowSources.length + 1, column: 0 },
					0,
					true,
				);
			});
			return cell;
		};

		if (this.data.headers.length > 0) {
			const thead = document.createElement('thead');
			const tr    = document.createElement('tr');
			for (let index = 0; index < columnCount; index += 1) {
				tr.appendChild(createCell(
					'th',
					this.data.headers[index] ?? [],
					this.data.headerSources[index],
					{ row: 0, column: index },
				));
			}

			thead.appendChild(tr);
			table.appendChild(thead);
		}

		if (this.data.rows.length > 0) {
			const tbody = document.createElement('tbody');
			for (let rowIndex = 0; rowIndex < this.data.rows.length; rowIndex += 1) {
				const row = this.data.rows[rowIndex]!;
				const tr  = document.createElement('tr');
				for (let index = 0; index < columnCount; index += 1) {
					tr.appendChild(createCell(
						'td',
						row[index] ?? [],
						this.data.rowSources[rowIndex]?.[index],
						{ row: rowIndex + 1, column: index },
					));
				}

				tbody.appendChild(tr);
			}

			table.appendChild(tbody);
		}

		wrap.appendChild(table);
		return wrap;
	}

	/**
	 * 行数に応じた推定高さ（ビューポート計測の安定化）
	 * @returns {number}
	 */
	get estimatedHeight(): number {
		const rowCount = this.data.headers.length > 0
			? 1 + this.data.rows.length
			: this.data.rows.length;
		return Math.max(1, rowCount) * 42 + 14;
	}

	/**
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * テーブル全体をウィジェットへ置換する Decoration を追加する
 * （複数行 replace はインライン。`block: true` は使わない）
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} from 開始位置
 * @param {number} to 終了位置
 * @param {TableData} data テーブルデータ
 * @returns {void}
 */
export function pushTableReplace(
	entries: DecorationEntry[],
	from: number,
	to: number,
	data: TableData,
): void {
	if (from >= to) {
		return;
	}

	entries.push({
		from,
		to,
		decoration: Decoration.replace({
			widget: new TableWidget(data),
		}),
	});
}
