/**
 * ライブプレビューの Markdown 表をウィジェットで描き、セル編集とメニュー操作の文書変更を組み立てる
 * 折りたたみや画像幅の記憶は対応するモジュールが持ち、このファイルは表の表示と編集の境界を持つ
 * @file
 */
import { redo, undo } from '@codemirror/commands';
import { Decoration, type EditorView, WidgetType } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
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
import { documentContextFacet } from './documentContext';
import {
	ImageWidget,
	bindImageResizePersister,
	bindImageWrapEditorView,
	classifyImageSource,
	getImageWrapPath,
	type ImageSpec,
} from './imageWidget';
import { splitImageAlt, splitWikiEmbedTarget } from './imageSize';
import { splitWikiLinkAlias } from './wikiLink';
import type { DecorationEntry } from './inlineDecorations';
import {
	forgetCellImageWidth,
	recallCellImageWidth,
	rememberCellImageWidth,
} from './cellImageWidthMemory';
import {
	applyImageDisplayWidth,
	applyImageWidthByPath,
	applyImageWidthOnDocumentLine,
	replaceImageWidthInCellText,
} from './imageResize';
import {
	attachTableHorizontalOverflow,
	attachTableResize,
	collectTableCellBoxes,
	computeColumnRightEdges,
	forgetTableLayout,
	getTableLayoutKey,
	resolveTableRelativeOffset,
	type TableLayout,
	type TableResizeHit,
} from './tableResize';
import {
	buildAlignTableCellsChanges,
	buildMergeTableCellsChanges,
	buildTableLayoutChange,
	buildTableOccupancy,
	buildUnmergeTableCellsChanges,
	cellAlignmentClassNames,
	describeTableCellSelection,
	formatCellSpan,
	getTableMergeActionState,
	getVisibleAdjacentTableCellPosition,
	isCoveredTableCell,
	isMultiCellTableSelectionRect,
	normalizeTableSelectionRect,
	parseCellSpan,
	readTableLayout,
	resolveTableMergeRect,
	stripCellSpanFromNodes,
	type TableAlignPatch,
	type TableMergeActionState,
	type TableSelectionRect,
	type TableSizeLayout,
} from './tableMerge';
import {
	buildTableStructureChange,
	buildTableStructureGroups,
	getTableStructureActionState,
	resolveTableStructureContextSelection,
	shouldHideTableStructureControls,
	type TableStructureAction,
	type TableStructureAxis,
	type TableStructureRange,
	type TableStructureSelection,
} from './tableStructure';

export {
	clearCellImageWidths,
	forgetCellImageWidth,
	recallCellImageWidth,
	rememberCellImageWidth,
} from './cellImageWidthMemory';

export { isBreakHtmlTag };

// ==============================================
// セルの表示データ
// ==============================================
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
	| { kind: 'wikilink'; children: TableCellNode[] }
	| { kind: 'image'; spec: ImageSpec };

/** ウィジェットが描く表。表示ノードと、編集に使うソース位置を持つ */
export type TableData = {
	/** 見出しセルの表示ノード。左から順 */
	headers: TableCellNode[][];
	/** 本体行。行、セル、表示ノードの順 */
	rows: TableCellNode[][][];
	/** 見出しセルのソース範囲。列順 */
	headerSources: TableCellSource[];
	/** 本体セルのソース範囲。行、列の順 */
	rowSources: TableCellSource[][];
	/** 表構文の開始位置 */
	tableFrom: number;
	/** 表構文の終端 */
	tableTo: number;
};

/** セル内の文字範囲。文書位置ではなく、セルソース内の位置にも使う */
type TableCellRange = {
	/** 範囲の開始 */
	from: number;
	/** 範囲の終端 */
	to: number;
};

/** 1セルのソースと、編集中に使う文字列、インライン範囲 */
export type TableCellSource = {
	/** セルソースの文書上の開始 */
	from: number;
	/** セルソースの文書上の終端 */
	to: number;
	/** 属性を含むセルソース */
	text: string;
	/** 編集欄へ出す文字列。改行タグは畳んである */
	editableText: string;
	/** 編集文字列上のインライン装飾 */
	inlineRanges: TableCellInlineRange[];
};

/** セル内インラインの種類。強調、コード、リンク */
export type TableCellInlineKind = 'em' | 'strong' | 'strike' | 'highlight' | 'code' | 'link' | 'wikilink';

/** 編集文字列上の1つのインライン範囲 */
export type TableCellInlineRange = {
	/** セル内で一意な番号。キャレットが中にあるかの判定に使う */
	id: number;
	/** インラインの種類 */
	kind: TableCellInlineKind;
	/** 編集文字列上の開始 */
	from: number;
	/** 編集文字列上の終端 */
	to: number;
	/** その中で記法トークンとして隠す範囲 */
	markRanges: TableCellRange[];
	/** コードの言語。言語指定が無ければ未設定 */
	codeLanguage?: string;
};

/** セル編集を始めるときの文字列とインライン範囲 */
type EditableCellData = {
	/** 編集欄の初期文字列 */
	text: string;
	/** その文字列上のインライン範囲 */
	inlineRanges: TableCellInlineRange[];
};

/** 1行分の表示ノードとセルソース */
type TableRowData = {
	/** セルごとの表示ノード */
	nodes: TableCellNode[][];
	/** セルごとのソース */
	sources: TableCellSource[];
};

/** 表の中のセル位置。行は見出しを 0 とする */
export type TableCellPosition = {
	/** 行番号。0 は見出し */
	row: number;
	/** 列番号。0 始まり */
	column: number;
};

/** 上下キーで表へ入るときの、入り先 */
export type TableVerticalEntryTarget = {
	/** 入る表の開始位置 */
	tableFrom: number;
	/** 入るセル */
	position: TableCellPosition;
	/** 入るセルのソース開始。キャレット復元に使う */
	sourceFrom: number;
};

/** セル内の上下キーが、表の外か隣セルへ出るか */
export type TableCellVerticalNavigation = {
	/** up か down */
	direction: 'up' | 'down';
	/** 移動先セル。表の外へ出るなら null */
	target: TableCellPosition | null;
};

/** 表操作がエディタへ渡す1つの置換 */
export type TableDocumentChange = {
	/** 置換の開始位置 */
	from: number;
	/** 置換の終端。挿入だけなら from と同じ */
	to: number;
	/** 入れる文字列。削除だけなら空文字 */
	insert: string;
};

/** セル HTML を表示ノードへ組むときの、未閉鎖のタグ */
type HtmlStackFrame = {
	/** 小文字のタグ名 */
	tagName: string;
	/** サニタイズ済みの class と style */
	attributes: SanitizedHtmlAttributes;
	/** そのタグの中へ積んだ表示ノード */
	children: TableCellNode[];
};

/**
 * `|` がバックスラッシュでエスケープされているか判定する
 * @param text - 行文字列
 * @param index - `|` の位置
 * @returns `|` がバックスラッシュでエスケープされているなら true
 */
function isEscapedPipe(text: string, index: number): boolean {
	let backslashCount = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
		backslashCount += 1;
	}

	return backslashCount % 2 === 1;
}

/**
 * セル境界の前後空白を除く
 * @param text - 行文字列
 * @param from - 行内開始位置
 * @param to - 行内終了位置
 * @param lineFrom - 行の絶対開始位置
 * @returns セル境界の前後空白を除く
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
 * Markdown テーブル行の `|` 区切りから、空セルを含む列範囲を復元する
 * @param state - エディタ状態
 * @param rowNode - TableHeader / TableRow ノード
 * @returns Markdown テーブル行の `|` 区切りから、空セルを含む列範囲を復元する
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
 * 行ノード直下の TableCell ノードを取得する
 * @param rowNode - TableHeader / TableRow ノード
 * @returns 行ノード直下の TableCell ノード
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
 * セル範囲に対応する TableCell ノードを探す
 * @param cells - TableCell ノード一覧
 * @param used - 使用済みノード
 * @param range - セル範囲
 * @returns セル範囲に対応する TableCell ノード。無ければ null
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

/** セル内インラインとして扱う種類。実行中は変えない */
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
 * Markdownソース位置を、HTML改行タグを1文字へ畳み込んだ編集文字列上の位置へ変換する
 * @param position - Markdownソース上の絶対位置
 * @param cellRange - セル範囲
 * @param breakRanges - HTML改行タグ範囲
 * @returns 変換後のMarkdownソース位置を、HTML改行タグを1文字へ畳み込んだ編集文字列上の位置
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
 * インライン要素自身が所有する記法トークン範囲を返す
 * 入れ子要素のマーカーは、その入れ子要素側で個別に扱う
 * @param node - インライン構文ノード
 * @returns インライン要素自身が所有する記法トークン範囲
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
 * WikiLink のパスと区切り（`|` / `\|`）を、編集中は記法として隠す範囲で返す
 * @param state - エディタ状態
 * @param node - WikiLink ノード
 * @returns WikiLink のパスと区切り（`|` / `\|`）を、編集中は記法として隠す範囲で返す。無ければ null
 */
function wikiLinkAliasHideRange(state: EditorState, node: SyntaxNode): TableCellRange | null {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.name !== 'WikiLinkPage' || child.from >= child.to) {
			continue;
		}

		const split = splitWikiLinkAlias(state.doc.sliceString(child.from, child.to));
		if (!split.alias || split.hideLength <= 0) {
			return null;
		}

		return { from: child.from, to: child.from + split.hideLength };
	}

	return null;
}

/**
 * WikiLink の表示ノードを返す。エイリアスがあればラベルだけにする
 * @param state - エディタ状態
 * @param node - WikiLink ノード
 * @returns WikiLink の表示ノードを返す。エイリアスがあればラベルだけにする
 */
function wikiLinkDisplayNodes(state: EditorState, node: SyntaxNode): TableCellNode[] {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.name !== 'WikiLinkPage' || child.from >= child.to) {
			continue;
		}

		const raw   = state.doc.sliceString(child.from, child.to);
		const split = splitWikiLinkAlias(raw);
		const text  = split.alias ?? raw;
		return text ? [{ kind: 'text', text }] : [];
	}

	return [];
}

/**
 * InlineCode の `{java}` 接頭辞（直後の空白含む）を、既知言語なら隠し対象として返す
 * @param state - エディタ状態
 * @param node - InlineCode ノード
 * @returns InlineCode の `{java}` 接頭辞（直後の空白含む）を、既知言語なら隠し対象として返す。無ければ null
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
 * セルのMarkdownソースから編集用文字列とインライン装飾範囲を返す
 * HTML改行タグだけを実改行へ変換し、インラインコード内などHTMLTagとして解析されない
 * `<br>` は文字列のまま保持する
 * @param state - エディタ状態
 * @param range - セル範囲
 * @param cellNode - 対応するTableCellノード
 * @returns セルのMarkdownソースから編集用文字列とインライン装飾範囲
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
		if (kind === 'wikilink') {
			const aliasHide = wikiLinkAliasHideRange(state, ref.node);
			if (aliasHide) {
				markRanges.push(aliasHide);
			}
		}

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
 * TableHeader / TableRow から空セルを含むセル配列を抽出する
 * @param state - エディタ状態
 * @param rowNode - TableHeader / TableRow ノード
 * @returns TableHeader / TableRow から空セルを含むセル配列
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
		const soleImage = extractSoleTableCellImage(state, range);
		if (soleImage) {
			return [soleImage];
		}

		const cell = matchedCells[index] ?? null;
		if (cell) {
			return extractTableCellNodes(state, cell);
		}

		const raw = state.doc.sliceString(range.from, range.to);
		return raw ? [{ kind: 'text', text: raw }] : [];
	});
	const sources = ranges.map((range, index) => {
		const editable = extractEditableCellData(state, range, matchedCells[index] ?? null);
		const raw      = state.doc.sliceString(range.from, range.to);
		const span     = parseCellSpan(editable.text);
		return {
			...range,
			text        : raw,
			editableText: span.text,
			inlineRanges: editable.inlineRanges.filter((item) => item.from < span.text.length),
		};
	});
	return {
		nodes: nodes.map((cellNodes, index) => stripCellSpanFromNodes(cellNodes, sources[index]?.text ?? '')),
		sources,
	};
}

/**
 * HTML 開タグをスタックへ積む
 * @param current - 現在の子配列
 * @param stack - スタック
 * @param tagName - タグ名
 * @param attributes - 属性
 * @returns HTML 開タグをスタックへ積む
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
 * @param stack - スタック
 * @param tagName - タグ名
 * @param root - ルート配列
 * @returns HTML 閉タグでスタックを閉じる
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
 * @param state - エディタ状態
 * @param node - ノード
 * @returns 変換後のセル部分木を TableCellNode 配列
 */
function extractInlineNodes(state: EditorState, node: SyntaxNode): TableCellNode[] {
	const root: TableCellNode[]       = [];
	const htmlStack: HtmlStackFrame[] = [];
	let current: TableCellNode[]      = root;
	let cursor                        = node.from;

	/** 構文ノード間に残る通常テキストを、現在のHTML階層へ追加する */
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
			current.push({ kind: 'wikilink', children: wikiLinkDisplayNodes(state, child) });
			cursor = child.to;
			continue;
		}

		if (name === 'WikiEmbed') {
			const raw = state.doc.sliceString(child.from, child.to);
			if (raw.startsWith('![[') && raw.endsWith(']]')) {
				current.push(createTableCellImage(
					state,
					child.from,
					child.to,
					raw.slice(3, -2),
					'',
					true,
				));
				cursor = child.to;
				continue;
			}
		}

		if (name === 'Image') {
			const raw      = state.doc.sliceString(child.from, child.to);
			const closeAlt = raw.indexOf('](');
			if (raw.startsWith('![') && closeAlt >= 0 && raw.endsWith(')')) {
				current.push(createTableCellImage(
					state,
					child.from,
					child.to,
					raw.slice(closeAlt + 2, -1),
					raw.slice(2, closeAlt),
					false,
				));
				cursor = child.to;
				continue;
			}
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
 * @param state - エディタ状態
 * @param cellNode - TableCell ノード
 * @returns TableCell ノードから表示 AST
 */
export function extractTableCellNodes(state: EditorState, cellNode: SyntaxNode): TableCellNode[] {
	return extractInlineNodes(state, cellNode);
}

/**
 * セル AST をトリムなしでプレーンテキスト化する
 * @param nodes - セル AST
 * @returns セル AST をトリムなしでプレーンテキスト化する
 */
function flattenTableCellText(nodes: TableCellNode[]): string {
	const parts: string[] = [];
	/**
	 * @param items - ノード
	 */
	const walk            = (items: TableCellNode[]): void => {
		for (const item of items) {
			if (item.kind === 'text') {
				parts.push(item.text);
				continue;
			}

			if (item.kind === 'br') {
				parts.push('\n');
				continue;
			}

			if (item.kind === 'image') {
				parts.push(item.spec.alt || item.spec.raw);
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
 * @param nodes - セル AST
 * @returns 変換後のセル AST をプレーンテキスト
 */
export function tableCellNodesToPlainText(nodes: TableCellNode[]): string {
	return flattenTableCellText(nodes).trim();
}

/**
 * Table ノードからヘッダ・行データを抽出する
 * @param state - エディタ状態
 * @param tableNode - Table ノード
 * @returns Table ノードからヘッダ・行データ
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
 * ソースの幅が無ければ、ドラッグ中に覚えた幅を使う
 * @param path - 画像パス
 * @param parsed - ソースの幅
 * @returns ソースの幅が無ければ、ドラッグ中に覚えた幅を使う。無ければ null
 */
function resolveCellImageWidth(path: string, parsed: number | null): number | null {
	if (parsed && parsed > 0) {
		rememberCellImageWidth(path, parsed);
		return parsed;
	}

	return recallCellImageWidth(path) ?? null;
}

/**
 * セルソースが画像だけならパスと幅を返す
 * @param text - セルソース
 * @returns セルソースが画像だけならパスと幅
 */
function parseSoleCellImageRef(text: string): { path: string; width: number | null } | null {
	const trimmed = parseCellSpan(text).text.trim();
	const wiki    = /^!\[\[([\s\S]*?)\]\]$/.exec(trimmed);
	if (wiki) {
		const { path, size } = splitWikiEmbedTarget(wiki[1] ?? '');
		return path ? { path, width: size.width } : null;
	}

	const markdown = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed);
	if (!markdown) {
		return null;
	}

	const { size } = splitImageAlt(markdown[1] ?? '');
	const path     = (markdown[2] ?? '').trim();
	return path ? { path, width: size.width } : null;
}

/**
 * ソース編集で幅指定や画像自体を消したら、覚えた幅も消す
 * @param previous - 編集前
 * @param next - 編集後
 */
function forgetCellImageWidthIfSourceDropped(
	previous: string,
	next: string,
	position: TableCellPosition,
): void {
	const prev = parseSoleCellImageRef(previous);
	if (!prev) {
		return;
	}

	const after = parseSoleCellImageRef(next);
	if (!after || after.path !== prev.path || !after.width) {
		forgetCellImageWidth(prev.path, position);
	}
}

/**
 * 画像の `\|幅` / `|幅` と列幅・行高を除いて、表の再描画判定用テキストにする
 * 幅だけ変わったときに表 DOM を作り直さない
 * @param text - セルソース
 * @returns 画像の `\|幅` / `|幅` と列幅・行高を除いて、表の再描画判定用テキストにする
 */
export function normalizeTableCellTextForIdentity(text: string): string {
	const span = parseCellSpan(text);
	return formatCellSpan(span.text, span.colspan, span.rowspan, span.align, span.valign)
		.replace(/\\\|(\d+)(?:x\d+)?(?=\]\])/gi, '')
		.replace(/\|(\d+)(?:x\d+)?(?=\]\])/gi, '')
		.replace(/\\\|(\d+)(?:x\d+)?(?=\]\()/gi, '')
		.replace(/\|(\d+)(?:x\d+)?(?=\]\()/gi, '');
}

/**
 * セルの配置だけを再描画判定用のキーにする
 * @param text - セルソース
 * @returns セルの配置だけを再描画判定用のキーにする
 */
function tableCellAlignmentIdentity(text: string): string {
	const span = parseCellSpan(text);
	return `${span.align}:${span.valign}`;
}

/**
 * 表の再描画判定用キーを返す
 * 位置・行列構造・配置を見る。配置が同じだと CodeMirror が表 DOM を差し替えず、プレビューが古いまま残る
 * @param data - 表データ
 * @returns 表の再描画判定用キー
 */
export function getTableDataIdentity(data: TableData): string {
	const occupancy = buildTableOccupancy(data);
	return JSON.stringify({
		tableFrom: data.tableFrom,
		columns  : occupancy.columnCount,
		rows     : occupancy.rowCount,
		spans    : occupancy.cells.map((row) => row.map((cell) => (
			cell.covered ? 'x' : `${cell.colspan}x${cell.rowspan}`
		))),
		aligns   : [
			data.headerSources.map((source) => tableCellAlignmentIdentity(source.text)),
			...data.rowSources.map((row) => row.map((source) => tableCellAlignmentIdentity(source.text))),
		],
	});
}

/**
 * 画像幅の書き戻しでずれたセル位置を、既存ウィジェット側へ反映する
 * @param data - 表データ
 * @param position - 書き換えたセル
 * @param width - 幅
 * @returns 増えた文字数
 */
export function syncTableDataAfterImageWidth(
	data: TableData,
	position: TableCellPosition,
	width: number,
): number {
	const source = getTableCellSource(data, position);
	if (!source) {
		return 0;
	}

	const next = replaceImageWidthInCellText(source.text, width, true);
	if (next === null || next === source.text) {
		return 0;
	}

	const delta         = next.length - source.text.length;
	const oldTo         = source.to;
	source.text         = next;
	source.editableText = next;
	source.to           = source.from + next.length;
	data.tableTo       += delta;

	/**
	 * 書き戻し位置より後ろのセル範囲をずらす
	 * @param other - 他セル
	 */
	const shiftSource = (other: TableCellSource): void => {
		if (other === source || other.from < oldTo) {
			return;
		}

		other.from += delta;
		other.to   += delta;
	};

	data.headerSources.forEach(shiftSource);
	data.rowSources.forEach((row) => row.forEach(shiftSource));

	/**
	 * @param nodes - ノード
	 */
	const shiftNodes = (nodes: TableCellNode[]): void => {
		for (const node of nodes) {
			if (node.kind === 'image') {
				if (node.spec.sourceTo !== undefined && node.spec.sourceTo >= oldTo) {
					node.spec.sourceTo += delta;
				}

				if (node.spec.sourceFrom !== undefined && node.spec.sourceFrom >= oldTo) {
					node.spec.sourceFrom += delta;
				}

				if (node.spec.sourceFrom !== undefined && node.spec.sourceFrom < oldTo) {
					node.spec.width  = width;
					node.spec.height = null;
				}
			}

			if ('children' in node) {
				shiftNodes(node.children);
			}
		}
	};

	data.headers.forEach(shiftNodes);
	data.rows.forEach((row) => row.forEach(shiftNodes));
	return delta;
}

/**
 * 位置を含む Table ノードを返す
 * 表の終端や表と表の隙間では、次の表を拾わない
 * @param state - 状態
 * @param pos - 位置
 * @returns 位置を含む Table ノード
 */
export function findTableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
	ensureSyntaxTree(state, state.doc.length, 200);
	const clamped                = Math.max(0, Math.min(pos, state.doc.length));
	let found: SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * @param ref - ノード
		 * @returns 子の走査を止めるとき false。続けるときは値を返さない
		 */
		enter(ref) {
			if (ref.name !== 'Table') {
				return;
			}

			if (ref.from === clamped || (ref.from <= clamped && clamped < ref.to)) {
				found = ref.node;
				return false;
			}

			if (ref.from > clamped) {
				return false;
			}
		},
	});
	return found;
}

/**
 * 操作中の表ラッパーから、書き戻し先の表開始位置を取る
 * ウィジェットが再利用されても、いま見えている DOM の位置を優先する
 * @param view - エディタ
 * @param wrap - 表ラッパー
 * @returns 操作中の表ラッパーから、書き戻し先の表開始位置を取る。無ければ null
 */
export function resolveTableFromForPersist(view: EditorView, wrap: HTMLElement): number | null {
	try {
		const fromDom   = view.posAtDOM(wrap);
		const tableNode = Number.isInteger(fromDom) ? findTableNodeAt(view.state, fromDom) : null;
		if (tableNode) {
			return tableNode.from;
		}
	} catch {
		// wrap が editor 外のときは dataset へ倒す
	}

	const fromData = Number(wrap.dataset.tableFrom);
	if (!Number.isInteger(fromData)) {
		return null;
	}

	const tableNode = findTableNodeAt(view.state, fromData);
	return tableNode ? tableNode.from : null;
}

/**
 * セルの現在の表示 AST を文書から取り出す
 * @param state - 状態
 * @param tableFrom - 表開始位置
 * @param position - セル位置
 * @returns セルの現在の表示 AST を文書から取り出す。無ければ null
 */
export function getCurrentTableCellNodes(
	state: EditorState,
	tableFrom: number,
	position: TableCellPosition,
): TableCellNode[] | null {
	const tableNode = findTableNodeAt(state, tableFrom);
	if (!tableNode) {
		return null;
	}

	const data = extractTableData(state, tableNode);
	if (position.row === 0) {
		return data.headers[position.column] ?? null;
	}

	return data.rows[position.row - 1]?.[position.column] ?? null;
}

/**
 * 画像ノードの表示幅を更新する
 * @param nodes - セル AST
 * @param width - 幅
 */
function updateImageNodeWidths(nodes: TableCellNode[], width: number): void {
	for (const node of nodes) {
		if (node.kind === 'image') {
			node.spec.width  = width;
			node.spec.height = null;
		}

		if ('children' in node) {
			updateImageNodeWidths(node.children, width);
		}
	}
}

/**
 * プレビューが画像だけのセルか判定する
 * @param cell - セル
 * @returns プレビューが画像だけのセルなら true
 */
function cellShowsOnlyImage(cell: HTMLElement): boolean {
	const children = [...cell.children];
	return children.length === 1 && children[0]!.classList.contains('cm-md-image-wrap');
}

/**
 * セル内の画像へ、ソースまたは記憶した幅を適用する
 * @param cell - セル
 * @param nodes - セル AST
 * @param position - セル位置
 */
function applyRememberedWidthToCell(
	cell: HTMLElement,
	nodes: TableCellNode[],
	position: TableCellPosition,
): void {
	const wrap = cell.querySelector<HTMLElement>('.cm-md-image-wrap');
	const img  = cell.querySelector<HTMLImageElement>('.cm-md-image');
	if (!wrap || !img) {
		return;
	}

	const path  = getImageWrapPath(wrap);
	const width = recallCellImageWidth(path, position);
	if (!width) {
		return;
	}

	updateImageNodeWidths(nodes, width);
	img.classList.add('is-sized');
	img.style.width     = `${width}px`;
	img.style.height    = 'auto';
	img.style.maxWidth  = '100%';
	img.style.maxHeight = 'none';
}

/**
 * 表セル内の画像幅をセルソースへ書き戻す
 * @param view - エディタ
 * @param cell - セル
 * @param width - 幅
 * @returns 更新したか
 */
export function applyTableCellImageWidth(
	view: EditorView,
	cell: HTMLElement,
	width: number,
): boolean {
	const wrap      = cell.closest<HTMLElement>('.cm-md-table-wrap');
	const imageWrap = cell.querySelector<HTMLElement>('.cm-md-image-wrap');
	const row       = Number(cell.dataset.tableRow);
	const column    = Number(cell.dataset.tableColumn);
	const hint      = Number(imageWrap?.dataset.sourceFrom ?? wrap?.dataset.tableFrom);
	if (!Number.isInteger(row) || !Number.isInteger(column) || !Number.isFinite(hint)) {
		return false;
	}

	if (applyImageWidthOnDocumentLine(view, hint, width)) {
		const next = replaceImageWidthInCellText(cell.dataset.source ?? '', width, true);
		if (next) {
			cell.dataset.source       = next;
			cell.dataset.editableText = next;
		}

		return true;
	}

	const tableNode = findTableNodeAt(view.state, hint);
	if (!tableNode) {
		return false;
	}

	const data   = extractTableData(view.state, tableNode);
	const source = getTableCellSource(data, { row, column });
	if (!source) {
		return false;
	}

	const insert = replaceImageWidthInCellText(source.text, width, true);
	if (insert === null || insert === source.text) {
		return false;
	}

	view.dispatch({
		changes  : { from: source.from, to: source.to, insert },
		userEvent: 'input.imageResize',
	});
	cell.dataset.source       = insert;
	cell.dataset.editableText = insert;
	return true;
}

/**
 * 表が持つ EditorView から、セル画像へ `\|幅` を書き戻す
 * findFromDOM に依存しない
 * @param view - エディタ
 * @param data - 表データ
 * @param position - セル位置
 * @param imageWrap - 画像ラッパ
 * @param nodes - セル AST
 * @param width - 幅
 * @returns 更新したか
 */
export function writeTableCellImageWidth(
	view: EditorView,
	data: TableData,
	position: TableCellPosition,
	imageWrap: HTMLElement,
	nodes: TableCellNode[],
	width: number,
): boolean {
	const path = getImageWrapPath(imageWrap) || findTableCellImagePath(nodes);
	const hint = Number(imageWrap.dataset.sourceFrom);
	const end  = Number(imageWrap.dataset.sourceTo);
	const cell = imageWrap.closest<HTMLElement>('[data-table-row]');
	rememberCellImageWidth(path, width, position);

	const wrote = (Boolean(path) && applyImageWidthByPath(
		view,
		path,
		width,
		Number.isFinite(hint) ? hint : undefined,
	))
		|| writeExactTableCellImageWidth(view, data, position, width)
		|| (Number.isFinite(hint) && applyImageWidthOnDocumentLine(view, hint, width))
		|| Boolean(cell && applyTableCellImageWidth(view, cell, width))
		|| (Number.isFinite(hint) && applyImageDisplayWidth(
			view,
			hint,
			width,
			Number.isFinite(end) ? end : undefined,
		));
	if (!wrote) {
		return false;
	}

	const delta = syncTableDataAfterImageWidth(data, position, width);
	updateImageNodeWidths(nodes, width);
	if (delta !== 0 && imageWrap.dataset.sourceTo) {
		const currentTo = Number(imageWrap.dataset.sourceTo);
		if (Number.isFinite(currentTo)) {
			imageWrap.dataset.sourceTo = String(currentTo + delta);
		}
	}

	return true;
}

/**
 * セル AST から画像パスを探す
 * @param nodes - セル AST
 * @returns セル AST から画像パス
 */
function findTableCellImagePath(nodes: TableCellNode[]): string {
	for (const node of nodes) {
		if (node.kind === 'image') {
			return node.spec.raw;
		}

		if ('children' in node) {
			const nested = findTableCellImagePath(node.children);
			if (nested) {
				return nested;
			}
		}
	}

	return '';
}

/**
 * 表データのセル範囲が現文書と一致するとき、その範囲へ幅を書く
 * @param view - エディタ
 * @param data - 表データ
 * @param position - セル位置
 * @param width - 幅
 * @returns 更新したか
 */
function writeExactTableCellImageWidth(
	view: EditorView,
	data: TableData,
	position: TableCellPosition,
	width: number,
): boolean {
	const source = getTableCellSource(data, position);
	if (!source) {
		return false;
	}

	const insert = replaceImageWidthInCellText(source.text, width, true);
	if (insert === null || insert === source.text) {
		return false;
	}

	const liveTo = Math.min(source.to, view.state.doc.length);
	const live   = view.state.sliceDoc(source.from, liveTo);
	if (live !== source.text) {
		return false;
	}

	view.dispatch({
		changes  : { from: source.from, to: source.to, insert },
		userEvent: 'input.imageResize',
	});
	return true;
}

/**
 * セル AST を DOM へ展開する
 * @param parent - 親要素
 * @param nodes - セル AST
 * @param view - エディタ。省略可
 */
export function appendTableCellNodes(parent: HTMLElement, nodes: TableCellNode[], view?: EditorView): void {
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
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'em') {
			const el     = document.createElement('em');
			el.className = 'cm-md-em';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'strong') {
			const el     = document.createElement('strong');
			el.className = 'cm-md-strong';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'strike') {
			const el     = document.createElement('span');
			el.className = 'cm-md-strike';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'highlight') {
			const el     = document.createElement('mark');
			el.className = 'cm-md-highlight';
			appendTableCellNodes(el, node.children, view);
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

			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'wikilink') {
			const el     = document.createElement('span');
			el.className = 'cm-md-wikilink';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		if (node.kind === 'image') {
			parent.appendChild(new ImageWidget(node.spec).toDOM(view));
		}
	}
}

/**
 * セル全体が画像記法だけなら画像ノードにする
 * Lezer の表が `\|` で分割しても、行の `|` 分割結果から幅を拾う
 * @param state - 状態
 * @param range - セル範囲
 * @returns セル全体が画像記法だけなら画像ノードにする。無ければ null
 */
function extractSoleTableCellImage(state: EditorState, range: TableCellRange): TableCellNode | null {
	const raw   = parseCellSpan(state.doc.sliceString(range.from, range.to)).text;
	const match = /^(\s*)(!\[\[[\s\S]*?\]\]|!\[[^\]]*\]\([^)]+\))(\s*)$/.exec(raw);
	if (!match) {
		return null;
	}

	const markupFrom = range.from + (match[1]?.length ?? 0);
	const markup     = match[2] ?? '';
	if (markup.startsWith('![[') && markup.endsWith(']]')) {
		return createTableCellImage(
			state,
			markupFrom,
			markupFrom + markup.length,
			markup.slice(3, -2),
			'',
			true,
		);
	}

	const closeAlt = markup.indexOf('](');
	if (!markup.startsWith('![') || closeAlt < 0 || !markup.endsWith(')')) {
		return null;
	}

	return createTableCellImage(
		state,
		markupFrom,
		markupFrom + markup.length,
		markup.slice(closeAlt + 2, -1),
		markup.slice(2, closeAlt),
		false,
	);
}

/**
 * 表セル内の画像ノードを組み立てる
 * @param state - 状態
 * @param from - ソース開始
 * @param to - ソース終了
 * @param raw - パスまたは URL
 * @param alt - alt
 * @param embed - WikiEmbed か
 * @returns 表セル内の画像ノード
 */
function createTableCellImage(
	state: EditorState,
	from: number,
	to: number,
	raw: string,
	alt: string,
	embed: boolean,
): TableCellNode {
	const context = state.facet(documentContextFacet);
	if (embed) {
		const { path, size }  = splitWikiEmbedTarget(raw);
		const spec: ImageSpec = {
			alt             : path,
			raw             : path,
			kind            : 'embed',
			documentPath    : context.filePath,
			loadRemoteImages: context.loadRemoteImages,
			width           : resolveCellImageWidth(path, size.width),
			height          : size.height,
			sourceFrom      : from,
			sourceTo        : to,
		};
		return { kind: 'image', spec };
	}

	const { alt: altText, size } = splitImageAlt(alt);
	const spec: ImageSpec        = {
		alt             : altText,
		raw,
		kind            : classifyImageSource(raw),
		documentPath    : context.filePath,
		loadRemoteImages: context.loadRemoteImages,
		width           : resolveCellImageWidth(raw, size.width),
		height          : size.height,
		sourceFrom      : from,
		sourceTo        : to,
	};
	return { kind: 'image', spec };
}

/**
 * セル内容を DOM に設定する
 * @param cell - セル要素
 * @param nodes - セル AST
 * @param view - エディタ。省略可
 */
export function fillTableCellContent(cell: HTMLElement, nodes: TableCellNode[], view?: EditorView): void {
	cell.textContent = '';
	appendTableCellNodes(cell, nodes, view);
}

/**
 * 表の最大列数を返す
 * @param data - 表データ
 * @returns 表の最大列数
 */
export function getTableColumnCount(data: TableData): number {
	return Math.max(
		data.headerSources.length,
		...data.rowSources.map((row) => row.length),
		0,
	);
}

/**
 * 表示上の行番号（ヘッダ=0）からセルソースを返す
 * @param data - 表データ
 * @param position - セル位置
 * @returns 表示上の行番号（ヘッダ=0）からセルソース
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
 * 表セルに対応する Markdown ソース位置へ CodeMirror の選択を同期する
 * セルは独立した contenteditable のため、クリックだけでは CodeMirror の選択が変わらない
 * @param view - エディタビュー
 * @param data - 表データ
 * @param position - セル位置
 * @returns 対応するセル位置を取得できたか
 */
export function syncTableCellEditorSelection(
	view: EditorView,
	data: TableData,
	position: TableCellPosition,
): boolean {
	const source = getTableCellSource(data, position);
	if (!source) {
		return false;
	}

	const target = Math.min(source.from, view.state.doc.length);
	if (view.state.selection.main.anchor === target && view.state.selection.main.head === target) {
		return true;
	}

	view.dispatch({
		selection: EditorSelection.cursor(target),
		userEvent: 'select.pointer',
	});
	return true;
}

/**
 * 縦移動でテーブル外から入る場合のフォーカス先を返す
 * 上側からはヘッダー行、下側からは末尾行の第1列へ入る
 * @param state - エディタ状態
 * @param from - 移動前の文書位置
 * @param to - 通常の縦移動で求めた文書位置
 * @param forward - 下方向への移動なら true
 * @returns セルフォーカス先
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
 * 指定位置のテーブルウィジェットが現在のビューへ描画されているか返す
 * @param view - エディタビュー
 * @param tableFrom - 表開始位置
 * @returns 描画済みなら true
 */
export function hasRenderedTableWidget(view: EditorView, tableFrom: number): boolean {
	return view.dom.querySelector(
		`.cm-md-table-wrap[data-table-from="${tableFrom}"]`,
	) !== null;
}

/** 末尾改行を表示するためのゼロ幅文字。ソースには書かない */
export const TABLE_CELL_BREAK_CARET = '\u200B';

/**
 * 編集用 DOM から読んだ文字列を、ソースへ書く前の改行表現へ整える
 * @param value - 入力値
 * @returns 編集用 DOM から読んだ文字列を、ソースへ書く前の改行表現へ整える
 */
export function normalizeEditableCellDomText(value: string): string {
	return value
		.replaceAll(TABLE_CELL_BREAK_CARET, '')
		.replaceAll('\u00a0', ' ')
		.replace(/\r\n?/g, '\n');
}

/**
 * セル内の行ブロックか
 * @param node - ノード
 * @returns セル内の行ブロックかなら true
 */
function isTableCellLineBlock(node: Node): node is HTMLElement {
	return node instanceof HTMLElement
		&& (node.tagName === 'DIV' || node.tagName === 'P');
}

/**
 * 表示に効かない空白テキストか
 * @param node - ノード
 * @returns 表示に効かない空白テキストかなら true
 */
function isIgnorableTableCellNode(node: Node): boolean {
	if (node.nodeType !== Node.TEXT_NODE) {
		return false;
	}

	return (node.textContent ?? '').replaceAll(TABLE_CELL_BREAK_CARET, '') === '';
}

/**
 * 空行用の `<div><br></div>` か。内側の br は行そのものなので、改行として二重に数えない
 * @param node - ノード
 * @returns 空行用の `<div><br></div>` か。内側の br は行そのものなので、改行として二重に数えないなら true
 */
export function isTableCellEmptyLineBlock(node: Node): boolean {
	if (!isTableCellLineBlock(node)) {
		return false;
	}

	const meaningful = [...node.childNodes].filter((child) => !isIgnorableTableCellNode(child));
	if (meaningful.length === 0) {
		return true;
	}

	return meaningful.length === 1
		&& meaningful[0] instanceof HTMLElement
		&& meaningful[0].tagName === 'BR';
}

// ==============================================
// セル編集
// ==============================================
/** セル DOM の中のキャレット位置 */
type TableCellCaretPoint = {
	/** キャレットを置くノード */
	node: Node;
	/** そのノード内の位置。文字数 */
	offset: number;
};

/** 編集文字列の1区間に対応する DOM。text は文字、break は改行 */
type TableCellEditableSlot =
	| { kind: 'text'; node: Text }
	| { kind: 'break'; caret: TableCellCaretPoint };

/**
 * 行末のプレースホルダ br か。Chrome が行ボックスを残すために付ける
 * @param block - 行
 * @param child - 子
 * @returns 行末のプレースホルダ br か。Chrome が行ボックスを残すために付けるなら true
 */
function isTrailingLinePlaceholderBr(block: HTMLElement, child: Node): boolean {
	if (!(child instanceof HTMLElement) || child.tagName !== 'BR') {
		return false;
	}

	const children = [...block.childNodes];
	const index    = children.indexOf(child);
	if (index < 0) {
		return false;
	}

	return children.slice(index + 1).every((node) => isIgnorableTableCellNode(node));
}

/**
 * ノード先頭のキャレット位置を返す
 * @param node - ノード
 * @returns ノード先頭のキャレット位置
 */
function caretAtNodeStart(node: Node): TableCellCaretPoint {
	return { node, offset: 0 };
}

/**
 * ノード直前のキャレット位置を返す
 * @param node - ノード
 * @returns ノード直前のキャレット位置
 */
function caretBeforeNode(node: Node): TableCellCaretPoint {
	const parent = node.parentNode;
	if (!parent) {
		return { node, offset: 0 };
	}

	return { node: parent, offset: [...parent.childNodes].indexOf(node as ChildNode) };
}

/**
 * セル DOM を、編集用文字列と同じ改行スロットへ分解する
 * 行ブロックの境界と単独 `<br>` を1改行として並べ、連続空行も落とさない
 * @param cell - セル
 * @returns セル DOM を、編集用文字列と同じ改行スロットへ分解する
 */
function collectTableCellEditableSlots(cell: HTMLElement): TableCellEditableSlot[] {
	const slots: TableCellEditableSlot[] = [];
	/**
	 * @param node - テキスト
	 */
	const pushText                       = (node: Text): void => {
		if (visibleTableCellTextLength(node.textContent ?? '') === 0) {
			return;
		}

		slots.push({ kind: 'text', node });
	};
	/**
	 * @param node - 対象
	 * @param lineBlock - 所属する行
	 */
	const walkInline                     = (node: Node, lineBlock: HTMLElement | null): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			pushText(node as Text);
			return;
		}

		if (node instanceof HTMLElement && node.tagName === 'BR') {
			if (lineBlock && isTrailingLinePlaceholderBr(lineBlock, node)) {
				return;
			}

			slots.push({ kind: 'break', caret: caretBeforeNode(node) });
			return;
		}

		if (!(node instanceof HTMLElement)) {
			return;
		}

		for (const child of node.childNodes) {
			walkInline(child, lineBlock);
		}
	};

	let hasLine = false;
	for (const child of cell.childNodes) {
		if (isTableCellLineBlock(child)) {
			if (hasLine || slots.length > 0) {
				slots.push({ kind: 'break', caret: caretAtNodeStart(child) });
			}

			hasLine = true;
			if (!isTableCellEmptyLineBlock(child)) {
				walkInline(child, child);
			}

			continue;
		}

		hasLine = true;
		if (child instanceof HTMLElement && child.tagName === 'BR') {
			slots.push({ kind: 'break', caret: caretBeforeNode(child) });
			continue;
		}

		if (child.nodeType === Node.TEXT_NODE) {
			pushText(child as Text);
			continue;
		}

		walkInline(child, null);
	}

	return slots;
}

/**
 * スロットを編集用文字列へ戻す
 * @param slots - スロット
 * @returns スロットを編集用文字列へ戻す
 */
function slotsToEditableValue(slots: TableCellEditableSlot[]): string {
	let result = '';
	for (const slot of slots) {
		result += slot.kind === 'text' ? slot.node.textContent ?? '' : '\n';
	}

	return normalizeEditableCellDomText(result);
}

/**
 * セル DOM の表示テキストを編集用文字列として返す
 * `<br>` と行ブロックの境界は改行、ゼロ幅文字は捨てる
 * @param cell - セル
 * @returns セル DOM の表示テキストを編集用文字列として返す
 */
export function readTableCellEditableValue(cell: HTMLElement): string {
	return slotsToEditableValue(collectTableCellEditableSlots(cell));
}

/**
 * 指定位置へソフト改行を入れる
 * @param value - 編集用文字列
 * @param offset - キャレット位置
 * @returns 指定位置へソフト改行を入れる
 */
export function insertLineBreakAtOffset(value: string, offset: number): string {
	const bounded = Math.max(0, Math.min(offset, value.length));
	return `${value.slice(0, bounded)}\n${value.slice(bounded)}`;
}

/**
 * 表示上の文字数を返す。ゼロ幅のキャレット用文字は数えない
 * @param text - テキスト
 * @param rawEnd - 生オフセット。省略可
 * @returns 表示上の文字数を返す。ゼロ幅のキャレット用文字は数えない
 */
export function visibleTableCellTextLength(text: string, rawEnd: number = text.length): number {
	let visible = 0;
	const end   = Math.max(0, Math.min(rawEnd, text.length));
	for (let index = 0; index < end; index += 1) {
		if (text[index] !== TABLE_CELL_BREAK_CARET) {
			visible += 1;
		}
	}

	return visible;
}

/**
 * 表示オフセットを、ゼロ幅文字を含む生オフセットへ戻す
 * @param text - テキスト
 * @param visibleOffset - 表示オフセット
 * @returns 表示オフセットを、ゼロ幅文字を含む生オフセットへ戻す
 */
export function rawTableCellTextOffset(text: string, visibleOffset: number): number {
	let visible = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (visible >= visibleOffset) {
			return index;
		}

		if (text[index] !== TABLE_CELL_BREAK_CARET) {
			visible += 1;
		}
	}

	return text.length;
}

/**
 * セル書き戻しでずれたセル位置を、既存ウィジェット側へ反映する
 * @param data - 表データ
 * @param position - 書き換えたセル
 * @param insert - 正規化後のソース
 * @param editableText - 編集用文字列。省略可
 * @returns 増えた文字数
 */
export function syncTableDataAfterCellChange(
	data: TableData,
	position: TableCellPosition,
	insert: string,
	editableText?: string,
): number {
	const source = getTableCellSource(data, position);
	if (!source || source.text === insert) {
		return 0;
	}

	const delta         = insert.length - source.text.length;
	const oldTo         = source.to;
	source.text         = insert;
	source.editableText = editableText ?? parseCellSpan(insert).text.replace(/<br\s*\/?>/gi, '\n');
	source.to           = source.from + insert.length;
	data.tableTo       += delta;

	/**
	 * @param other - 他セル
	 */
	const shiftSource = (other: TableCellSource): void => {
		if (other === source || other.from < oldTo) {
			return;
		}

		other.from += delta;
		other.to   += delta;
	};

	data.headerSources.forEach(shiftSource);
	data.rowSources.forEach((row) => row.forEach(shiftSource));
	return delta;
}

/**
 * contenteditable から取得した文字列を Markdown 表セル用に正規化する
 * 改行は br、未エスケープのパイプはエスケープへ変換する
 * @param value - 入力値
 * @returns contenteditable から取得した文字列を Markdown 表セル用に正規化する
 */
export function normalizeTableCellSource(value: string): string {
	const singleLine = normalizeEditableCellDomText(value)
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
 * 正規化後の Markdown ソース上でのキャレット位置を返す
 * @param value - 正規化前の入力値
 * @param offset - 正規化前のキャレット位置
 * @returns 正規化後の Markdown ソース上でのキャレット位置
 */
export function getNormalizedTableCellCaretOffset(value: string, offset: number): number {
	const boundedOffset = Math.max(0, Math.min(offset, value.length));
	return normalizeTableCellSource(value.slice(0, boundedOffset)).length;
}

/**
 * Markdown正規化後に再描画される編集用文字列上のキャレット位置を返す
 * 改行は編集画面でも1文字のまま、未エスケープのパイプに追加されるバックスラッシュだけを加味する
 * @param value - 正規化前の入力値
 * @param offset - 正規化前のキャレット位置
 * @returns Markdown正規化後に再描画される編集用文字列上のキャレット位置
 */
export function getTableCellEditableCaretOffset(value: string, offset: number): number {
	const boundedOffset = Math.max(0, Math.min(offset, value.length));
	const prefix        = normalizeEditableCellDomText(value.slice(0, boundedOffset));
	let result          = prefix.length;

	for (let index = 0; index < prefix.length; index += 1) {
		if (prefix[index] === '|' && !isEscapedPipe(prefix, index)) {
			result += 1;
		}
	}

	return result;
}

/**
 * 表セル内の全選択ショートカットか判定する
 * CodeMirror 本体へ伝播すると表全体のソース位置が選択されるため、セル側で処理する
 * @param event - キーイベント
 * @returns 表セル内の全選択ショートカットなら true
 */
export function isTableCellSelectAllKey(
	event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key'>,
): boolean {
	return (event.ctrlKey || event.metaKey)
		&& !event.altKey
		&& event.key.toLowerCase() === 'a';
}

/**
 * 表セル内へソフト改行を入力するShift+Enterか判定する
 * @param event - キーイベント
 * @returns 表セル内へソフト改行を入力するShift+Enterなら true
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
 * 修飾キーなしの上下キーを表セルの縦移動方向へ変換する
 * 左右キーはブラウザー標準のセル移動へ任せる
 * @param event - キーイベント
 * @returns 変換後の修飾キーなしの上下キーを表セルの縦移動方向
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
 * 表セルの上下キー移動を解決する
 * 上下端でも操作済みとして返し、ブラウザー標準処理による左右セルへの流出を防ぐ
 * @param data - 表データ
 * @param position - 現在位置
 * @param event - キーイベント
 * @returns 表セルの上下キー移動。解決できなければ null
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

/** 編集文字列上のキャレットを、行と行内位置へ分けたもの */
export type TableCellLineCaretPosition = {
	/** 行番号。0 始まり */
	line: number;
	/** その行の中の位置。0 始まり */
	column: number;
	/** 編集文字列の行数 */
	lineCount: number;
};

/**
 * 編集用文字列上のキャレットを、行番号と行内位置へ分解する
 * @param value - 編集用文字列
 * @param offset - キャレット位置
 * @returns 編集用文字列上のキャレットを、行番号と行内位置へ分解する
 */
export function getTableCellLineCaretPosition(value: string, offset: number): TableCellLineCaretPosition {
	const text    = normalizeEditableCellDomText(value);
	const bounded = Math.max(0, Math.min(offset, text.length));
	let line      = 0;
	let column    = 0;
	for (let index = 0; index < bounded; index += 1) {
		if (text[index] === '\n') {
			line  += 1;
			column = 0;
			continue;
		}

		column += 1;
	}

	return {
		line,
		column,
		lineCount: text.split('\n').length,
	};
}

/**
 * セル内の上下キーで移るキャレット位置を返す
 * 先頭行の上・末尾行の下はセル外へ出すため null
 * @param value - 編集用文字列
 * @param offset - 現在位置
 * @param direction - 方向
 * @returns セル内の上下キーで移るキャレット位置
 */
export function getTableCellVerticalCaretOffset(
	value: string,
	offset: number,
	direction: 'up' | 'down',
): number | null {
	const text     = normalizeEditableCellDomText(value);
	const caret    = getTableCellLineCaretPosition(text, offset);
	const nextLine = caret.line + (direction === 'down' ? 1 : -1);
	if (nextLine < 0 || nextLine >= caret.lineCount) {
		return null;
	}

	const lines        = text.split('\n');
	const targetColumn = Math.min(caret.column, lines[nextLine]!.length);
	let nextOffset     = 0;
	for (let line = 0; line < nextLine; line += 1) {
		nextOffset += lines[line]!.length + 1;
	}

	return nextOffset + targetColumn;
}

/**
 * セル内改行があるとき、上下キーで同じ桁の行へキャレットを移す
 * @param cell - 編集中セル
 * @param direction - 方向
 * @returns セル内で移れたか
 */
export function moveTableCellCaretVertically(
	cell: HTMLElement,
	direction: 'up' | 'down',
): boolean {
	const next = getTableCellVerticalCaretOffset(
		readTableCellEditableValue(cell),
		getCellCaretOffset(cell),
		direction,
	);
	if (next === null) {
		return false;
	}

	setCellSelection(cell, next, false);
	return true;
}

/**
 * セル編集を文書へ反映する変更を構築する
 * @param data - 表データ
 * @param position - セル位置
 * @param value - 新しいセルソース
 * @returns セル編集を文書へ反映する変更
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

	const existing   = parseCellSpan(source.text);
	const normalized = normalizeTableCellSource(value);
	const typed      = parseCellSpan(normalized);
	const span       = typed.suffix.trim().length > 0 ? typed : existing;

	return {
		from  : source.from,
		to    : source.to,
		insert: formatCellSpan(
			typed.text,
			span.colspan,
			span.rowspan,
			span.align,
			span.valign,
			span.colwidths,
			span.rowheights,
		),
	};
}

/**
 * Tab / Shift+Tab / Enter / 上下キーの移動先を返す
 * @param data - 表データ
 * @param position - 現在位置
 * @param direction - 移動方向
 * @returns Tab / Shift+Tab / Enter / 上下キーの移動先
 */
export function getAdjacentTableCellPosition(
	data: TableData,
	position: TableCellPosition,
	direction: 'next' | 'previous' | 'up' | 'down',
): TableCellPosition | null {
	if (getTableColumnCount(data) === 0 || position.row < 0 || position.column < 0) {
		return null;
	}

	return getVisibleAdjacentTableCellPosition(data, position, direction);
}

/**
 * 最終セルでの Tab 用に空行追加変更を構築する
 * @param state - エディタ状態
 * @param data - 表データ
 * @returns 最終セルでの Tab 用に空行追加変更
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
 * contenteditable 内のキャレットオフセットを返す
 * @param cell - セル
 * @returns contenteditable 内のキャレットオフセット
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
 * キャレットを含むインライン要素のIDを返す
 * 入れ子の場合は、それぞれの要素が所有する記法を表示するため全件を返す
 * @param inlineRanges - インライン範囲
 * @param caretOffset - 編集文字列上のキャレット位置
 * @returns キャレットを含むインライン要素のID
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
 * プレビュー表示上のキャレット位置を、記法を含む編集文字列上の位置へ変換する
 * @param text - 編集用Markdown文字列
 * @param inlineRanges - インライン範囲
 * @param previewOffset - 記法を除いたプレビュー文字列上の位置
 * @returns 変換後のプレビュー表示上のキャレット位置を、記法を含む編集文字列上の位置
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
 * セルを、ソースを保持したインラインライブプレビューDOMで埋める
 * 改行は1行1ブロックにし、連続した空行も見えるようにする
 * @param cell - 編集対象セル
 * @param text - 編集用Markdown文字列
 * @param inlineRanges - インライン範囲
 */
export function fillEditableTableCellContent(
	cell: HTMLElement,
	text: string,
	inlineRanges: TableCellInlineRange[],
): void {
	cell.textContent = '';
	const lines      = text.split('\n');
	let lineStart    = 0;
	for (const line of lines) {
		const row = cell.ownerDocument.createElement('div');
		if (line.length === 0) {
			row.appendChild(cell.ownerDocument.createElement('br'));
		} else {
			appendEditableTableCellSegments(
				row,
				text,
				inlineRanges,
				lineStart,
				lineStart + line.length,
			);
		}

		cell.appendChild(row);
		lineStart += line.length + 1;
	}
}

/**
 * 編集行の指定範囲へ、インライン記法付きの断片を載せる
 * @param lineParent - 行
 * @param text - 編集用文字列全体
 * @param inlineRanges - インライン範囲
 * @param rangeFrom - 行開始
 * @param rangeTo - 行終了
 */
function appendEditableTableCellSegments(
	lineParent: HTMLElement,
	text: string,
	inlineRanges: TableCellInlineRange[],
	rangeFrom: number,
	rangeTo: number,
): void {
	/** 装飾範囲を対象セル内へ収め、分割境界がセル外へ漏れないようにする */
	const clip       = (position: number): number => Math.max(rangeFrom, Math.min(rangeTo, position));
	const boundaries = new Set<number>([rangeFrom, rangeTo]);
	for (const inlineRange of inlineRanges) {
		boundaries.add(clip(inlineRange.from));
		boundaries.add(clip(inlineRange.to));
		for (const markRange of inlineRange.markRanges) {
			boundaries.add(clip(markRange.from));
			boundaries.add(clip(markRange.to));
		}
	}

	const sortedBoundaries              = [...boundaries].sort((a, b) => a - b);
	let codeWrapper: HTMLElement | null = null;
	let codeWrapperId: number | null    = null;

	/**
	 * インラインコード全体を1つの背景で囲む親要素を返す
	 * @param from - セグメント開始
	 * @param to - セグメント終了
	 * @returns インラインコード全体を1つの背景で囲む親要素
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
			return lineParent;
		}

		if (codeWrapper === null || codeWrapperId !== codeOwner.id) {
			codeWrapper           = lineParent.ownerDocument.createElement('span');
			codeWrapper.className = 'cm-md-code';
			codeWrapperId         = codeOwner.id;
			lineParent.appendChild(codeWrapper);
		}

		return codeWrapper;
	};

	for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
		const from = sortedBoundaries[index]!;
		const to   = sortedBoundaries[index + 1]!;
		if (from >= to) {
			continue;
		}

		const segment      = text.slice(from, to).replaceAll('\n', '');
		const parent       = getSegmentParent(from, to);
		const markerOwners = inlineRanges.filter((inlineRange) => inlineRange.markRanges.some(
			(markRange) => markRange.from <= from && to <= markRange.to,
		));
		if (markerOwners.length > 0) {
			if (segment) {
				const marker                = lineParent.ownerDocument.createElement('span');
				marker.className            = 'cm-md-table-source-mark';
				marker.dataset.inlineOwners = markerOwners.map((owner) => owner.id).join(',');
				marker.textContent          = segment;
				parent.appendChild(marker);
			}

			continue;
		}

		const classNames = new Set(inlineRanges
			.filter((inlineRange) => inlineRange.from <= from && to <= inlineRange.to)
			.map((inlineRange) => TABLE_CELL_INLINE_CLASSES[inlineRange.kind]));
		if (parent !== lineParent) {
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

		if (!segment) {
			continue;
		}

		if (classNames.size === 0 && !language) {
			parent.appendChild(lineParent.ownerDocument.createTextNode(segment));
			continue;
		}

		const content     = lineParent.ownerDocument.createElement('span');
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
 * 文書上の点がキャレット末尾より前か後かを返す
 * @param node - 点のノード
 * @param offset - 点のオフセット
 * @param range - 選択
 * @returns 負なら前、0なら一致、正なら後
 */
function comparePointToRangeEnd(node: Node, offset: number, range: Range): number {
	const documentRef = node.ownerDocument;
	if (!documentRef) {
		return 0;
	}

	const point     = documentRef.createRange();
	const maxOffset = node.nodeType === Node.TEXT_NODE
		? (node.textContent ?? '').length
		: node.childNodes.length;
	try {
		point.setStart(node, Math.max(0, Math.min(offset, maxOffset)));
		point.collapse(true);
		return point.compareBoundaryPoints(Range.START_TO_END, range);
	} catch {
		return 0;
	}
}

/**
 * セル内の論理テキスト位置としてキャレット位置を返す
 * 非表示のMarkdown記法テキストも文字数へ含める
 * @param cell - 編集対象セル
 * @returns セル内の論理テキスト位置としてキャレット位置
 */
function getCellCaretOffset(cell: HTMLElement, countBreaks: boolean = true): number {
	const slots     = collectTableCellEditableSlots(cell);
	const value     = slotsToEditableValue(slots);
	const selection = cell.ownerDocument.defaultView?.getSelection();
	if (!selection || selection.rangeCount === 0) {
		return value.length;
	}

	const range = selection.getRangeAt(0);
	if (!cell.contains(range.endContainer)) {
		return value.length;
	}

	let offset = 0;
	for (const slot of slots) {
		if (slot.kind === 'text') {
			if (range.endContainer === slot.node) {
				offset += visibleTableCellTextLength(slot.node.textContent ?? '', range.endOffset);
				break;
			}

			if (comparePointToRangeEnd(slot.node, 0, range) > 0) {
				break;
			}

			const textLength = (slot.node.textContent ?? '').length;
			if (comparePointToRangeEnd(slot.node, textLength, range) <= 0) {
				offset += visibleTableCellTextLength(slot.node.textContent ?? '');
				if (comparePointToRangeEnd(slot.node, textLength, range) === 0) {
					break;
				}

				continue;
			}

			break;
		}

		if (!countBreaks) {
			continue;
		}

		const cmp = comparePointToRangeEnd(slot.caret.node, slot.caret.offset, range);
		if (cmp > 0) {
			break;
		}

		offset += 1;
		if (cmp === 0) {
			break;
		}
	}

	return offset;
}

/**
 * キャレット位置に応じて、該当インライン要素のMarkdown記法だけを表示する
 * @param cell - 編集対象セル
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
 * 現在のセル選択範囲へ実改行を挿入する
 * 選択が無くても末尾へ入れ、連続空行も行ブロックとして残す
 * @param cell - 編集中セル
 * @returns 挿入できたか
 */
export function insertTableCellLineBreak(cell: HTMLElement): boolean {
	let inlineRanges: TableCellInlineRange[] = [];
	try {
		inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
	} catch {
		inlineRanges = [];
	}

	const value  = readTableCellEditableValue(cell);
	const offset = getCellCaretOffset(cell);
	const next   = insertLineBreakAtOffset(value, offset);
	fillEditableTableCellContent(cell, next, inlineRanges);
	cell.dataset.editableText = next;
	setCellSelection(cell, offset + 1, false);
	return true;
}

/**
 * 行ブロック先頭へキャレットを置く
 * @param range - 選択
 * @param cell - セル
 * @param atStart - 先頭行なら true
 * @returns 置けたか
 */
function placeCaretOnTableCellLine(range: Range, cell: HTMLElement, atStart: boolean): boolean {
	const lines = [...cell.childNodes].filter((node): node is HTMLElement => isTableCellLineBlock(node));
	const line  = atStart ? lines[0] : lines[lines.length - 1];
	if (!line) {
		return false;
	}

	range.setStart(line, 0);
	range.collapse(true);
	return true;
}

/**
 * セル内へキャレットまたは全選択を設定する
 * @param cell - セル
 * @param offset - キャレット位置
 * @param selectAll - 全選択するか
 */
function setCellSelection(cell: HTMLElement, offset: number, selectAll: boolean): void {
	const selection = cell.ownerDocument.defaultView?.getSelection();
	if (!selection) {
		return;
	}

	const range = cell.ownerDocument.createRange();
	range.selectNodeContents(cell);
	if (!selectAll) {
		const slots   = collectTableCellEditableSlots(cell);
		let remaining = Math.max(0, offset);
		let placed    = false;
		for (const slot of slots) {
			if (slot.kind === 'text') {
				const length = visibleTableCellTextLength(slot.node.textContent ?? '');
				if (remaining <= length) {
					range.setStart(slot.node, rawTableCellTextOffset(slot.node.textContent ?? '', remaining));
					range.collapse(true);
					placed = true;
					break;
				}

				remaining -= length;
				continue;
			}

			if (remaining <= 0) {
				range.setStart(slot.caret.node, slot.caret.offset);
				range.collapse(true);
				placed = true;
				break;
			}

			remaining -= 1;
			if (remaining === 0) {
				range.setStart(slot.caret.node, slot.caret.offset);
				range.collapse(true);
				placed = true;
				break;
			}
		}

		if (!placed && !placeCaretOnTableCellLine(range, cell, offset === 0)) {
			range.collapse(false);
		}
	}

	selection.removeAllRanges();
	selection.addRange(range);
	updateTableCellInlineMarks(cell);
}

/**
 * 編集中セルをプレビューへ戻す。値は先に文書へ書く
 * @param view - エディタ
 * @param cell - セル
 * @param tableFrom - 表開始位置
 */
function persistAndDeactivateTableCell(
	view: EditorView,
	cell: HTMLElement,
	tableFrom: number,
): void {
	const wasEditing = cell.dataset.editing === 'true'
		|| cell.classList.contains('cm-md-table-cell-editing');
	if (!wasEditing) {
		return;
	}

	const position = {
		row   : Number(cell.dataset.tableRow),
		column: Number(cell.dataset.tableColumn),
	};
	if (
		cell.dataset.editing === 'true'
		&& Number.isInteger(position.row)
		&& Number.isInteger(position.column)
		&& !view.state.readOnly
	) {
		const tableNode = findTableNodeAt(view.state, tableFrom);
		if (tableNode) {
			const data   = extractTableData(view.state, tableNode);
			const change = buildTableCellChange(data, position, readTableCellEditableValue(cell));
			const source = getTableCellSource(data, position);
			if (change && source && change.insert !== source.text) {
				view.dispatch({ changes: change, userEvent: 'input.type' });
			}
		}
	}

	cell.dataset.editing = 'false';
	cell.classList.remove('cm-md-table-cell-editing');
	if (!Number.isInteger(position.row) || !Number.isInteger(position.column)) {
		notifyTableGeometryChange(cell);
		return;
	}

	const nodes = getCurrentTableCellNodes(view.state, tableFrom, position);
	if (!nodes) {
		notifyTableGeometryChange(cell);
		return;
	}

	fillTableCellContent(cell, nodes, view);
	applyRememberedWidthToCell(cell, nodes, position);
	notifyTableGeometryChange(cell);
}

/**
 * 指定セル以外の編集中セルをプレビューへ戻す
 * @param view - エディタ
 * @param wrap - 表ラッパー
 * @param tableFrom - 表開始位置
 * @param except - 残すセル
 */
function deactivateOtherEditingTableCells(
	view: EditorView,
	wrap: HTMLElement,
	tableFrom: number,
	except: HTMLElement | null,
): void {
	for (const other of wrap.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')) {
		if (other !== except) {
			persistAndDeactivateTableCell(view, other, tableFrom);
		}
	}
}

/**
 * セルをソース編集状態へ切り替える
 * @param cell - セル
 * @param view - 他セルを閉じるとき使う。省略可
 */
function activateTableCell(cell: HTMLElement, view?: EditorView): void {
	const wrap      = cell.closest<HTMLElement>('.cm-md-table-wrap');
	const tableFrom = Number(wrap?.dataset.tableFrom);
	if (view && wrap && Number.isInteger(tableFrom)) {
		deactivateOtherEditingTableCells(view, wrap, tableFrom, cell);
	}

	if (cell.dataset.editing === 'true') {
		return;
	}

	if (cellShowsOnlyImage(cell) && cell.dataset.forceImageEdit !== 'true') {
		return;
	}

	cell.dataset.forceImageEdit = 'false';
	cell.dataset.editing        = 'true';
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
	notifyTableGeometryChange(cell);
}

/**
 * 指定セルへフォーカスを戻す
 * @param view - エディタビュー
 * @param tableFrom - 表開始位置
 * @param position - セル位置
 * @param offset - キャレット位置
 * @param selectAll - 全選択するか
 */
export function restoreTableCellFocus(
	view: EditorView,
	tableFrom: number,
	position: TableCellPosition,
	offset: number,
	selectAll: boolean,
): void {
	clearRenderedTableSelection(view, tableFrom);
	const wrap   = view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`);
	const target = wrap?.querySelector<HTMLElement>(
		`[data-table-row="${position.row}"][data-table-column="${position.column}"]`,
	) ?? null;
	if (wrap) {
		deactivateOtherEditingTableCells(view, wrap, tableFrom, target);
	}

	const schedule = typeof window === 'undefined' ? setTimeout : window.setTimeout.bind(window);
	schedule(() => {
		const selector = [
			`.cm-md-table-wrap[data-table-from="${tableFrom}"]`,
			`[data-table-row="${position.row}"][data-table-column="${position.column}"]`,
		].join(' ');
		const cell     = view.dom.querySelector<HTMLElement>(selector);
		if (!cell) {
			view.focus();
			return;
		}

		activateTableCell(cell, view);
		cell.focus({ preventScroll: true });
		setCellSelection(cell, offset, selectAll);
		// 結合などで Widget を作り直した直後は、focusin で選択ヘッダー用の余白が付く
		// 編集DOMの復元前ではなく、フォーカスとキャレットを戻し終えた確定配置でも再計測する
		notifyTableGeometryChange(cell);
	}, 0);
}

/**
 * 表の上下端から、表外の隣接行へ移動する文書位置を返す
 * @param state - エディタ状態
 * @param tableFrom - 表開始位置
 * @param tableTo - 表終了位置
 * @param forward - 下方向なら true
 * @returns 移動先行の先頭位置。文書端なら null
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
 * 表セルから表外の隣接行へCodeMirrorのキャレットを移す
 * @param view - エディタビュー
 * @param tableFrom - 表開始位置
 * @param tableTo - 表終了位置
 * @param forward - 下方向なら true
 * @returns 移動できたか
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

	clearRenderedTableSelection(view, tableFrom);
	const wrap = view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`);
	if (wrap) {
		deactivateOtherEditingTableCells(view, wrap, tableFrom, null);
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
 * CodeMirror側へ渡った上下キーを、編集中の描画済み表セルで処理する
 * 空セルでkeydownの送信先がセル外になる場合を補完し、上下端では表外へ移動する
 * @param view - エディタビュー
 * @param forward - 下方向なら true
 * @returns 表セルの上下移動として処理したか
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

	if (moveTableCellCaretVertically(cell, forward ? 'down' : 'up')) {
		return true;
	}

	const tableNode = findTableNodeAt(view.state, tableFrom);
	const data      = tableNode ? extractTableData(view.state, tableNode) : null;
	const target    = data
		? getAdjacentTableCellPosition(data, { row, column }, forward ? 'down' : 'up')
		: null;
	if (target) {
		restoreTableCellFocus(
			view,
			tableFrom,
			target,
			getCellCaretOffset(cell, true),
			false,
		);
	} else if (!moveTableCellFocusOutside(view, tableFrom, tableTo, forward)) {
		restoreTableCellFocus(view, tableFrom, { row, column }, getCellCaretOffset(cell, true), false);
	}
	return true;
}

/**
 * 配置クラスをセルへ付け直す。既定の左詰め・上詰めはクラスを外す
 * @param cell - セル
 * @param sourceText - セルソース
 */
function applyCellAlignmentClasses(cell: HTMLElement, sourceText: string): void {
	for (const name of [...cell.classList]) {
		if (name.startsWith('cm-md-table-align-') || name.startsWith('cm-md-table-valign-')) {
			cell.classList.remove(name);
		}
	}

	const span      = parseCellSpan(sourceText);
	const className = cellAlignmentClassNames(span);
	if (className.length > 0) {
		cell.classList.add(...className.split(/\s+/));
	}

	if (cell.style) {
		cell.style.textAlign     = span.align === 'left' ? '' : span.align;
		cell.style.verticalAlign = span.valign === 'top' ? '' : span.valign;
	}
}

/**
 * 結合属性をセル DOM へ付ける
 * @param cell - セル
 * @param occupancy - 占有
 * @param position - 位置
 */
function applyCellSpan(
	cell: HTMLTableCellElement,
	occupancy: ReturnType<typeof buildTableOccupancy>,
	position: TableCellPosition,
	sourceText = '',
): void {
	const item = occupancy.cells[position.row]?.[position.column];
	if (!item || item.covered) {
		return;
	}

	if (item.colspan > 1) {
		cell.colSpan = item.colspan;
	}

	if (item.rowspan > 1) {
		cell.rowSpan = item.rowspan;
	}

	applyCellAlignmentClasses(cell, sourceText);
}

/**
 * 表の選択範囲を dataset から読む
 * @param wrap - 表ラッパー
 * @returns 表の選択範囲を dataset から読む。無ければ null
 */
function readTableSelectionRect(wrap: HTMLElement): TableSelectionRect | null {
	const raw = wrap.dataset.tableSelection;
	if (!raw) {
		return null;
	}

	const parts = raw.split(',').map((item) => Number(item));
	if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item))) {
		return null;
	}

	return {
		startRow   : parts[0]!,
		startColumn: parts[1]!,
		endRow     : parts[2]!,
		endColumn  : parts[3]!,
	};
}

/** 上部テーブルメニューへ状態変化を知らせるイベント名 */
export const TABLE_MENU_STATE_CHANGE_EVENT = 'tms-mde-table-menu-state-change';

/** このエディタで上部メニューが操作する表とセル */
type ActiveTableMenuTarget = {
	/** 対象表の開始位置 */
	tableFrom: number;
	/** メニューが覚えるセル。セルが無ければ null */
	cell: TableCellPosition | null;
};

/** EditorView から、上部メニューの操作対象。ビューが捨てられるまで */
const activeTableMenuTargets = new WeakMap<EditorView, ActiveTableMenuTarget>();

/** 上部テーブルメニューの操作対象を、このEditorView内の1表へ固定する */
function activateTableMenuTarget(
	view: EditorView,
	wrap: HTMLElement,
	cell?: TableCellPosition | null,
): void {
	view.dom.querySelectorAll<HTMLElement>('.cm-md-table-wrap[data-table-menu-active="true"]').forEach((candidate) => {
		if (candidate !== wrap) delete candidate.dataset.tableMenuActive;
	});
	wrap.dataset.tableMenuActive = 'true';
	if (cell) wrap.dataset.tableMenuCell = `${cell.row},${cell.column}`;
	else delete wrap.dataset.tableMenuCell;
	const tableFrom = Number(wrap.dataset.tableFrom);
	if (Number.isInteger(tableFrom)) activeTableMenuTargets.set(view, { tableFrom, cell: cell ?? null });
	wrap.dispatchEvent(new CustomEvent(TABLE_MENU_STATE_CHANGE_EVENT, { bubbles: true }));
}

/** 表外へ操作対象が移ったとき、上部テーブルメニューの表対象を解除する */
export function clearActiveTableMenuTarget(view: EditorView): void {
	let changed = false;
	if (activeTableMenuTargets.delete(view)) changed = true;
	view.dom.querySelectorAll<HTMLElement>('.cm-md-table-wrap[data-table-menu-active="true"]').forEach((wrap) => {
		delete wrap.dataset.tableMenuActive;
		delete wrap.dataset.tableMenuCell;
		changed = true;
	});
	if (changed) view.dom.dispatchEvent(new CustomEvent(TABLE_MENU_STATE_CHANGE_EVENT, { bubbles: true }));
}

/** 選択変更を上部テーブルメニューの状態同期へ通知する */
function notifyTableMenuStateChange(wrap: HTMLElement): void {
	wrap.dispatchEvent(new CustomEvent(TABLE_MENU_STATE_CHANGE_EVENT, { bubbles: true }));
}

/**
 * 選択範囲を表へ書き、見た目を更新する
 * @param wrap - 表ラッパー
 * @param table - 表
 * @param rect - 矩形
 */
function writeTableSelectionRect(
	wrap: HTMLElement,
	table: HTMLTableElement,
	rect: TableSelectionRect,
): void {
	wrap.dataset.tableSelection = [
		rect.startRow,
		rect.startColumn,
		rect.endRow,
		rect.endColumn,
	].join(',');
	for (const cell of table.querySelectorAll<HTMLElement>('[data-table-row]')) {
		const row    = Number(cell.dataset.tableRow);
		const column = Number(cell.dataset.tableColumn);
		if (!Number.isInteger(row) || !Number.isInteger(column)) {
			continue;
		}

		const tableCell = cell instanceof HTMLTableCellElement ? cell : null;
		const edges     = describeTableCellSelection(
			{ row, column },
			tableCell?.rowSpan ?? 1,
			tableCell?.colSpan ?? 1,
			rect,
		);
		cell.classList.toggle('cm-md-table-cell-selected', edges.selected);
		cell.classList.toggle('cm-md-table-sel-n', edges.north);
		cell.classList.toggle('cm-md-table-sel-s', edges.south);
		cell.classList.toggle('cm-md-table-sel-e', edges.east);
		cell.classList.toggle('cm-md-table-sel-w', edges.west);
	}
	notifyTableMenuStateChange(wrap);
}

/** セル選択の外周に付けるクラス名。実行中は変えない */
const TABLE_CELL_SELECTION_CLASS_NAMES = [
	'cm-md-table-cell-selected',
	'cm-md-table-sel-n',
	'cm-md-table-sel-s',
	'cm-md-table-sel-e',
	'cm-md-table-sel-w',
] as const;

/**
 * 表の矩形選択を消す
 * @param wrap - 表ラッパー
 * @param table - 表
 */
export function clearTableSelectionRect(wrap: HTMLElement, table: HTMLTableElement): void {
	const changed = wrap.dataset.tableSelection !== undefined;
	delete wrap.dataset.tableSelection;
	for (const cell of table.querySelectorAll<HTMLElement>('[data-table-row]')) {
		cell.classList.remove(...TABLE_CELL_SELECTION_CLASS_NAMES);
	}
	if (changed) notifyTableMenuStateChange(wrap);
}

/**
 * 単一セルの編集位置へ同期する左クリックか判定する
 * Shift+左クリックは複数セル選択、右クリックは現在の選択を使うメニュー表示に任せる
 */
export function shouldSyncTableCellEditorOnMouseDown(
	event: Pick<MouseEvent, 'button' | 'shiftKey'>,
): boolean {
	return event.button === 0 && !event.shiftKey;
}

/** 複数セル選択中の右クリックで、ブラウザー既定のセルフォーカス移動を抑止する */
export function shouldPreserveTableCellSelectionOnMouseDown(
	event: Pick<MouseEvent, 'button'>,
	hasSelection: boolean,
): boolean {
	return event.button === 2 && hasSelection;
}

/**
 * 複数セルなら塗り、1セルなら消す
 * @param wrap - 表ラッパー
 * @param table - 表
 * @param rect - 矩形
 */
function writeOrClearTableSelection(
	wrap: HTMLElement,
	table: HTMLTableElement,
	rect: TableSelectionRect,
): void {
	if (isMultiCellTableSelectionRect(rect)) {
		writeTableSelectionRect(wrap, table, rect);
		return;
	}

	clearTableSelectionRect(wrap, table);
}

/**
 * 描画済みの表から矩形選択を消す
 * @param view - エディタ
 * @param tableFrom - 表開始位置
 */
function clearRenderedTableSelection(view: EditorView, tableFrom: number): void {
	const wrap  = view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`);
	const table = wrap?.querySelector('table.cm-md-table');
	if (!wrap || !(table instanceof HTMLTableElement)) {
		return;
	}

	clearTableSelectionRect(wrap, table);
}

/**
 * ライブプレビュー表のセル選択を付ける
 * @param wrap - 表ラッパー
 * @param table - 表
 * @param data - 表データ
 * @param view - エディタ
 */
function attachTableCellSelection(
	wrap: HTMLElement,
	table: HTMLTableElement,
	data: TableData,
	view: EditorView,
): void {
	let anchor: TableCellPosition | null            = null;
	let dragging                                    = false;
	let dragOrigin: { x: number; y: number } | null = null;

	/**
	 * クリック先のセル要素から、表の中の位置を読む
	 * @param target - イベントの対象。セルの外なら null
	 * @returns 見出し行を 0 とした位置。セルでなければ null
	 */
	const positionFromTarget = (target: EventTarget | null): TableCellPosition | null => {
		const cell = target instanceof Element
			? target.closest<HTMLElement>('[data-table-row][data-table-column]')
			: null;
		if (!cell || !table.contains(cell)) {
			return null;
		}

		const row    = Number(cell.dataset.tableRow);
		const column = Number(cell.dataset.tableColumn);
		if (!Number.isInteger(row) || !Number.isInteger(column)) {
			return null;
		}

		return { row, column };
	};

	wrap.addEventListener('mousedown', (event) => {
		if (event.button !== 0) {
			return;
		}

		if (event.target instanceof Element && event.target.closest('.cm-md-table-col-resizer, .cm-md-table-row-resizer, .cm-md-image-wrap')) {
			return;
		}

		const position = positionFromTarget(event.target);
		if (!position) {
			return;
		}
		activateTableMenuTarget(view, wrap, position);

		if (event.shiftKey && anchor) {
			event.preventDefault();
			writeOrClearTableSelection(wrap, table, normalizeTableSelectionRect(anchor, position));
			return;
		}

		anchor     = position;
		dragging   = true;
		dragOrigin = { x: event.clientX, y: event.clientY };
		clearTableSelectionRect(wrap, table);
		clearTableStructureSelection(wrap, table);
	});
	wrap.addEventListener('mouseover', (event) => {
		if (
			!dragging
			|| !anchor
			|| !dragOrigin
			|| (event.buttons & 1) === 0
			|| !hasTableSelectionPointerMoved(dragOrigin, { x: event.clientX, y: event.clientY })
		) {
			return;
		}

		const position = positionFromTarget(event.target);
		if (!position) {
			return;
		}

		writeOrClearTableSelection(wrap, table, normalizeTableSelectionRect(anchor, position));
	});
	wrap.addEventListener('mouseup', () => {
		dragging   = false;
		dragOrigin = null;
	});
	void view;
	void data;
}

/**
 * 表の再配置だけで発生する mouseover と、実際のドラッグ操作を区別する
 * @param origin - mousedown 座標
 * @param current - 現在座標
 * @param threshold - 開始とみなす最小移動量
 * @returns 実ドラッグとして扱うか
 */
export function hasTableSelectionPointerMoved(
	origin: { x: number; y: number },
	current: { x: number; y: number },
	threshold = 4,
): boolean {
	const deltaX = current.x - origin.x;
	const deltaY = current.y - origin.y;
	return deltaX * deltaX + deltaY * deltaY >= threshold * threshold;
}

/** 行・列選択に含まれるセルへ付けるクラス */
const TABLE_STRUCTURE_SELECTION_CLASS        = 'cm-md-table-structure-selected';
/** 選択ヘッダーを出しているあいだ表の枠へ付けるクラス */
const TABLE_STRUCTURE_CONTROLS_VISIBLE_CLASS = 'cm-md-table-structure-controls-visible';
/** セル DOM の差し替えを、表の外側の補助 UI へ知らせるイベント名 */
const TABLE_GEOMETRY_CHANGE_EVENT            = 'tms-mde-table-geometry-change';
/** 選択ヘッダーのために空ける余白（px） */
const TABLE_STRUCTURE_CONTROLS_GUTTER_PX     = 26;

/**
 * 選択ヘッダーの基準となる表本体とラッパーの両方をサイズ監視する
 * ヘッダー表示時はラッパーへ余白が付き、表の位置だけが変わる場合がある
 */
export function observeTableStructureGeometry(
	observer: Pick<ResizeObserver, 'observe'>,
	wrap: Element,
	table: Element,
): void {
	observer.observe(wrap);
	observer.observe(table);
}

/**
 * 選択ヘッダー表示用の余白がレイアウト計測へ反映される前でも、表本体の基準位置を返す
 */
export function resolveTableStructureOffset(
	measuredOffset: number,
	controlPadding: number,
	controlsVisible: boolean,
): number {
	return controlsVisible ? Math.max(measuredOffset, controlPadding) : measuredOffset;
}

/**
 * セルの表示DOMを差し替えたことを、表外周の補助UIへ通知する
 * @param cell - 対象セル
 */
function notifyTableGeometryChange(cell: HTMLElement): void {
	const wrap = cell.closest<HTMLElement>('.cm-md-table-wrap');
	if (!wrap) {
		return;
	}

	wrap.dispatchEvent(new Event(TABLE_GEOMETRY_CHANGE_EVENT));
}

/** 表構造選択ヘッダーを表の外周へ追加する */
function attachTableStructureControls(
	wrap: HTMLElement,
	table: HTMLTableElement,
	data: TableData,
	view: EditorView,
	onGeometryChange: () => void,
): void {
	const columnGroups = buildTableStructureGroups(data, 'column');
	const rowGroups    = buildTableStructureGroups(data, 'row');
	if (columnGroups.length === 0) {
		return;
	}

	const controls     = document.createElement('div');
	controls.className = 'cm-md-table-structure-controls';
	controls.setAttribute('contenteditable', 'false');
	controls.hidden = true;
	wrap.appendChild(controls);
	let anchor: { axis: TableStructureAxis; group: TableStructureRange } | null = null;
	let dragging                                                                = false;

	/**
	 * 行または列の選択ボタンを作る
	 * @param axis - row は行、column は列
	 * @param group - ボタンが担当する選択単位。start と end は 0 始まり
	 * @returns 番号を表示する button。フォーカスは受け取らない
	 */
	const createButton = (axis: TableStructureAxis, group: TableStructureRange): HTMLButtonElement => {
		const button                       = document.createElement('button');
		button.type                        = 'button';
		button.tabIndex                    = -1;
		button.className                   = `cm-md-table-structure-selector is-${axis}`;
		button.dataset.tableStructureAxis  = axis;
		button.dataset.tableStructureStart = String(group.start);
		button.dataset.tableStructureEnd   = String(group.end);
		const numberFrom                   = axis === 'row' ? group.start : group.start + 1;
		const numberTo                     = axis === 'row' ? group.end : group.end + 1;
		const label                        = numberFrom === numberTo ? String(numberFrom) : `${numberFrom}–${numberTo}`;
		button.textContent                 = '';
		button.title                       = `${axis === 'row' ? '行' : '列'} ${label} を選択`;
		button.setAttribute('aria-label', button.title);
		button.setAttribute('aria-pressed', 'false');
		return button;
	};

	columnGroups.forEach((group) => controls.appendChild(createButton('column', group)));
	rowGroups.forEach((group) => controls.appendChild(createButton('row', group)));

	/** ボタンを表の実寸へ合わせる */
	const sync = (): void => {
		const wrapRect   = wrap.getBoundingClientRect();
		const tableRect  = table.getBoundingClientRect();
		const visible    = !controls.hidden;
		const tableLeft  = resolveTableStructureOffset(
			resolveTableRelativeOffset(wrapRect.left, tableRect.left, wrap.scrollLeft),
			TABLE_STRUCTURE_CONTROLS_GUTTER_PX,
			visible,
		);
		const tableTop   = resolveTableStructureOffset(
			resolveTableRelativeOffset(wrapRect.top, tableRect.top, wrap.scrollTop),
			TABLE_STRUCTURE_CONTROLS_GUTTER_PX,
			visible,
		);
		const rightEdges = computeColumnRightEdges(collectTableCellBoxes(table), columnGroups.at(-1)!.end + 1);
		controls.querySelectorAll<HTMLElement>('.cm-md-table-structure-selector.is-column').forEach((button) => {
			const range = readTableStructureRange(button);
			if (!range) return;
			const left         = range.start === 0 ? 0 : rightEdges[range.start - 1] ?? 0;
			const right        = rightEdges[range.end] ?? left;
			button.style.left  = `${tableLeft + left}px`;
			button.style.top   = '0';
			button.style.width = `${Math.max(0, right - left)}px`;
		});
		controls.querySelectorAll<HTMLElement>('.cm-md-table-structure-selector.is-row').forEach((button) => {
			const range = readTableStructureRange(button);
			if (!range) return;
			const first = table.rows[range.start];
			const last  = table.rows[range.end];
			if (!first || !last) return;
			const firstRect = first.getBoundingClientRect();
			const lastRect  = last.getBoundingClientRect();

			button.style.left   = '0';
			button.style.top    = `${tableTop + firstRect.top - tableRect.top}px`;
			button.style.height = `${lastRect.bottom - firstRect.top}px`;
		});
	};

	/** セルDOMの切替直後とレイアウト確定後の両方で、表外周の補助UIを合わせ直す */
	const syncAfterGeometryChange = (): void => {
		sync();
		onGeometryChange();
		requestAnimationFrame(() => {
			if (!table.isConnected) return;
			sync();
			onGeometryChange();
		});
	};

	/** ヘッダーと専用余白をまとめて切り替え、表上のリサイズハンドルを追従させる */
	const setVisible = (visible: boolean): void => {
		if (controls.hidden === !visible) return;
		controls.hidden = !visible;
		wrap.classList.toggle(TABLE_STRUCTURE_CONTROLS_VISIBLE_CLASS, visible);
		syncAfterGeometryChange();
	};

	/**
	 * 行または列の選択を、ボタン操作に合わせて更新する
	 * @param axis - 選択する軸。現在の軸と違うときは拡張しない
	 * @param group - クリックした選択単位
	 * @param extend - true なら現在の選択とつなげ、false ならその単位だけにする
	 */
	const select = (axis: TableStructureAxis, group: TableStructureRange, extend: boolean): void => {
		const current = readTableStructureSelection(wrap);
		if (!extend
			&& current?.axis === axis
			&& current.start === group.start
			&& current.end === group.end) {
			anchor = null;
			clearTableStructureSelection(wrap, table);
			return;
		}

		const groups = axis === 'row' ? rowGroups : columnGroups;
		if (!extend || !anchor || anchor.axis !== axis) {
			anchor = { axis, group };
			writeTableStructureSelection(wrap, table, { axis, ...group });
			return;
		}
		const anchorIndex = groups.findIndex((item) => item.start === anchor!.group.start && item.end === anchor!.group.end);
		const focusIndex  = groups.findIndex((item) => item.start === group.start && item.end === group.end);
		if (anchorIndex < 0 || focusIndex < 0) return;
		const from = Math.min(anchorIndex, focusIndex);
		const to   = Math.max(anchorIndex, focusIndex);
		writeTableStructureSelection(wrap, table, {
			axis,
			start: groups[from]!.start,
			end  : groups[to]!.end,
		});
	};

	controls.addEventListener('mousedown', (event) => {
		const button = event.target instanceof Element
			? event.target.closest<HTMLElement>('.cm-md-table-structure-selector')
			: null;
		const target = button ? readTableStructureButton(button) : null;
		if (!target) return;
		activateTableMenuTarget(view, wrap);
		if (event.button === 2) {
			const selection = resolveTableStructureContextSelection(
				readTableStructureSelection(wrap),
				{ axis: target.axis, ...target.range },
			);
			anchor          = { axis: selection.axis, group: { start: selection.start, end: selection.end } };
			writeTableStructureSelection(wrap, table, selection);
			return;
		}
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		dragging = true;
		select(target.axis, target.range, event.shiftKey);
	});
	controls.addEventListener('mouseover', (event) => {
		if (!dragging || (event.buttons & 1) === 0) return;
		const button = event.target instanceof Element
			? event.target.closest<HTMLElement>('.cm-md-table-structure-selector')
			: null;
		const target = button ? readTableStructureButton(button) : null;
		if (!target || !anchor || target.axis !== anchor.axis) return;
		select(target.axis, target.range, true);
	});
	controls.addEventListener('contextmenu', (event) => {
		const button = event.target instanceof Element
			? event.target.closest<HTMLElement>('.cm-md-table-structure-selector')
			: null;
		const target = button ? readTableStructureButton(button) : null;
		if (!target) return;
		const selection = resolveTableStructureContextSelection(
			readTableStructureSelection(wrap),
			{ axis: target.axis, ...target.range },
		);
		anchor          = { axis: selection.axis, group: { start: selection.start, end: selection.end } };
		writeTableStructureSelection(wrap, table, selection);
	});
	controls.addEventListener('mouseup', () => {
		dragging = false;
	});
	wrap.addEventListener('focusin', () => {
		setVisible(true);
	});
	wrap.addEventListener('focusout', () => {
		queueMicrotask(() => {
			setVisible(!shouldHideTableStructureControls(
				wrap.contains(wrap.ownerDocument.activeElement),
				Boolean(readTableStructureSelection(wrap)),
			));
		});
	});
	wrap.addEventListener(TABLE_GEOMETRY_CHANGE_EVENT, syncAfterGeometryChange);

	sync();
	requestAnimationFrame(sync);
	const observer = new ResizeObserver(() => {
		if (!table.isConnected) {
			observer.disconnect();
			return;
		}
		sync();
	});
	observeTableStructureGeometry(observer, wrap, table);
	void view;
}

/**
 * 選択ボタンの dataset から、軸と範囲を読む
 * @param button - 行または列の選択ボタン
 * @returns 軸と範囲。dataset が欠けていれば null
 */
function readTableStructureButton(button: HTMLElement): { axis: TableStructureAxis; range: TableStructureRange } | null {
	const axis  = button.dataset.tableStructureAxis;
	const range = readTableStructureRange(button);
	return (axis === 'row' || axis === 'column') && range ? { axis, range } : null;
}

/**
 * 要素の dataset から、選択単位の開始と終了を読む
 * @param element - start と end を dataset に持つ要素
 * @returns 開始が終了以下の範囲。数値でなければ null
 */
function readTableStructureRange(element: HTMLElement): TableStructureRange | null {
	const start = Number(element.dataset.tableStructureStart);
	const end   = Number(element.dataset.tableStructureEnd);
	return Number.isInteger(start) && Number.isInteger(end) && start <= end ? { start, end } : null;
}

/**
 * 表ラッパーに記録した行または列の選択を読む
 * @param wrap - dataset.tableStructureSelection を持つ表の枠
 * @returns 軸と範囲。未選択や壊れた値なら null
 */
function readTableStructureSelection(wrap: HTMLElement): TableStructureSelection | null {
	const [axis, rawStart, rawEnd] = (wrap.dataset.tableStructureSelection ?? '').split(',');
	const start                    = Number(rawStart);
	const end                      = Number(rawEnd);
	return (axis === 'row' || axis === 'column') && Number.isInteger(start) && Number.isInteger(end) && start <= end
		? { axis, start, end }
		: null;
}

/**
 * 行と列の選択表示を消し、メニューへ状態変化を通知する
 * @param wrap - 選択 dataset を消す表の枠
 * @param table - 選択クラスを外す表要素
 */
function clearTableStructureSelection(wrap: HTMLElement, table: HTMLTableElement): void {
	const changed = wrap.dataset.tableStructureSelection !== undefined;
	delete wrap.dataset.tableStructureSelection;
	wrap.querySelectorAll<HTMLElement>('.cm-md-table-structure-selector').forEach((button) => {
		button.classList.remove('is-selected');
		button.setAttribute('aria-pressed', 'false');
	});
	table.querySelectorAll(`.${TABLE_STRUCTURE_SELECTION_CLASS}`).forEach((cell) => {
		cell.classList.remove(TABLE_STRUCTURE_SELECTION_CLASS);
	});
	if (changed) notifyTableMenuStateChange(wrap);
}

/**
 * 行または列の選択を dataset とボタンの押下状態へ書く
 * セル範囲の選択は先に消す
 * @param wrap - 選択を記録する表の枠
 * @param table - 選択クラスを付ける表要素
 * @param selection - 書く軸と範囲
 */
function writeTableStructureSelection(
	wrap: HTMLElement,
	table: HTMLTableElement,
	selection: TableStructureSelection,
): void {
	clearTableSelectionRect(wrap, table);
	wrap.dataset.tableStructureSelection = `${selection.axis},${selection.start},${selection.end}`;
	wrap.querySelectorAll<HTMLElement>('.cm-md-table-structure-selector').forEach((button) => {
		const target   = readTableStructureButton(button);
		const selected = Boolean(target
			&& target.axis === selection.axis
			&& target.range.start >= selection.start
			&& target.range.end <= selection.end);
		button.classList.toggle('is-selected', selected);
		button.setAttribute('aria-pressed', String(selected));
	});
	table.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]').forEach((cell) => {
		const row      = Number(cell.dataset.tableRow);
		const column   = Number(cell.dataset.tableColumn);
		const span     = cell instanceof HTMLTableCellElement
			? selection.axis === 'row' ? cell.rowSpan : cell.colSpan
			: 1;
		const value    = selection.axis === 'row' ? row : column;
		const selected = value >= selection.start && value + span - 1 <= selection.end;
		cell.classList.toggle(TABLE_STRUCTURE_SELECTION_CLASS, selected);
	});
	notifyTableMenuStateChange(wrap);
}

/** 行・列メニューが固定した、表位置と選択と操作可否 */
export type TableStructureMenuSnapshot = TableStructureSelection & {
	tableFrom: number;
	canDelete: boolean;
	canMovePrevious: boolean;
	canMoveNext: boolean;
};

/** 右クリックした行・列選択ヘッダーの操作対象を固定する */
export function snapshotTableStructureActionFromEvent(
	view: EditorView,
	event: MouseEvent,
): TableStructureMenuSnapshot | null {
	const button = event.target instanceof Element
		? event.target.closest<HTMLElement>('.cm-md-table-structure-selector')
		: null;
	const wrap   = button?.closest<HTMLElement>('.cm-md-table-wrap');
	if (!button || !wrap || !view.dom.contains(wrap)) return null;
	const tableFrom = Number(wrap.dataset.tableFrom);
	const selection = readTableStructureSelection(wrap);
	if (!Number.isInteger(tableFrom) || !selection) return null;
	const tableNode = findTableNodeAt(view.state, tableFrom);
	if (!tableNode) return null;
	const data  = extractTableData(view.state, tableNode);
	const state = getTableStructureActionState(data, selection);
	return { tableFrom, ...selection, ...state };
}

/** 固定済みの行・列範囲へ構造操作を適用する */
export function applyTableStructureSnapshot(
	view: EditorView,
	snapshot: Pick<TableStructureMenuSnapshot, 'tableFrom' | 'axis' | 'start' | 'end'>,
	action: TableStructureAction,
): boolean {
	if (view.state.readOnly) return false;
	persistEditingTableCellsAt(view, snapshot.tableFrom);
	const tableNode = findTableNodeAt(view.state, snapshot.tableFrom);
	if (!tableNode) return false;
	const data   = extractTableData(view.state, tableNode);
	const change = buildTableStructureChange(view.state, data, snapshot, action);
	if (!change) return false;
	view.dispatch({ changes: change, userEvent: 'input.type' });
	view.focus();
	return true;
}

/**
 * マウス位置の表結合操作状態を返す
 * @param view - エディタ
 * @param event - マウス
 * @returns マウス位置の表結合操作状態
 */
export type TableMergeMenuSnapshot = TableMergeActionState & {
	tableFrom: number;
};

/** 上部メニューが読む、最後に操作した表の状態 */
export type TableMenuSnapshot = {
	/** 操作対象が Markdown 表なら true。表の外なら false */
	inMarkdownTable: boolean;
	/** 行・列選択の操作。セル選択中は null */
	structure: TableStructureMenuSnapshot | null;
	/** セル結合の操作。行・列選択中は null */
	merge: TableMergeMenuSnapshot | null;
};

/** 上部メニュー用に、最後に操作した表と現在の行・列・セル選択を取得する */
export function snapshotActiveTableMenu(view: EditorView): TableMenuSnapshot {
	const target = activeTableMenuTargets.get(view) ?? null;
	const wrap   = view.dom.querySelector<HTMLElement>('.cm-md-table-wrap[data-table-menu-active="true"]')
		?? Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-md-table-wrap'))
			.find((candidate) => Number(candidate.dataset.tableFrom) === target?.tableFrom)
		?? null;
	if (!wrap) return { inMarkdownTable: false, structure: null, merge: null };

	const tableFrom = target?.tableFrom ?? Number(wrap.dataset.tableFrom);
	if (!Number.isInteger(tableFrom)) return { inMarkdownTable: false, structure: null, merge: null };
	const tableNode = findTableNodeAt(view.state, tableFrom);
	if (!tableNode) return { inMarkdownTable: false, structure: null, merge: null };
	const data      = extractTableData(view.state, tableNode);
	const selection = readTableStructureSelection(wrap);
	if (selection) {
		return {
			inMarkdownTable: true,
			structure      : { tableFrom, ...selection, ...getTableStructureActionState(data, selection) },
			merge          : null,
		};
	}

	const storedCell          = target?.tableFrom === tableFrom ? target.cell : null;
	const [rawRow, rawColumn] = (wrap.dataset.tableMenuCell ?? '').split(',');
	const row                 = Number(rawRow);
	const column              = Number(rawColumn);
	const clicked             = storedCell ?? (rawRow !== '' && rawColumn !== '' && Number.isInteger(row) && Number.isInteger(column)
		? { row, column }
		: null);
	const resolved            = resolveTableMergeTargetFromParts(
		view.state,
		tableFrom,
		readTableSelectionRect(wrap),
		clicked,
	);
	return {
		inMarkdownTable: true,
		structure      : null,
		merge          : resolved
			? { tableFrom, rect: resolved.state.rect, canMerge: resolved.state.canMerge, canUnmerge: resolved.state.canUnmerge }
			: null,
	};
}

/**
 * 右クリック時点の結合操作対象を残す。メニュー選択時の DOM には依存しない
 * @param view - エディタ
 * @param event - マウス
 * @returns 右クリック時点の結合操作対象を残す。メニュー選択時の DOM には依存しない。無ければ null
 */
export function snapshotTableMergeActionFromEvent(
	view: EditorView,
	event: MouseEvent,
): TableMergeMenuSnapshot | null {
	const resolved = resolveTableMergeTarget(view, event);
	if (!resolved) {
		return null;
	}

	return {
		tableFrom : resolved.data.tableFrom,
		rect      : resolved.state.rect,
		canMerge  : resolved.state.canMerge,
		canUnmerge: resolved.state.canUnmerge,
	};
}

/** コンテキストメニュー表示中に固定したセル範囲から、結合可否を返す */
export function getTableMergeActionStateFromEvent(
	view: EditorView,
	event: MouseEvent,
): TableMergeActionState | null {
	return snapshotTableMergeActionFromEvent(view, event);
}

/**
 * 表位置とクリック／選択から結合操作対象を決める
 * メニュー選択までに右クリック先の DOM が外れても、文書上の表を対象にする
 * @param state - 状態
 * @param tableFrom - 表開始位置
 * @param selected - ドラッグ選択
 * @param clicked - クリック位置
 * @returns 表位置とクリック／選択から結合操作対象を決める。無ければ null
 */
export function resolveTableMergeTargetFromParts(
	state: EditorState,
	tableFrom: number,
	selected: TableSelectionRect | null,
	clicked: TableCellPosition | null,
): { data: TableData; state: TableMergeActionState } | null {
	if (!Number.isInteger(tableFrom)) {
		return null;
	}

	const tableNode = findTableNodeAt(state, tableFrom);
	if (!tableNode) {
		return null;
	}

	const data = extractTableData(state, tableNode);
	const rect = resolveTableMergeRect(data, selected, clicked);
	if (!rect) {
		return null;
	}

	return { data, state: getTableMergeActionState(data, rect) };
}

/**
 * セル結合または解除を文書へ書く
 * @param view - エディタ
 * @param event - マウス
 * @param action - 操作
 * @returns セル結合または解除を文書へ書くなら true
 */
export function applyTableMergeSnapshot(
	view: EditorView,
	snapshot: Pick<TableMergeMenuSnapshot, 'tableFrom' | 'rect'>,
	action: 'merge' | 'unmerge',
): boolean {
	if (view.state.readOnly) {
		return false;
	}

	persistEditingTableCellsAt(view, snapshot.tableFrom);
	const tableNode = findTableNodeAt(view.state, snapshot.tableFrom);
	if (!tableNode) {
		return false;
	}

	const data    = extractTableData(view.state, tableNode);
	const changes = action === 'merge'
		? buildMergeTableCellsChanges(data, snapshot.rect)
		: buildUnmergeTableCellsChanges(data, snapshot.rect);
	if (!changes || changes.length === 0) {
		return false;
	}

	const origin = {
		row   : snapshot.rect.startRow,
		column: snapshot.rect.startColumn,
	};
	view.dispatch({
		changes  : changes.map((change) => ({ from: change.from, to: change.to, insert: change.insert })),
		userEvent: action === 'merge' ? 'input.table.merge' : 'input.table.unmerge',
	});
	clearRenderedTableSelection(view, data.tableFrom);
	restoreTableCellFocus(view, data.tableFrom, origin, 0, false);
	return true;
}

/** クリック時点の選択範囲を固定し、再描画後も同じセルへ結合操作を適用する */
export function applyTableMergeAction(
	view: EditorView,
	event: MouseEvent,
	action: 'merge' | 'unmerge',
): boolean {
	const snapshot = snapshotTableMergeActionFromEvent(view, event);
	if (!snapshot) {
		return false;
	}

	return applyTableMergeSnapshot(view, snapshot, action);
}

/**
 * メニュー時点の矩形へ配置を書く。選択時の DOM には依存しない
 * @param view - エディタ
 * @param snapshot - 右クリック時点の対象
 * @param patch - 配置
 * @returns メニュー時点の矩形へ配置を書く。選択時の DOM には依存しないなら true
 */
export function applyTableAlignSnapshot(
	view: EditorView,
	snapshot: Pick<TableMergeMenuSnapshot, 'tableFrom' | 'rect'>,
	patch: TableAlignPatch,
): boolean {
	if (view.state.readOnly) {
		return false;
	}

	persistEditingTableCellsAt(view, snapshot.tableFrom);
	const tableNode = findTableNodeAt(view.state, snapshot.tableFrom);
	if (!tableNode) {
		return false;
	}

	const data    = extractTableData(view.state, tableNode);
	const changes = buildAlignTableCellsChanges(data, snapshot.rect, patch);
	if (!changes || changes.length === 0) {
		return false;
	}

	view.dispatch({
		changes  : collapseTableDocumentChanges(
			view.state.doc.sliceString(data.tableFrom, data.tableTo),
			data.tableFrom,
			data.tableTo,
			changes,
		),
		userEvent: 'input.table.align',
	});
	const tableFrom = findTableNodeAt(view.state, snapshot.tableFrom)?.from ?? snapshot.tableFrom;
	syncRenderedTableAlignment(view, tableFrom);
	return true;
}

/**
 * セル単位の変更を表全体の1置換にする
 * 表ウィジェットは複数行 replace のため、内部だけの変更だと CodeMirror が
 * 既存 DOM を continueWidget で残し、配置クラスが付いた新しい表が乗らない
 * 表の右側（同じソース行）をクリックすると行が組み直されて反映されるのはこのため
 * @param tableText - 表ソース
 * @param tableFrom - 表開始
 * @param tableTo - 表終了
 * @param changes - セル変更
 * @returns セル単位の変更を表全体の1置換にする
 */
export function collapseTableDocumentChanges(
	tableText: string,
	tableFrom: number,
	tableTo: number,
	changes: TableDocumentChange[],
): TableDocumentChange {
	let insert    = tableText;
	const ordered = [...changes].sort((left, right) => right.from - left.from);
	for (const change of ordered) {
		const from = change.from - tableFrom;
		const to   = change.to - tableFrom;
		insert     = insert.slice(0, from) + change.insert + insert.slice(to);
	}

	return { from: tableFrom, to: tableTo, insert };
}

/**
 * いま描画されている表へ、文書上の配置クラスを付け直す
 * ウィジェット再利用では `eq` が同じだと `updateDOM` が呼ばれず、プレビューだけ古いまま残る
 * @param view - エディタ
 * @param tableFrom - 表開始位置
 */
export function syncRenderedTableAlignment(view: EditorView, tableFrom: number): void {
	const wrap = findRenderedTableWrap(view, tableFrom);
	if (!wrap) {
		return;
	}

	const tableNode = findTableNodeAt(view.state, tableFrom);
	if (!tableNode) {
		return;
	}

	applyTableAlignmentClassesToWrap(wrap, extractTableData(view.state, tableNode));
}

/**
 * 描画中の表ラッパーを返す。位置がずれたあとも表を拾う
 * @param view - エディタ
 * @param tableFrom - 表開始位置
 * @returns 描画中の表ラッパーを返す。位置がずれたあとも表を拾う。無ければ null
 */
function findRenderedTableWrap(view: EditorView, tableFrom: number): HTMLElement | null {
	const roots = [view.contentDOM, view.dom].filter((node): node is HTMLElement => Boolean(node));
	for (const root of roots) {
		const exact = typeof root.querySelector === 'function'
			? root.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`)
			: null;
		if (exact) {
			return exact;
		}

		const wraps = typeof root.querySelectorAll === 'function'
			? [...root.querySelectorAll<HTMLElement>('.cm-md-table-wrap')]
			: [];
		const found = wraps.find((candidate) => {
			const from = Number(candidate.dataset.tableFrom);
			const to   = Number(candidate.dataset.tableTo);
			return from === tableFrom
				|| (Number.isInteger(from) && Number.isInteger(to) && from <= tableFrom && tableFrom < to);
		});
		if (found) {
			return found;
		}

		if (wraps.length === 1) {
			return wraps[0]!;
		}
	}

	return null;
}

/**
 * 表ラッパー内のセルへ配置クラスを付ける
 * @param wrap - 表ラッパー
 * @param data - 表
 */
function applyTableAlignmentClassesToWrap(wrap: HTMLElement, data: TableData): void {
	wrap.dataset.tableFrom = String(data.tableFrom);
	wrap.dataset.tableTo   = String(data.tableTo);
	for (const cell of wrap.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')) {
		const position = {
			row   : Number(cell.dataset.tableRow),
			column: Number(cell.dataset.tableColumn),
		};
		const source   = getTableCellSource(data, position);
		if (!source || !Number.isInteger(position.row) || !Number.isInteger(position.column)) {
			continue;
		}

		cell.dataset.source       = source.text;
		cell.dataset.editableText = source.editableText;
		applyCellAlignmentClasses(cell, source.text);
	}
}

/**
 * セル配置を文書へ書く
 * @param view - エディタ
 * @param event - マウス
 * @param patch - 配置
 * @returns セル配置を文書へ書くなら true
 */
export function applyTableAlignAction(
	view: EditorView,
	event: MouseEvent,
	patch: TableAlignPatch,
): boolean {
	const snapshot = snapshotTableMergeActionFromEvent(view, event);
	if (!snapshot) {
		return false;
	}

	return applyTableAlignSnapshot(view, snapshot, patch);
}

/**
 * 罫線ドラッグで決めた列幅・行高を見出し左上セルへ書く
 * @param view - エディタ
 * @param tableFrom - 表開始位置
 * @param layout - 測ったレイアウト
 * @param hit - 操作した罫線
 * @returns 罫線ドラッグで決めた列幅・行高を見出し左上セルへ書くなら true
 */
export function persistTableLayout(
	view: EditorView,
	tableFrom: number,
	layout: TableLayout,
	hit: TableResizeHit,
): boolean {
	if (view.state.readOnly || !Number.isInteger(tableFrom)) {
		return false;
	}

	const tableNode = findTableNodeAt(view.state, tableFrom);
	if (!tableNode || tableFrom < tableNode.from || tableFrom >= tableNode.to) {
		return false;
	}

	const data                  = extractTableData(view.state, tableNode);
	const current               = readTableLayout(data);
	const next: TableSizeLayout = hit.kind === 'col'
		? { widths: layout.widths, heights: current.heights }
		: { widths: current.widths, heights: layout.heights };
	const change                = buildTableLayoutChange(data, next);
	if (!change) {
		return false;
	}

	forgetTableLayout(getTableLayoutKey(data.tableFrom, getTableColumnCount(data)));
	view.dispatch({
		changes  : { from: change.from, to: change.to, insert: change.insert },
		userEvent: 'input.table.resize',
	});
	return true;
}

/**
 * 右クリック位置から、結合または解除の対象を決める
 * @param view - 構文木と表位置を読むエディタ
 * @param event - 右クリック。対象セルが取れなければ null
 * @returns 表データと結合可否。表の外なら null
 */
function resolveTableMergeTarget(
	view: EditorView,
	event: MouseEvent,
): { data: TableData; state: TableMergeActionState } | null {
	const parts = readTableMergeEventParts(event);
	if (!parts) {
		return null;
	}

	return resolveTableMergeTargetFromParts(
		view.state,
		parts.tableFrom,
		parts.selected,
		parts.clicked,
	);
}

/**
 * 右クリック先が DOM から外れても、表位置とセル位置を読む
 * @param event - マウス
 * @returns 右クリック先が DOM から外れても、表位置とセル位置
 */
function readTableMergeEventParts(
	event: MouseEvent,
): { tableFrom: number; selected: TableSelectionRect | null; clicked: TableCellPosition | null } | null {
	const start     = event.target instanceof Element
		? event.target
		: event.target instanceof Node
			? event.target.parentElement
			: null;
	const wrap      = start?.closest<HTMLElement>('.cm-md-table-wrap') ?? null;
	const tableFrom = Number(wrap?.dataset.tableFrom);
	if (!wrap || !Number.isInteger(tableFrom)) {
		return null;
	}

	const cell    = start?.closest<HTMLElement>('[data-table-row][data-table-column]') ?? null;
	const clicked = cell && Number.isInteger(Number(cell.dataset.tableRow))
		? { row: Number(cell.dataset.tableRow), column: Number(cell.dataset.tableColumn) }
		: null;
	return {
		tableFrom,
		selected: readTableSelectionRect(wrap),
		clicked,
	};
}

/**
 * いま描画されている表の編集中セルを文書へ書いて閉じる
 * @param view - エディタ
 * @param tableFrom - 表開始位置
 */
function persistEditingTableCellsAt(view: EditorView, tableFrom: number): void {
	const wrap = view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`);
	if (wrap) {
		deactivateOtherEditingTableCells(view, wrap, tableFrom, null);
	}
}

/**
 * セルソースの配置クラスを正規化する
 * @param sourceText - セルソース
 * @returns 正規化したセルソースの配置クラス
 */
function tableAlignmentClassKey(sourceText: string): string {
	return cellAlignmentClassNames(parseCellSpan(sourceText))
		.split(/\s+/)
		.filter(Boolean)
		.sort()
		.join(' ');
}

/**
 * セル DOM に付いている配置クラスを正規化する
 * @param cell - セル
 * @returns 正規化したセル DOM に付いている配置クラス
 */
function readCellAlignmentClassKey(cell: HTMLElement): string {
	return [...cell.classList]
		.filter((name) => name.startsWith('cm-md-table-align-') || name.startsWith('cm-md-table-valign-'))
		.sort()
		.join(' ');
}

/**
 * 既存 DOM の配置クラスが文書と一致するか。違うときは作り直す
 * クラスだけ付け替えても WebView では描画が更新されない
 * @param dom - 表ラッパー
 * @param data - 表
 * @returns 既存 DOM の配置クラスが文書と一致するか。違うときは作り直すなら true
 */
function tableDomMatchesAlignment(dom: HTMLElement, data: TableData): boolean {
	for (const cell of dom.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')) {
		const position = {
			row   : Number(cell.dataset.tableRow),
			column: Number(cell.dataset.tableColumn),
		};
		const source   = getTableCellSource(data, position);
		if (!source || !Number.isInteger(position.row) || !Number.isInteger(position.column)) {
			continue;
		}

		if (readCellAlignmentClassKey(cell) !== tableAlignmentClassKey(source.text)) {
			return false;
		}
	}

	return true;
}

/**
 * 既存 DOM のセル数が占有グリッドと一致するか。結合の増減では作り直す
 * @param dom - 表ラッパー
 * @param occupancy - 占有
 * @returns 既存 DOM のセル数が占有グリッドと一致するか。結合の増減では作り直すなら true
 */
function tableDomMatchesOccupancy(
	dom: HTMLElement,
	occupancy: ReturnType<typeof buildTableOccupancy>,
): boolean {
	const cells                                                                             = [...dom.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')];
	const visible: Array<{ row: number; column: number; colspan: number; rowspan: number }> = [];
	for (let row = 0; row < occupancy.rowCount; row += 1) {
		for (let column = 0; column < occupancy.columnCount; column += 1) {
			const item = occupancy.cells[row]?.[column];
			if (!item || item.covered) {
				continue;
			}

			visible.push({
				row,
				column,
				colspan: item.colspan,
				rowspan: item.rowspan,
			});
		}
	}

	if (cells.length !== visible.length) {
		return false;
	}

	return visible.every((item) => {
		const cell = cells.find((candidate) => (
			Number(candidate.dataset.tableRow) === item.row
			&& Number(candidate.dataset.tableColumn) === item.column
		));
		if (!cell) {
			return false;
		}

		const isTableCell = typeof HTMLTableCellElement !== 'undefined'
			&& cell instanceof HTMLTableCellElement;
		const colSpan     = isTableCell ? cell.colSpan : 1;
		const rowSpan     = isTableCell ? cell.rowSpan : 1;
		return colSpan === item.colspan && rowSpan === item.rowspan;
	});
}

// ==============================================
// 表ウィジェット
// ==============================================
/**
 * テーブル HTML ウィジェット
 */
export class TableWidget extends WidgetType {
	/** 今描いている表データ。同じ表の更新で差し替える */
	readonly data: TableData;
	/** コードハイライトの世代。言語の読み込み後に印を変える */
	readonly languageGeneration: number;

	/**
	 * @param data - テーブルデータ
	 */
	constructor(data: TableData) {
		super();
		this.data               = data;
		this.languageGeneration = getCodeLanguageGeneration();
	}

	/**
	 * @param other - 比較対象
	 * @returns 同一なら true
	 */
	eq(other: WidgetType): boolean {
		if (!(other instanceof TableWidget)) {
			return false;
		}

		return other.languageGeneration === this.languageGeneration
			&& other.data.tableFrom === this.data.tableFrom
			&& getTableDataIdentity(other.data) === getTableDataIdentity(this.data);
	}

	/**
	 * 同じ表として再利用するとき、位置と非編集セルだけ更新する
	 * 編集中セルは IME / 改行用に DOM を維持する
	 * @param dom - 既存 DOM
	 * @param view - エディタ
	 * @returns 同じ表として再利用するとき、位置と非編集セルだけ更新するなら true
	 */
	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		if (!dom?.classList?.contains('cm-md-table-wrap')) {
			return false;
		}

		const tableNode = findTableNodeAt(view.state, this.data.tableFrom);
		const data      = tableNode ? extractTableData(view.state, tableNode) : this.data;
		if (!tableDomMatchesOccupancy(dom, buildTableOccupancy(data))) {
			return false;
		}

		if (!tableDomMatchesAlignment(dom, data)) {
			return false;
		}

		dom.dataset.tableFrom = String(data.tableFrom);
		dom.dataset.tableTo   = String(data.tableTo);
		for (const cell of dom.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')) {
			const position = {
				row   : Number(cell.dataset.tableRow),
				column: Number(cell.dataset.tableColumn),
			};
			const source   = getTableCellSource(data, position);
			if (!source || !Number.isInteger(position.row) || !Number.isInteger(position.column)) {
				continue;
			}

			const changed             = cell.dataset.source !== source.text;
			cell.dataset.inlineRanges = JSON.stringify(source.inlineRanges);
			applyCellAlignmentClasses(cell, source.text);
			cell.dataset.source       = source.text;
			cell.dataset.editableText = source.editableText;
			if (!changed || cell.dataset.editing === 'true') {
				continue;
			}

			const nodes = position.row === 0
				? data.headers[position.column]
				: data.rows[position.row - 1]?.[position.column];
			if (!nodes) {
				continue;
			}

			fillTableCellContent(cell, nodes, view);
			applyRememberedWidthToCell(cell, nodes, position);
		}

		return true;
	}

	/**
	 * @returns 生成した要素
	 */
	toDOM(view: EditorView): HTMLElement {
		const wrap     = document.createElement('div');
		wrap.className = 'cm-md-table-wrap';
		wrap.setAttribute('contenteditable', 'false');
		wrap.dataset.tableFrom = String(this.data.tableFrom);
		wrap.dataset.tableTo   = String(this.data.tableTo);

		const table               = document.createElement('table');
		table.className           = 'cm-md-table';
		const columnCount         = getTableColumnCount(this.data);
		const occupancy           = buildTableOccupancy(this.data);
		table.dataset.columnCount = String(columnCount);

		/**
		 * 編集可能セルを生成する
		 * @param tagName - 要素名
		 * @param nodes - 表示ノード
		 * @param source - セルソース
		 * @param position - セル位置
		 * @returns 編集可能セル
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
			cell.contentEditable      = view.state.readOnly || !source ? 'false' : 'true';
			cell.spellcheck           = false;
			cell.setAttribute('aria-label', `表 ${position.row + 1} 行 ${position.column + 1} 列`);
			fillTableCellContent(cell, nodes, view);
			applyRememberedWidthToCell(cell, nodes, position);
			/**
			 * セル内画像へ、表の view から直接書き戻す処理を束縛する
			 * @param cellNodes - セル AST
			 */
			const bindCellImagePersist = (cellNodes: TableCellNode[]): void => {
				if (view.state.readOnly) {
					return;
				}

				const imageWrap = cell.querySelector<HTMLElement>('.cm-md-image-wrap');
				if (!imageWrap) {
					return;
				}

				bindImageWrapEditorView(imageWrap, view);
				bindImageResizePersister(imageWrap, (width) => writeTableCellImageWidth(
					view,
					this.data,
					position,
					imageWrap,
					cellNodes,
					width,
				));
			};

			bindCellImagePersist(nodes);
			let skipEditFromImage = false;
			cell.addEventListener('mousedown', (event) => {
				const target      = event.target;
				skipEditFromImage = target instanceof Element && Boolean(target.closest('.cm-md-image-wrap'));
				if (skipEditFromImage) {
					event.stopPropagation();
					return;
				}
				if (shouldPreserveTableCellSelectionOnMouseDown(event, Boolean(readTableSelectionRect(wrap)))) {
					event.preventDefault();
					return;
				}
				if (!shouldSyncTableCellEditorOnMouseDown(event)) {
					return;
				}

				// CodeMirror のカーソル同期で再描画される前に、直前の表選択表示を確実に消す
				clearTableSelectionRect(wrap, table);
				clearTableStructureSelection(wrap, table);
				syncTableCellEditorSelection(view, this.data, position);
			});

			if (!source || view.state.readOnly) {
				return cell;
			}

			cell.addEventListener('tms-mde-table-image-resized', (event: Event) => {
				const detail = (event as CustomEvent<{ width?: number; persisted?: boolean }>).detail;
				const width  = detail?.width;
				if (typeof width !== 'number' || !Number.isFinite(width)) {
					return;
				}

				const imageWrap = cell.querySelector<HTMLElement>('.cm-md-image-wrap');
				if (!imageWrap) {
					return;
				}

				/**
				 * 束縛済み view からソースへ書く
				 * @returns 書けたか
				 */
				const persist = (): boolean => writeTableCellImageWidth(
					view,
					this.data,
					position,
					imageWrap,
					nodes,
					width,
				);

				if (detail?.persisted || persist()) {
					const tableWrap = cell.closest<HTMLElement>('.cm-md-table-wrap');
					if (tableWrap) {
						tableWrap.dataset.tableTo = String(this.data.tableTo);
					}

					const next = replaceImageWidthInCellText(cell.dataset.source ?? '', width, true);
					if (next) {
						cell.dataset.source       = next;
						cell.dataset.editableText = next;
					}

					return;
				}

				queueMicrotask(persist);
				window.setTimeout(persist, 0);
				window.requestAnimationFrame(() => {
					window.requestAnimationFrame(() => {
						persist();
					});
				});
			});

			let composing                = false;
			let compositionCommitPending = false;
			let persistGuard             = 0;
			/**
			 * セル値だけを文書へ書く。フォーカスは動かさない
			 * @param userEvent - CodeMirror のユーザーイベント名
			 * @returns 書いたか
			 */
			const persistCellValue       = (userEvent: string): boolean => {
				if (cell.dataset.editing !== 'true' || composing) {
					return false;
				}

				const tableNode = findTableNodeAt(view.state, this.data.tableFrom);
				if (!tableNode) {
					return false;
				}

				const data       = extractTableData(view.state, tableNode);
				const liveSource = getTableCellSource(data, position);
				const value      = readTableCellEditableValue(cell);
				const change     = buildTableCellChange(data, position, value);
				if (!change || !liveSource || change.insert === liveSource.text) {
					return false;
				}

				forgetCellImageWidthIfSourceDropped(liveSource.text, change.insert, position);
				persistGuard += 1;
				try {
					view.dispatch({ changes: change, userEvent });
					syncTableDataAfterCellChange(this.data, position, change.insert, value);
					cell.dataset.source       = change.insert;
					cell.dataset.editableText = value;
				} finally {
					persistGuard -= 1;
				}

				return true;
			};
			/**
			 * セルの表示値を CodeMirror 文書へ反映し、編集中ならキャレットを戻す
			 * @param userEvent - CodeMirror のユーザーイベント名
			 */
			const dispatchCellValue = (userEvent: string): void => {
				const caret = getCellCaretOffset(cell);
				if (!persistCellValue(userEvent)) {
					return;
				}

				if (cell.isConnected && cell.dataset.editing === 'true') {
					cell.focus({ preventScroll: true });
					setCellSelection(cell, caret, false);
					return;
				}

				restoreTableCellFocus(view, this.data.tableFrom, position, caret, false);
			};

			cell.addEventListener('mouseup', () => {
				if (cell.dataset.editing === 'true') {
					updateTableCellInlineMarks(cell);
				}
			});
			cell.addEventListener('keyup', () => updateTableCellInlineMarks(cell));
			cell.addEventListener('dblclick', (event) => {
				event.preventDefault();
				event.stopPropagation();
				cell.dataset.forceImageEdit = 'true';
				activateTableCell(cell, view);
				setCellSelection(cell, 0, true);
			});
			cell.addEventListener('focus', () => {
				if (
					cell.dataset.editing === 'true'
					|| skipEditFromImage
					|| cellShowsOnlyImage(cell)
				) {
					skipEditFromImage = false;
					return;
				}

				window.setTimeout(() => {
					if (
						cell.dataset.editing === 'true'
						|| skipEditFromImage
						|| cellShowsOnlyImage(cell)
					) {
						skipEditFromImage = false;
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
					activateTableCell(cell, view);
					setCellSelection(cell, editableOffset, false);
				}, 0);
			});
			cell.addEventListener('blur', () => {
				if (persistGuard > 0) {
					window.queueMicrotask(() => {
						if (persistGuard > 0 || cell.ownerDocument.activeElement === cell) {
							return;
						}

						persistAndDeactivateTableCell(view, cell, this.data.tableFrom);
					});
					return;
				}

				const wasEditing = cell.dataset.editing === 'true';
				if (wasEditing) {
					composing                = false;
					compositionCommitPending = false;
					persistCellValue('input.type');
				}

				cell.dataset.editing = 'false';
				cell.classList.remove('cm-md-table-cell-editing');
				if (wasEditing) {
					const fresh = getCurrentTableCellNodes(view.state, this.data.tableFrom, position);
					const next  = fresh ?? nodes;
					fillTableCellContent(cell, next, view);
					applyRememberedWidthToCell(cell, next, position);
					bindCellImagePersist(next);
					notifyTableGeometryChange(cell);
				}
			});
			cell.addEventListener('compositionstart', () => {
				composing                = true;
				compositionCommitPending = false;
			});
			cell.addEventListener('compositionend', () => {
				composing                = false;
				compositionCommitPending = true;
				window.setTimeout(() => {
					if (composing) {
						return;
					}

					compositionCommitPending = false;
					dispatchCellValue('input.type.compose');
				}, 0);
			});
			cell.addEventListener('paste', (event) => {
				if (cell.dataset.editing !== 'true') {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				const pasted = event.clipboardData?.getData('text/plain') ?? '';
				cell.ownerDocument.execCommand('insertText', false, pasted);
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
					if (cell.dataset.editing !== 'true') {
						let inlineRanges: TableCellInlineRange[] = [];
						try {
							inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
						} catch {
							inlineRanges = [];
						}

						const previewOffset  = getCellCaretOffset(cell, true);
						const editableOffset = getTableCellEditableOffsetFromPreview(
							cell.dataset.editableText ?? cell.dataset.source ?? '',
							inlineRanges,
							previewOffset,
						);
						activateTableCell(cell, view);
						setCellSelection(cell, editableOffset, false);
					}

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
					if (moveTableCellCaretVertically(cell, verticalNavigation.direction)) {
						return;
					}

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
				if (isCoveredTableCell(occupancy, { row: 0, column: index })) {
					continue;
				}

				const cell = createCell(
					'th',
					this.data.headers[index] ?? [],
					this.data.headerSources[index],
					{ row: 0, column: index },
				);
				applyCellSpan(cell, occupancy, { row: 0, column: index }, this.data.headerSources[index]?.text ?? '');
				tr.appendChild(cell);
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
					const position = { row: rowIndex + 1, column: index };
					if (isCoveredTableCell(occupancy, position)) {
						continue;
					}

					const cell = createCell(
						'td',
						row[index] ?? [],
						this.data.rowSources[rowIndex]?.[index],
						position,
					);
					applyCellSpan(
						cell,
						occupancy,
						position,
						this.data.rowSources[rowIndex]?.[index]?.text ?? '',
					);
					tr.appendChild(cell);
				}

				tbody.appendChild(tr);
			}

			table.appendChild(tbody);
		}

		wrap.appendChild(table);
		attachTableCellSelection(wrap, table, this.data, view);
		/** 構造ヘッダーの余白切替後にリサイズハンドルを表へ合わせ直す */
		let syncResizeHandles = (): void => undefined;
		if (columnCount > 0) {
			syncResizeHandles = attachTableResize(wrap, table, getTableLayoutKey(this.data.tableFrom, columnCount), {
				layout   : readTableLayout(this.data),
				onPersist: view.state.readOnly
					? undefined
					: (layout, hit) => {
						const activeCell = wrap.ownerDocument.activeElement instanceof HTMLElement
							? wrap.ownerDocument.activeElement.closest<HTMLElement>(
								'[data-table-row][data-table-column]',
							)
							: null;
						const position   = activeCell && table.contains(activeCell)
							? {
								row   : Number(activeCell.dataset.tableRow),
								column: Number(activeCell.dataset.tableColumn),
							}
							: null;
						const caret      = activeCell && position
							? getCellCaretOffset(activeCell)
							: 0;
						const tableFrom  = resolveTableFromForPersist(view, wrap);
						if (tableFrom === null) {
							return;
						}

						if (persistTableLayout(view, tableFrom, layout, hit) && position) {
							restoreTableCellFocus(view, tableFrom, position, caret, false);
						}
					},
			});
		}
		const syncHorizontalOverflow = attachTableHorizontalOverflow(wrap, table);
		attachTableStructureControls(wrap, table, this.data, view, () => {
			syncResizeHandles();
			syncHorizontalOverflow();
		});

		return wrap;
	}

	/**
	 * 行数に応じた推定高さ（ビューポート計測の安定化）
	 * @returns 行数に応じた推定高さ（ビューポート計測の安定化）
	 */
	get estimatedHeight(): number {
		const rowCount = this.data.headers.length > 0
			? 1 + this.data.rows.length
			: this.data.rows.length;
		return Math.max(1, rowCount) * 42 + 40;
	}

	/**
	 * @returns 同一なら true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * テーブル全体をウィジェットへ置換する Decoration を追加する
 * （複数行 replace はインライン。`block: true` は使わない）
 * @param entries - エントリ配列
 * @param from - 開始位置
 * @param to - 終了位置
 * @param data - テーブルデータ
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
