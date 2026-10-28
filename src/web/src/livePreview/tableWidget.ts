/**
 * ライブプレビューの Markdown 表をウィジェットで描き、セル編集とメニュー操作の文書変更を組み立てる
 * 折りたたみや画像幅の記憶は対応するモジュールが持ち、このファイルは表の表示と編集の境界を持つ
 * @file
 */
import { redo, undo } from '@codemirror/commands';
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, Transaction, type ChangeSet, type EditorState } from '@codemirror/state';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { applySanitizedAttributes, isBreakHtmlTag, parseHtmlTag, sanitizeHtmlAttributes, type SanitizedHtmlAttributes } from './htmlSanitizer';
import { appendHighlightedCodeText, appendHighlightedInlineCode } from '../editor/codeHighlight';
import { collectInlineCodeContentRanges, getCodeLanguageGeneration, parseInlineCodeLanguagePrefix, requestCodeLanguage, resolveCodeLanguage } from '../editor/codeLanguage';
import { documentContextFacet } from './documentContext';
import { ImageWidget, bindImageResizePersister, bindImageWrapEditorView, classifyImageSource, getImageWrapPath, type ImageSpec } from './imageWidget';
import { splitImageAlt, splitWikiEmbedTarget } from './imageSize';
import { splitWikiLinkAlias } from './wikiLink';
import type { DecorationEntry } from './inlineDecorations';
import { forgetCellImageWidth, recallCellImageWidth, rememberCellImageWidth } from './cellImageWidthMemory';
import { applyImageDisplayWidth, applyImageWidthByPath, applyImageWidthOnDocumentLine, replaceImageWidthInCellText } from './imageResize';
import { attachTableHorizontalOverflow, attachTableResize, collectTableCellBoxes, computeColumnRightEdges, forgetTableLayout, getTableLayoutKey, rememberTableScroll, resolveTableRelativeOffset, type TableLayout, type TableResizeHit } from './tableResize';
import { buildAlignTableCellsChanges, buildMergeTableCellsChanges, buildTableLayoutChange, buildTableOccupancy, buildUnmergeTableCellsChanges, cellAlignmentClassNames, describeTableCellSelection, formatCellSpan, getTableMergeActionState, getVisibleAdjacentTableCellPosition, isCoveredTableCell, isMultiCellTableSelectionRect, normalizeTableSelectionRect, parseCellSpan, readTableLayout, resolveTableMergeRect, stripCellSpanFromNodes, type TableAlignPatch, type TableMergeActionState, type TableSelectionRect, type TableSizeLayout } from './tableMerge';
import { buildTableStructureChange, buildTableStructureGroups, getTableStructureActionState, resolveTableStructureContextSelection, shouldHideTableStructureControls, structureSelectionAfterAction, type TableStructureAction, type TableStructureAxis, type TableStructureRange, type TableStructureSelection } from './tableStructure';

export { clearCellImageWidths, forgetCellImageWidth, recallCellImageWidth, rememberCellImageWidth } from './cellImageWidthMemory';

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
	// 直前に続くバックスラッシュの数。奇数ならこの `|` はエスケープ
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
function trimCellRange(text: string, from: number, to: number, lineFrom: number): TableCellRange {
	// 空白を除いた開始。行内の位置
	let start = from;
	// 空白を除いた終端。行内の位置
	let end   = to;

	while (start < end && /\s/.test(text[start]!)) {
		start += 1;
	}

	while (end > start && /\s/.test(text[end - 1]!)) {
		end -= 1;
	}

	return {
		// 文書上のセル開始。行頭からのずれを足す
		from: lineFrom + start,
		// 文書上のセル終端。行頭からのずれを足す
		to: lineFrom + end
	};
}

/**
 * Markdown テーブル行の `|` 区切りから、空セルを含む列範囲を復元する
 * @param state - エディタ状態
 * @param rowNode - TableHeader / TableRow ノード
 * @returns Markdown テーブル行の `|` 区切りから、空セルを含む列範囲を復元する
 */
function extractCellRangesFromRowLine(state: EditorState, rowNode: SyntaxNode): TableCellRange[] {
	// 行ノードが属する行。区切りはここのテキストを見る
	const line                  = state.doc.lineAt(rowNode.from);
	// エスケープされていない `|` の行内位置。無ければ空
	const pipeIndexes: number[] = [];

	for (let index = 0; index < line.text.length; index += 1) {
		// エスケープされていない `|` だけ区切りに数える
		if (line.text[index] === '|' && !isEscapedPipe(line.text, index)) {
			pipeIndexes.push(index);
		}
	}

	// `|` が無い行は、行ノード全体を 1 セルにする
	if (pipeIndexes.length === 0) {
		return [trimCellRange(line.text, rowNode.from - line.from, rowNode.to - line.from, line.from)];
	}

	// 区切りから切り出したセル範囲。空セルも含む
	const ranges: TableCellRange[] = [];
	// 次のセルの開始。行頭が `|` ならその次から
	let segmentStart               = pipeIndexes[0] === 0 ? 1 : 0;
	for (const pipeIndex of pipeIndexes) {
		// 区切りがセル開始以上のときだけ、その手前までを 1 セルにする
		if (pipeIndex >= segmentStart) {
			ranges.push(trimCellRange(line.text, segmentStart, pipeIndex, line.from));
		}

		segmentStart = pipeIndex + 1;
	}

	// 末尾の `|` が無い、または最後の区切りの後に文字があるとき、残りのセルを足す。どちらか一方でも足す
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
	// 行直下のセルノード。区切りや空白は含めない
	const cells: SyntaxNode[] = [];
	for (let cell = rowNode.firstChild; cell; cell = cell.nextSibling) {
		// TableCell だけをセル一覧に入れる
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
function findCellNodeForRange(cells: SyntaxNode[], used: Set<SyntaxNode>, range: TableCellRange): SyntaxNode | null {
	for (const cell of cells) {
		// すでに別の範囲へ割り当てたノードは再利用しない
		if (used.has(cell)) {
			continue;
		}

		// 範囲の内側に収まる最初の未使用セルを、その範囲のノードにする。どちらか一方がはみ出しても次へ進む
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
	['WikiLink', 'wikilink']
]);

/**
 * Markdownソース位置を、HTML改行タグを1文字へ畳み込んだ編集文字列上の位置へ変換する
 * @param position - Markdownソース上の絶対位置
 * @param cellRange - セル範囲
 * @param breakRanges - HTML改行タグ範囲
 * @returns 変換後のMarkdownソース位置を、HTML改行タグを1文字へ畳み込んだ編集文字列上の位置
 */
function toEditableCellOffset(position: number, cellRange: TableCellRange, breakRanges: TableCellRange[]): number {
	// セル先頭からの素のずれ。改行タグの畳み込み前
	let offset = position - cellRange.from;
	for (const breakRange of breakRanges) {
		// この位置より後ろの改行タグは、まだ畳み込まない
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
	// この要素自身の記法トークン。入れ子のマーカーは含めない
	const ranges: TableCellRange[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) {
		// マーカー、URL、タイトルだけを隠す範囲にする
		if (child.name.endsWith('Mark') || child.name === 'URL' || child.name === 'LinkTitle') {
			// 記法トークンの文書範囲
			ranges.push({
				// トークンの開始
				from: child.from,
				// トークンの終端
				to: child.to
			});
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
		// ページ名が空の子はエイリアスを分けない
		if (child.name !== 'WikiLinkPage' || child.from >= child.to) {
			continue;
		}

		// パスとエイリアスの分割。区切りが無ければ alias は空
		const split = splitWikiLinkAlias(state.doc.sliceString(child.from, child.to));
		// エイリアスが無い、または隠す長さが 0 のときは範囲を作らない。どちらか一方でも null
		if (!split.alias || split.hideLength <= 0) {
			return null;
		}

		// パスと区切りだけを隠す範囲。エイリアスは残す
		return {
			// ページ名の開始
			from: child.from,
			// 隠す長さの終端
			to: child.from + split.hideLength
		};
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
		// ページ名が空の子は表示ノードを作らない
		if (child.name !== 'WikiLinkPage' || child.from >= child.to) {
			continue;
		}

		// ページ名の原文。エイリアス区切りを含むことがある
		const raw   = state.doc.sliceString(child.from, child.to);
		// パスとエイリアス。区切りが無ければ alias は null
		const split = splitWikiLinkAlias(raw);
		// 表示する文字。エイリアスが無ければ原文
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
function extractInlineCodeLanguagePrefixRange(state: EditorState, node: SyntaxNode): { from: number; to: number; language: string } | null {
	// コード本文の範囲。空のコードは undefined
	const contentRange = collectInlineCodeContentRanges(node)[0];
	// 本文が無いコードは言語接頭辞も無い
	if (!contentRange) {
		return null;
	}

	// コード本文。先頭の `{java}` を含むことがある
	const content = state.doc.sliceString(contentRange.from, contentRange.to);
	// 言語接頭辞。形が違えば null
	const prefix  = parseInlineCodeLanguagePrefix(content);
	// 接頭辞が無い、または知らない言語のときは隠さない。どちらか一方でも null
	if (!prefix || !resolveCodeLanguage(prefix.language)) {
		return null;
	}

	// 隠す接頭辞と、ハイライトに使う言語名
	return {
		// 接頭辞の開始。本文の先頭
		from: contentRange.from,
		// 接頭辞の終端。直後の空白を含む
		to: contentRange.from + prefix.prefixLength,
		// 解決できた言語名
		language: prefix.language
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
function extractEditableCellData(state: EditorState, range: TableCellRange, cellNode: SyntaxNode | null): EditableCellData {
	// 対応するセルノードが無い範囲は、原文をそのまま編集文字列にする
	if (!cellNode) {
		// 装飾の無い編集データ
		return {
			// セル原文。改行タグは畳まない
			text: state.doc.sliceString(range.from, range.to),
			// インライン範囲は無い
			inlineRanges: []
		};
	}

	// HTML 改行タグの文書範囲。コード内の `<br>` は含めない
	const breakRanges: TableCellRange[] = [];
	cellNode.cursor().iterate((ref: SyntaxNodeRef) => {
		// HTML タグ以外は改行の畳み込み対象にしない
		if (ref.name !== 'HTMLTag') {
			return;
		}

		// タグの原文。改行タグかどうかを見る
		const raw = state.doc.sliceString(ref.from, ref.to);
		// 改行タグだけ、編集文字列では 1 文字の改行に畳む
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

	// 編集文字列上のインライン範囲。該当が無ければ空
	const inlineRanges: TableCellInlineRange[] = [];
	cellNode.cursor().iterate((ref: SyntaxNodeRef) => {
		// セル内インラインとして扱う種類。表に無ければ undefined
		const kind = TABLE_CELL_INLINE_KINDS.get(ref.name);
		// 対象外のノードは装飾範囲にしない
		if (!kind) {
			return;
		}

		// この要素自身の記法トークン。編集文字列上の位置は後で直す
		const markRanges = collectOwnedInlineMarkRanges(ref.node);
		// Wiki リンクだけ、パスと区切りも隠す範囲へ足す
		if (kind === 'wikilink') {
			const aliasHide = wikiLinkAliasHideRange(state, ref.node);
			if (aliasHide) {
				markRanges.push(aliasHide);
			}
		}

		// コードの言語接頭辞。無ければ undefined
		let codeLanguage: string | undefined;
		// インラインコードだけ、既知言語の接頭辞を隠す
		if (kind === 'code') {
			const languagePrefix = extractInlineCodeLanguagePrefixRange(state, ref.node);
			// 既知言語の接頭辞があるときだけ、隠し範囲と言語名を覚える
			if (languagePrefix) {
				markRanges.push({ from: languagePrefix.from, to: languagePrefix.to });
				codeLanguage = languagePrefix.language;
			}
		}

		inlineRanges.push({
			id: 0,
			kind,
			from: toEditableCellOffset(ref.from, range, breakRanges),
			to: toEditableCellOffset(ref.to, range, breakRanges),
			codeLanguage,
			markRanges: markRanges.map((markRange) => ({
				from: toEditableCellOffset(markRange.from, range, breakRanges),
				to: toEditableCellOffset(markRange.to, range, breakRanges)
			}))
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
	// `|` 区切りから復元したセル範囲。空セルを含む
	const ranges                   = extractCellRangesFromRowLine(state, rowNode);
	// 行直下のセルノード
	const cells                    = collectTableCellNodes(rowNode);
	// 範囲へ割り当て済みのノード。空セルには使わない
	const used                     = new Set<SyntaxNode>();
	// 範囲ごとに割り当てたセルノード。空範囲は null
	const matchedCells             = ranges.map((range) => {
		// 空範囲はノードを持たない空セルにする
		if (range.from >= range.to) {
			return null;
		}

		return findCellNodeForRange(cells, used, range);
	});
	// 範囲ごとの表示ノード。画像だけのセルは画像ノード 1 つ
	const nodes: TableCellNode[][] = ranges.map((range, index) => {
		// セル全体が画像 1 つのときの画像ノード。無ければ null
		const soleImage = extractSoleTableCellImage(state, range);
		// 画像だけなら他のインラインは展開しない
		if (soleImage) {
			return [soleImage];
		}

		// この範囲に割り当てたセルノード。空セルは null
		const cell = matchedCells[index] ?? null;
		// ノードがあるセルは構文木から表示ノードを取る
		if (cell) {
			return extractTableCellNodes(state, cell);
		}

		// ノードが無い範囲のソース。空文字なら空セル
		const raw = state.doc.sliceString(range.from, range.to);
		// ソースがあるときだけテキストノードにする。空文字は空配列
		return raw
			? [
				{
					// プレーンテキスト
					kind: 'text',
					// セル範囲のソース
					text: raw
				}
			]
			: [];
	});
	// 範囲、ソース、編集用本文、インライン範囲
	const sources = ranges.map((range, index) => {
		// 編集用テキストとインライン範囲
		const editable = extractEditableCellData(state, range, matchedCells[index] ?? null);
		// セル範囲のソース。結合属性を含む
		const raw      = state.doc.sliceString(range.from, range.to);
		// 結合と配置を外した本文
		const span     = parseCellSpan(editable.text);
		// 範囲に本文とインライン範囲を足したセルソース
		return {
			...range,
			// ソース原文。結合属性を含む
			text: raw,
			// 結合属性を除いた本文
			editableText: span.text,
			// 本文の長さより手前のインライン範囲。属性部分は捨てる
			inlineRanges: editable.inlineRanges.filter((item) => item.from < span.text.length)
		};
	});
	// 表示ノードとセルソース。結合属性は表示ノードから外す
	return {
		// 結合属性を外したセルの表示ノード
		nodes: nodes.map((cellNodes, index) => stripCellSpanFromNodes(cellNodes, sources[index]?.text ?? '')),
		// 範囲と本文とインライン範囲
		sources
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
function pushHtmlOpen(current: TableCellNode[], stack: HtmlStackFrame[], tagName: string, attributes: SanitizedHtmlAttributes): TableCellNode[] {
	// 開いたタグの表示ノード。子はこの配列へ足していく
	const node: TableCellNode = {
		// HTML 要素
		kind: 'html',
		// 小文字のタグ名
		tagName,
		// 許可した属性だけ
		attributes,
		// 閉じタグまでの子。開始時は空
		children: []
	};
	current.push(node);
	// 閉じタグで戻るための枠。子配列は node.children と同じ
	stack.push({
		// 閉じる対象のタグ名
		tagName,
		// 開タグと同じ属性
		attributes,
		// 子を足す配列。node.children と同じ参照
		children: node.children
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
function closeHtmlTag(stack: HtmlStackFrame[], tagName: string, root: TableCellNode[]): TableCellNode[] {
	// 一致した開タグの位置。見つからなければ -1
	let openIndex = -1;
	for (let index = stack.length - 1; index >= 0; index -= 1) {
		// 同じタグ名の開タグ。内側から探す
		if (stack[index]!.tagName === tagName) {
			openIndex = index;
			break;
		}
	}

	// 対応する開タグが無いので、いまの階層のまま返す
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
	// セル直下の表示ノード。HTML の外に残った子
	const root: TableCellNode[]       = [];
	// 開きっぱなしの HTML。内側が配列の末尾
	const htmlStack: HtmlStackFrame[] = [];
	// いま子を足す配列。開タグで中へ入り、閉タグで戻る
	let current: TableCellNode[]      = root;
	// まだテキストにしていない位置。ノードの手前までを flush する
	let cursor                        = node.from;

	/** 構文ノード間に残る通常テキストを、現在のHTML階層へ追加する */
	const flushText = (to: number): void => {
		// 進んでいない、または戻っている位置にはテキストが無い
		if (to <= cursor) {
			return;
		}

		// ノード間のソース。空文字ならノードは足さない
		const text = state.doc.sliceString(cursor, to);
		// 空白だけの文字列も表示テキストとして残す
		if (text) {
			// 階層へ足すテキストノード
			current.push({
				// プレーンテキスト
				kind: 'text',
				// ノード間のソース
				text
			});
		}

		cursor = to;
	};

	for (let child: SyntaxNode | null = node.firstChild; child; child = child.nextSibling) {
		flushText(child.from);

		// 子ノードの構文名。マークとタグとインラインで分岐する
		const name = child.name;
		// マーク、URL、リンクタイトルのどれかなら本文にしない。どれか一つでカーソルだけ進める
		if (name.endsWith('Mark') || name === 'URL' || name === 'LinkTitle') {
			cursor = child.to;
			continue;
		}

		// HTML タグだけ開閉と改行に分ける
		if (name === 'HTMLTag') {
			// タグのソース。許可判定と表示の両方に使う
			const raw = state.doc.sliceString(child.from, child.to);
			// 改行タグは br ノードにする
			if (isBreakHtmlTag(raw)) {
				current.push({ kind: 'br' });
				cursor = child.to;
				continue;
			}

			// 解析結果。非許可や解析不能は null か allowed が false
			const parsed = parseHtmlTag(raw);
			// 解析できない、または許可されないタグはソースのまま残す。どちらか一方でもテキスト
			if (!parsed || !parsed.allowed) {
				// 非許可タグはソース文字列のまま残す（無効化）
				current.push({
					// プレーンテキスト
					kind: 'text',
					// タグのソース
					text: raw
				});
				cursor = child.to;
				continue;
			}

			// 単独タグは子を持たない
			if (parsed.kind === 'selfClosing') {
				// br だけ改行ノード。他の単独タグは空の HTML ノード
				if (parsed.name === 'br') {
					current.push({ kind: 'br' });
				} else {
					// 子の無い HTML 要素
					current.push({
						// HTML 要素
						kind: 'html',
						// 小文字のタグ名
						tagName: parsed.name,
						// 許可した属性だけ
						attributes: sanitizeHtmlAttributes(parsed.attributes),
						// 単独タグなので子は空
						children: []
					});
				}
				cursor = child.to;
				continue;
			}

			// 開タグは階層を一段深くする
			if (parsed.kind === 'open') {
				current = pushHtmlOpen(current, htmlStack, parsed.name, sanitizeHtmlAttributes(parsed.attributes));
				cursor  = child.to;
				continue;
			}

			// 閉タグは対応する開タグまで階層を戻す
			if (parsed.kind === 'close') {
				current = closeHtmlTag(htmlStack, parsed.name, root);
				cursor  = child.to;
				continue;
			}

			// 開閉のどれでもないタグはソースのまま残す
			current.push({
				// プレーンテキスト
				kind: 'text',
				// タグのソース
				text: raw
			});
			cursor = child.to;
			continue;
		}

		// 斜体は中身を再帰して em にする
		if (name === 'Emphasis') {
			current.push({
				// 斜体
				kind: 'em',
				// マークを除いた中身
				children: extractInlineNodes(state, child)
			});
			cursor = child.to;
			continue;
		}

		// 太字は中身を再帰して strong にする
		if (name === 'StrongEmphasis') {
			current.push({
				// 太字
				kind: 'strong',
				// マークを除いた中身
				children: extractInlineNodes(state, child)
			});
			cursor = child.to;
			continue;
		}

		// 打ち消しは中身を再帰して strike にする
		if (name === 'Strikethrough') {
			current.push({
				// 打ち消し
				kind: 'strike',
				// マークを除いた中身
				children: extractInlineNodes(state, child)
			});
			cursor = child.to;
			continue;
		}

		// ハイライトは中身を再帰して highlight にする
		if (name === 'Highlight') {
			current.push({
				// ハイライト
				kind: 'highlight',
				// マークを除いた中身
				children: extractInlineNodes(state, child)
			});
			cursor = child.to;
			continue;
		}

		// インラインコードは中身を再帰して code にする
		if (name === 'InlineCode') {
			current.push({
				// インラインコード
				kind: 'code',
				// バッククォートを除いた中身
				children: extractInlineNodes(state, child)
			});
			cursor = child.to;
			continue;
		}

		// リンクは URL を取り、表示は中身の再帰
		if (name === 'Link') {
			// リンク先。URL ノードが無ければ空文字
			let href = '';
			child.cursor().iterate((ref: SyntaxNodeRef) => {
				// URL ノードのテキストだけをリンク先にする
				if (ref.name === 'URL') {
					href = state.doc.sliceString(ref.from, ref.to).trim();
				}
			});
			current.push({
				// リンク
				kind: 'link',
				// トリムした URL。無ければ空文字
				href,
				// ラベル側の表示ノード
				children: extractInlineNodes(state, child)
			});
			cursor = child.to;
			continue;
		}

		// Wiki リンクは表示用ノードだけを子にする
		if (name === 'WikiLink') {
			current.push({
				// Wiki リンク
				kind: 'wikilink',
				// エイリアスやパスの表示ノード
				children: wikiLinkDisplayNodes(state, child)
			});
			cursor = child.to;
			continue;
		}

		// Wiki 埋め込みは画像記法のときだけ画像ノードにする
		if (name === 'WikiEmbed') {
			// 埋め込みのソース。`![[` と `]]` の内側がパス
			const raw = state.doc.sliceString(child.from, child.to);
			// 両端が埋め込み記法のときだけ画像にする。どちらかが欠けるとテキストへ落とす
			if (raw.startsWith('![[') && raw.endsWith(']]')) {
				current.push(createTableCellImage(state, child.from, child.to, raw.slice(3, -2), '', true));
				cursor = child.to;
				continue;
			}
		}

		// Markdown 画像は alt と URL を分けて画像ノードにする
		if (name === 'Image') {
			// 画像のソース。`![` から `)` まで
			const raw      = state.doc.sliceString(child.from, child.to);
			// alt の閉じ位置。`](` が無ければ -1
			const closeAlt = raw.indexOf('](');
			// 画像記法の三条件が揃ったときだけ画像にする。どれか一つが欠けても入らない
			if (raw.startsWith('![') && closeAlt >= 0 && raw.endsWith(')')) {
				current.push(createTableCellImage(state, child.from, child.to, raw.slice(closeAlt + 2, -1), raw.slice(2, closeAlt), false));
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

		// 子の無いノードのソース。空文字ならノードは足さない
		const leaf = state.doc.sliceString(child.from, child.to);
		// ソースがある葉だけテキストノードにする
		if (leaf) {
			current.push({
				// プレーンテキスト
				kind: 'text',
				// 葉ノードのソース
				text: leaf
			});
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
	// 表示順の文字列断片。結合前
	const parts: string[] = [];
	/**
	 * @param items - ノード
	 */
	const walk            = (items: TableCellNode[]): void => {
		for (const item of items) {
			// テキストはそのまま断片にする
			if (item.kind === 'text') {
				parts.push(item.text);
				continue;
			}

			// 改行ノードは改行文字にする
			if (item.kind === 'br') {
				parts.push('\n');
				continue;
			}

			// 画像は alt があれば alt、無ければソース
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
	// 見出し行の表示ノード。行が無ければ空
	const headers: TableCellNode[][]       = [];
	// 本体行の表示ノード。行が無ければ空
	const rows: TableCellNode[][][]        = [];
	// 見出しセルのソース。行が無ければ空
	const headerSources: TableCellSource[] = [];
	// 本体行ごとのセルソース。行が無ければ空
	const rowSources: TableCellSource[][]  = [];

	for (let child = tableNode.firstChild; child; child = child.nextSibling) {
		// 見出し行だけ見出し側へ積む
		if (child.name === 'TableHeader') {
			// 空セルを含む見出し行
			const row = extractTableRowData(state, child);
			headers.push(...row.nodes);
			headerSources.push(...row.sources);
			continue;
		}

		// 本体行だけ行配列へ積む。区切り行はどちらにも入らない
		if (child.name === 'TableRow') {
			// 空セルを含む本体行
			const row = extractTableRowData(state, child);
			rows.push(row.nodes);
			rowSources.push(row.sources);
		}
	}

	// 表全体。範囲は Table ノードの開始と終端
	return {
		// 見出し行の表示ノード
		headers,
		// 本体行の表示ノード
		rows,
		// 見出しセルのソース
		headerSources,
		// 本体行のセルソース
		rowSources,
		// 表の開始。文書上の文字位置
		tableFrom: tableNode.from,
		// 表の終端。文書上の文字位置
		tableTo: tableNode.to
	};
}

/**
 * ソースの幅が無ければ、ドラッグ中に覚えた幅を使う
 * @param path - 画像パス
 * @param parsed - ソースの幅
 * @returns ソースの幅が無ければ、ドラッグ中に覚えた幅を使う。無ければ null
 */
function resolveCellImageWidth(path: string, parsed: number | null): number | null {
	// ソースに正の幅があるときは、その幅を記憶して使う
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
	// 結合属性を外してトリムした本文。画像以外なら null
	const trimmed = parseCellSpan(text).text.trim();
	// Wiki 埋め込み全体に一致したときだけパスと幅を持つ
	const wiki    = /^!\[\[([\s\S]*?)\]\]$/.exec(trimmed);
	// Wiki 画像は `![[パス|幅]]` からパスと幅を取る
	if (wiki) {
		// パスとサイズ。パスが空なら画像扱いにしない
		const { path, size } = splitWikiEmbedTarget(wiki[1] ?? '');
		// パスがあるときだけ幅を返す。幅が無ければ null
		return path
			? {
				// 埋め込みのパス
				path,
				// ソースの幅（px）。無ければ null
				width: size.width
			}
			: null;
	}

	// Markdown 画像全体に一致したときだけパスと幅を持つ。不一致は null
	const markdown = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed);
	// Markdown 画像でなければ画像セルではない
	if (!markdown) {
		return null;
	}

	// alt 側のサイズ。幅が無ければ null
	const { size } = splitImageAlt(markdown[1] ?? '');
	// URL 側のパス。空白だけなら空文字
	const path     = (markdown[2] ?? '').trim();
	// パスがあるときだけ幅を返す。空パスは null
	return path
		? {
			// 画像のパス
			path,
			// alt に書いた幅（px）。無ければ null
			width: size.width
		}
		: null;
}

/**
 * ソース編集で幅指定や画像自体を消したら、覚えた幅も消す
 * @param previous - 編集前
 * @param next - 編集後
 */
function forgetCellImageWidthIfSourceDropped(previous: string, next: string, position: TableCellPosition): void {
	// 編集前が画像だけならパスと幅。画像でなければ何もしない
	const prev = parseSoleCellImageRef(previous);
	// 編集前が画像セルでなければ、覚える幅も無い
	if (!prev) {
		return;
	}

	// 編集後が画像だけのときのパスと幅。画像でなければ null
	const after = parseSoleCellImageRef(next);
	// 画像でなくなった、パスが変わった、幅指定が消えた、のどれかなら記憶を消す
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
	// 本文、結合、配置。幅と高さの属性は本文側に残る
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
	// 横配置と縦配置。本文は判定に使わない
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
	// 結合の占有。列数、行数、各マスの結合
	const occupancy = buildTableOccupancy(data);
	// 位置、構造、配置。画像幅は含めない
	return JSON.stringify({
		// 表の開始位置。文書がずれても別の表と区別する
		tableFrom: data.tableFrom,
		// 列数
		columns: occupancy.columnCount,
		// 行数。見出しを含む
		rows: occupancy.rowCount,
		// 各マスの結合。覆われたマスは x
		spans: occupancy.cells.map((row) => row.map((cell) => (cell.covered ? 'x' : `${cell.colspan}x${cell.rowspan}`))),
		// 見出しと本体の配置キー
		aligns: [data.headerSources.map((source) => tableCellAlignmentIdentity(source.text)), ...data.rowSources.map((row) => row.map((source) => tableCellAlignmentIdentity(source.text)))]
	});
}

/**
 * 画像幅の書き戻しでずれたセル位置を、既存ウィジェット側へ反映する
 * @param data - 表データ
 * @param position - 書き換えたセル
 * @param width - 幅
 * @returns 増えた文字数
 */
export function syncTableDataAfterImageWidth(data: TableData, position: TableCellPosition, width: number): number {
	// 書き換えるセルのソース。範囲外なら 0
	const source = getTableCellSource(data, position);
	// セルが無ければ文字数は増えない
	if (!source) {
		return 0;
	}

	// 幅を書き戻したソース。画像が無ければ null
	const next = replaceImageWidthInCellText(source.text, width, true);
	// 書き戻せない、または幅が同じなら位置をずらさない。どちらか一方でも 0
	if (next === null || next === source.text) {
		return 0;
	}

	// 増えた文字数。短くなれば負
	const delta         = next.length - source.text.length;
	// 書き換える前のセル終端。これ以降のセルをずらす
	const oldTo         = source.to;
	// 幅を含むソース
	source.text         = next;
	// 編集用本文も同じソースにする
	source.editableText = next;
	// 新しい終端。開始からの文字数
	source.to           = source.from + next.length;
	data.tableTo       += delta;

	/**
	 * 書き戻し位置より後ろのセル範囲をずらす
	 * @param other - 他セル
	 */
	const shiftSource = (other: TableCellSource): void => {
		// 同じセル、または書き戻しより前のセルは動かさない。どちらか一方でも戻る
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
			// 画像ノードだけソース範囲と幅をずらす
			if (node.kind === 'image') {
				// 終端が書き戻し以降なら、増分だけ終端をずらす
				if (node.spec.sourceTo !== undefined && node.spec.sourceTo >= oldTo) {
					node.spec.sourceTo += delta;
				}

				// 開始が書き戻し以降なら、増分だけ開始をずらす。どちらかが欠けると動かさない
				if (node.spec.sourceFrom !== undefined && node.spec.sourceFrom >= oldTo) {
					node.spec.sourceFrom += delta;
				}

				// 開始が書き戻しより前の画像だけ、表示幅を新しい幅にする
				if (node.spec.sourceFrom !== undefined && node.spec.sourceFrom < oldTo) {
					node.spec.width  = width;
					node.spec.height = null;
				}
			}

			// 子を持つノードは中も同じだけずらす
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
	// 文書内に収めた位置
	const clamped                = Math.max(0, Math.min(pos, state.doc.length));
	// 位置を含む表。無ければ null
	let found: SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * @param ref - ノード
		 * @returns 子の走査を止めるとき false。続けるときは値を返さない
		 */
		enter(ref) {
			// 表以外は子を探し続ける
			if (ref.name !== 'Table') {
				return;
			}

			// 表の開始ちょうど、または表の内側。終端は含まない。どちらか一方でもこの表
			if (ref.from === clamped || (ref.from <= clamped && clamped < ref.to)) {
				found = ref.node;
				return false;
			}

			// 位置より後ろの表は、次の表なので拾わない
			if (ref.from > clamped) {
				return false;
			}
		}
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
		// DOM 上の表開始。エディタ外なら例外
		const fromDom   = view.posAtDOM(wrap);
		// 整数の位置を含む表。位置が整数でなければ null
		const tableNode = Number.isInteger(fromDom) ? findTableNodeAt(view.state, fromDom) : null;
		// DOM から表が見つかったときだけ、その開始を書き戻し先にする
		if (tableNode) {
			return tableNode.from;
		}
	} catch {
		// wrap が editor 外のときは dataset へ倒す
	}

	// dataset に残した表開始。整数でなければ使えない
	const fromData = Number(wrap.dataset.tableFrom);
	// 整数でない dataset は書き戻し先にしない
	if (!Number.isInteger(fromData)) {
		return null;
	}

	// dataset の位置を含む表。再利用でずれていれば null
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
export function getCurrentTableCellNodes(state: EditorState, tableFrom: number, position: TableCellPosition): TableCellNode[] | null {
	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(state, tableFrom);
	// 表が無いセルは表示ノードを返せない
	if (!tableNode) {
		return null;
	}

	// いまの文書から取り直した表
	const data = extractTableData(state, tableNode);
	// 見出し行は headers。列が無ければ null
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
		// 画像ノードの表示幅を新しい幅にし、高さはソースに持たせない
		if (node.kind === 'image') {
			node.spec.width  = width;
			node.spec.height = null;
		}

		// 子を持つノードは中の画像も同じ幅にする
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
	// セル直下の要素。テキストノードは数えない
	const children = [...cell.children];
	return children.length === 1 && children[0]!.classList.contains('cm-md-image-wrap');
}

/**
 * セル内の画像へ、ソースまたは記憶した幅を適用する
 * @param cell - セル
 * @param nodes - セル AST
 * @param position - セル位置
 */
function applyRememberedWidthToCell(cell: HTMLElement, nodes: TableCellNode[], position: TableCellPosition): void {
	// セル内の画像ラッパー。画像が無ければ null
	const wrap = cell.querySelector<HTMLElement>('.cm-md-image-wrap');
	// 表示中の img。ラッパーが無ければ null
	const img  = cell.querySelector<HTMLImageElement>('.cm-md-image');
	// ラッパーか img が無ければ幅を当てない。どちらか一方でも戻る
	if (!wrap || !img) {
		return;
	}

	// ラッパーが持つ画像パス
	const path  = getImageWrapPath(wrap);
	// このセルで覚えた幅（px）。無ければ 0 扱いで当てない
	const width = recallCellImageWidth(path, position);
	// 覚えた幅が無いセルはソースの表示のままにする
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
export function applyTableCellImageWidth(view: EditorView, cell: HTMLElement, width: number): boolean {
	// セルが属する表ラッパー。表の外なら null
	const wrap      = cell.closest<HTMLElement>('.cm-md-table-wrap');
	// セル内の画像ラッパー。画像が無ければ null
	const imageWrap = cell.querySelector<HTMLElement>('.cm-md-image-wrap');
	// セルの行番号。dataset が無ければ NaN
	const row       = Number(cell.dataset.tableRow);
	// セルの列番号。dataset が無ければ NaN
	const column    = Number(cell.dataset.tableColumn);
	// 画像か表のソース位置。どちらも無ければ NaN
	const hint      = Number(imageWrap?.dataset.sourceFrom ?? wrap?.dataset.tableFrom);
	// 行、列、位置のどれかが整数でないと書き戻せない。どれか一つが欠けても false
	if (!Number.isInteger(row) || !Number.isInteger(column) || !Number.isFinite(hint)) {
		return false;
	}

	// 行全体の画像幅を先に書けたときは、セルの dataset だけ合わせる
	if (applyImageWidthOnDocumentLine(view, hint, width)) {
		// セルソースへ幅を入れた文字列。画像が無ければ空文字
		const next = replaceImageWidthInCellText(cell.dataset.source ?? '', width, true);
		// 書き戻し文字列があるときだけ dataset を更新する
		if (next) {
			cell.dataset.source       = next;
			cell.dataset.editableText = next;
		}

		return true;
	}

	// ヒント位置を含む表。無ければ false
	const tableNode = findTableNodeAt(view.state, hint);
	// 表が見つからないセルは文書を変えない
	if (!tableNode) {
		return false;
	}

	// 表から取り直したセル
	const data   = extractTableData(view.state, tableNode);
	// 行と列に対応するソース。範囲外は null
	const source = getTableCellSource(data, { row, column });
	// セルソースが無ければ書き戻せない
	if (!source) {
		return false;
	}

	// 幅を入れたセルソース。画像が無ければ null
	const insert = replaceImageWidthInCellText(source.text, width, true);
	// 書き戻せない、または幅が同じなら文書を変えない。どちらか一方でも false
	if (insert === null || insert === source.text) {
		return false;
	}

	// セル範囲だけを置き換える入力
	view.dispatch({
		// セル範囲を新しいソースで置き換える
		changes: {
			// セルの開始
			from: source.from,
			// セルの終端
			to: source.to,
			// 幅を含むソース
			insert
		},
		// 画像リサイズとして履歴に残す
		userEvent: 'input.imageResize'
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
export function writeTableCellImageWidth(view: EditorView, data: TableData, position: TableCellPosition, imageWrap: HTMLElement, nodes: TableCellNode[], width: number): boolean {
	// ラッパーか AST から取る画像パス。どちらも空なら空文字
	const path = getImageWrapPath(imageWrap) || findTableCellImagePath(nodes);
	// 画像ソースの開始。dataset が無ければ NaN
	const hint = Number(imageWrap.dataset.sourceFrom);
	// 画像ソースの終端。dataset が無ければ NaN
	const end  = Number(imageWrap.dataset.sourceTo);
	// 幅を dataset へ書くセル。行属性が無ければ null
	const cell = imageWrap.closest<HTMLElement>('[data-table-row]');
	rememberCellImageWidth(path, width, position);

	// パス、セル範囲、行、セル、表示幅の順で書けたとき true。どれか一つで足りる
	const wrote = (Boolean(path) && applyImageWidthByPath(view, path, width, Number.isFinite(hint) ? hint : undefined)) || writeExactTableCellImageWidth(view, data, position, width) || (Number.isFinite(hint) && applyImageWidthOnDocumentLine(view, hint, width)) || Boolean(cell && applyTableCellImageWidth(view, cell, width)) || (Number.isFinite(hint) && applyImageDisplayWidth(view, hint, width, Number.isFinite(end) ? end : undefined));
	// どの書き戻しも成功しなければ DOM の終端も動かさない
	if (!wrote) {
		return false;
	}

	// ソースが増えた文字数。変わらなければ 0
	const delta = syncTableDataAfterImageWidth(data, position, width);
	updateImageNodeWidths(nodes, width);
	// 文字数が変わり、終端 dataset があるときだけ終端をずらす。どちらかが欠けると動かさない
	if (delta !== 0 && imageWrap.dataset.sourceTo) {
		// dataset の終端。数値でなければずらさない
		const currentTo = Number(imageWrap.dataset.sourceTo);
		// 数値の終端だけ増分を足す
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
		// 画像ノードのパスをそのまま返す
		if (node.kind === 'image') {
			return node.spec.raw;
		}

		// 子を持つノードは中の画像を先に探す
		if ('children' in node) {
			// 子の中で見つかったパス。無ければ空文字
			const nested = findTableCellImagePath(node.children);
			// 空文字でないパスだけを返す
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
function writeExactTableCellImageWidth(view: EditorView, data: TableData, position: TableCellPosition, width: number): boolean {
	// 位置に対応するセルソース。範囲外は null
	const source = getTableCellSource(data, position);
	// セルが無ければ幅を書けない
	if (!source) {
		return false;
	}

	// 幅を入れたソース。画像が無ければ null
	const insert = replaceImageWidthInCellText(source.text, width, true);
	// 書き戻せない、または幅が同じなら文書を変えない。どちらか一方でも false
	if (insert === null || insert === source.text) {
		return false;
	}

	// 文書末を超えない終端
	const liveTo = Math.min(source.to, view.state.doc.length);
	// いまの文書の同じ範囲。表データとずれていれば書き込まない
	const live   = view.state.sliceDoc(source.from, liveTo);
	// 文書と表データのソースが違う範囲は上書きしない
	if (live !== source.text) {
		return false;
	}

	// 一致したセル範囲だけを置き換える入力
	view.dispatch({
		// セル範囲を新しいソースで置き換える
		changes: {
			// セルの開始
			from: source.from,
			// セルの終端
			to: source.to,
			// 幅を含むソース
			insert
		},
		// 画像リサイズとして履歴に残す
		userEvent: 'input.imageResize'
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
		// テキストはそのままテキストノードにする
		if (node.kind === 'text') {
			parent.appendChild(document.createTextNode(node.text));
			continue;
		}

		// 改行ノードは br 要素にする
		if (node.kind === 'br') {
			parent.appendChild(document.createElement('br'));
			continue;
		}

		// HTML はタグ名の要素にし、子を再帰する
		if (node.kind === 'html') {
			// 許可済みタグ名の要素
			const el = document.createElement(node.tagName);
			applySanitizedAttributes(el, node.attributes);
			el.classList.add('cm-md-html', `cm-md-html-${node.tagName}`);
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		// 斜体は em 要素にする
		if (node.kind === 'em') {
			// 斜体の要素
			const el     = document.createElement('em');
			el.className = 'cm-md-em';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		// 太字は strong 要素にする
		if (node.kind === 'strong') {
			// 太字の要素
			const el     = document.createElement('strong');
			el.className = 'cm-md-strong';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		// 打ち消しは span にする
		if (node.kind === 'strike') {
			// 打ち消しの要素
			const el     = document.createElement('span');
			el.className = 'cm-md-strike';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		// ハイライトは mark 要素にする
		if (node.kind === 'highlight') {
			// ハイライトの要素
			const el     = document.createElement('mark');
			el.className = 'cm-md-highlight';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		// インラインコードは code 要素にし、中身はハイライト済みテキスト
		if (node.kind === 'code') {
			// インラインコードの要素
			const el     = document.createElement('code');
			el.className = 'cm-md-code';
			appendHighlightedInlineCode(el, flattenTableCellText(node.children));
			parent.appendChild(el);
			continue;
		}

		// リンクは span にし、href があるときだけ dataset を付ける
		if (node.kind === 'link') {
			// リンク表示の要素。実リンクにはしない
			const el     = document.createElement('span');
			el.className = 'cm-md-link';
			// href があるリンクだけクリック先を dataset に残す
			if (node.href) {
				el.dataset.href = node.href;
			}

			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		// Wiki リンクは span にする
		if (node.kind === 'wikilink') {
			// Wiki リンク表示の要素
			const el     = document.createElement('span');
			el.className = 'cm-md-wikilink';
			appendTableCellNodes(el, node.children, view);
			parent.appendChild(el);
			continue;
		}

		// 画像はウィジェットの DOM をそのまま足す
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
	// 結合属性を外したセル本文
	const raw   = parseCellSpan(state.doc.sliceString(range.from, range.to)).text;
	// 前後の空白を除いて画像記法だけに一致したとき。不一致は null
	const match = /^(\s*)(!\[\[[\s\S]*?\]\]|!\[[^\]]*\]\([^)]+\))(\s*)$/.exec(raw);
	// 画像記法だけではないセルは通常のインライン展開へ返す
	if (!match) {
		return null;
	}

	// 前空白を除いた画像記法の開始
	const markupFrom = range.from + (match[1]?.length ?? 0);
	// 画像記法そのもの。Wiki か Markdown
	const markup     = match[2] ?? '';
	// 両端が Wiki 埋め込みのときだけ Wiki 画像にする。どちらかが欠けると Markdown 側を見る
	if (markup.startsWith('![[') && markup.endsWith(']]')) {
		return createTableCellImage(state, markupFrom, markupFrom + markup.length, markup.slice(3, -2), '', true);
	}

	// alt の閉じ位置。`](` が無ければ -1
	const closeAlt = markup.indexOf('](');
	// Markdown 画像の三条件のどれかが欠けると画像にしない
	if (!markup.startsWith('![') || closeAlt < 0 || !markup.endsWith(')')) {
		return null;
	}

	return createTableCellImage(state, markupFrom, markupFrom + markup.length, markup.slice(closeAlt + 2, -1), markup.slice(2, closeAlt), false);
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
function createTableCellImage(state: EditorState, from: number, to: number, raw: string, alt: string, embed: boolean): TableCellNode {
	// 文書のパスとリモート画像の読み込み可否
	const context = state.facet(documentContextFacet);
	// Wiki 埋め込みはパスを alt と raw の両方に使う
	if (embed) {
		// パスとサイズ。幅や高さが無ければ null
		const { path, size }  = splitWikiEmbedTarget(raw);
		// 埋め込み画像の表示指定
		const spec: ImageSpec = {
			// パスを alt の代わりに出す
			alt: path,
			// 幅指定を除いたパス
			raw: path,
			// Wiki 埋め込み
			kind: 'embed',
			// 文書のパス。未保存なら null
			documentPath: context.filePath,
			// リモート画像を読むか
			loadRemoteImages: context.loadRemoteImages,
			// ソースか記憶の幅（px）。無ければ null
			width: resolveCellImageWidth(path, size.width),
			// ソースの高さ（px）。無ければ null
			height: size.height,
			// 記法の開始
			sourceFrom: from,
			// 記法の終端
			sourceTo: to
		};
		// 画像ノード。子は持たない
		return {
			// 画像
			kind: 'image',
			// 埋め込みの表示指定
			spec
		};
	}

	// alt 本文とサイズ。幅や高さが無ければ null
	const { alt: altText, size } = splitImageAlt(alt);
	// Markdown 画像の表示指定
	const spec: ImageSpec        = {
		// サイズ指定を除いた alt
		alt: altText,
		// URL またはパス
		raw,
		// ローカル、リモート、data のどれか
		kind: classifyImageSource(raw),
		// 文書のパス。未保存なら null
		documentPath: context.filePath,
		// リモート画像を読むか
		loadRemoteImages: context.loadRemoteImages,
		// ソースか記憶の幅（px）。無ければ null
		width: resolveCellImageWidth(raw, size.width),
		// ソースの高さ（px）。無ければ null
		height: size.height,
		// 記法の開始
		sourceFrom: from,
		// 記法の終端
		sourceTo: to
	};
	// 画像ノード。子は持たない
	return {
		// 画像
		kind: 'image',
		// Markdown 画像の表示指定
		spec
	};
}

/**
 * 空のプレビューセルに、行の高さを残す印が要るか
 * 文字も画像も改行も無いセルは、行高が潰れてクリックできない
 * @param nodes - セル AST
 * @returns 高さ用の印を付けるとき true
 */
export function tableCellNeedsHeightBreak(nodes: TableCellNode[]): boolean {
	// 空白以外の文字、または文字以外のノードがあれば、中身が行の高さを作る
	return !nodes.some((node) => node.kind !== 'text' || node.text.trim() !== '');
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
	// 空セルはクラスで行高を残す。br を置くと、クリア時にソースの改行として残る
	cell.classList.toggle('cm-md-table-cell-empty', tableCellNeedsHeightBreak(nodes));
}

/**
 * 表の最大列数を返す
 * @param data - 表データ
 * @returns 表の最大列数
 */
export function getTableColumnCount(data: TableData): number {
	return Math.max(data.headerSources.length, ...data.rowSources.map((row) => row.length), 0);
}

/**
 * 表示上の行番号（ヘッダ=0）からセルソースを返す
 * @param data - 表データ
 * @param position - セル位置
 * @returns 表示上の行番号（ヘッダ=0）からセルソース
 */
export function getTableCellSource(data: TableData, position: TableCellPosition): TableCellSource | null {
	// 見出し行は headerSources。列が無ければ null
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
export function syncTableCellEditorSelection(view: EditorView, data: TableData, position: TableCellPosition): boolean {
	// セルのソース範囲。範囲外は null
	const source = getTableCellSource(data, position);
	// セルが無ければ選択を動かせない
	if (!source) {
		return false;
	}

	// 文書末を超えないセル開始
	const target = Math.min(source.from, view.state.doc.length);
	// すでにその位置へカーソルがあるときは再選択しない
	if (view.state.selection.main.anchor === target && view.state.selection.main.head === target) {
		return true;
	}

	// セル開始へカーソルを置く選択
	view.dispatch({
		// セル開始のカーソル
		selection: EditorSelection.cursor(target),
		// クリック由来の選択
		userEvent: 'select.pointer'
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
export function getTableVerticalEntryTarget(state: EditorState, from: number, to: number, forward: boolean): TableVerticalEntryTarget | null {
	// 下方向か文書先頭なら to、上方向なら to の直前。表の内側を解決する位置
	const resolvePosition       = forward || to === 0 ? to : to - 1;
	// その位置の最も内側のノード。表でなければ親を辿る
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(resolvePosition, forward ? 1 : -1);
	while (node && node.name !== 'Table') {
		node = node.parent;
	}

	// 表まで辿れなければ、表への進入ではない
	if (!node) {
		return null;
	}

	// 下方向は表の前から、上方向は表の終端以降から入ったときだけ true
	const enteredFromOutside = forward ? from < node.from : from >= node.to;
	// すでに表の中にいる移動はセルフォーカスへ切り替えない
	if (!enteredFromOutside) {
		return null;
	}

	// 進入先の表
	const data     = extractTableData(state, node);
	// 下からは見出しの先頭列、上からは最終行の先頭列
	const position = {
		// 見出しは 0、上から入るときは本体行数
		row: forward ? 0 : data.rowSources.length,
		// 先頭列
		column: 0
	};
	// 進入先セルのソース。列が無ければ null
	const source   = getTableCellSource(data, position);
	// セルが無ければフォーカス先を作らない
	if (!source) {
		return null;
	}

	// 表の開始、セル位置、ソース開始
	return {
		// 表の開始。文書上の文字位置
		tableFrom: data.tableFrom,
		// 入るセルの行と列
		position,
		// セルソースの開始
		sourceFrom: source.from
	};
}

/**
 * 指定位置のテーブルウィジェットが現在のビューへ描画されているか返す
 * @param view - エディタビュー
 * @param tableFrom - 表開始位置
 * @returns 描画済みなら true
 */
export function hasRenderedTableWidget(view: EditorView, tableFrom: number): boolean {
	return view.dom.querySelector(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`) !== null;
}

/** 末尾改行を表示するためのゼロ幅文字。ソースには書かない */
export const TABLE_CELL_BREAK_CARET = '\u200B';

/**
 * 編集用 DOM から読んだ文字列を、ソースへ書く前の改行表現へ整える
 * @param value - 入力値
 * @returns 編集用 DOM から読んだ文字列を、ソースへ書く前の改行表現へ整える
 */
export function normalizeEditableCellDomText(value: string): string {
	return value.replaceAll(TABLE_CELL_BREAK_CARET, '').replaceAll('\u00a0', ' ').replace(/\r\n?/g, '\n');
}

/**
 * セル内の行ブロックか
 * @param node - ノード
 * @returns セル内の行ブロックかなら true
 */
function isTableCellLineBlock(node: Node): node is HTMLElement {
	return node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P');
}

/**
 * 表示に効かない空白テキストか
 * @param node - ノード
 * @returns 表示に効かない空白テキストかなら true
 */
function isIgnorableTableCellNode(node: Node): boolean {
	// テキスト以外は空白扱いにしない
	if (node.nodeType !== Node.TEXT_NODE) {
		return false;
	}

	// ゼロ幅文字と、ブロックのあいだに挟まる改行を除いた中身
	const text = (node.textContent ?? '').replaceAll(TABLE_CELL_BREAK_CARET, '').replace(/[\n\r]/g, '');
	return text.length === 0;
}

/**
 * 空行用の `<div><br></div>` か。内側の br は行そのものなので、改行として二重に数えない
 * @param node - ノード
 * @returns 空行用の `<div><br></div>` か。内側の br は行そのものなので、改行として二重に数えないなら true
 */
export function isTableCellEmptyLineBlock(node: Node): boolean {
	// 行ブロックでなければ空行の形ではない
	if (!isTableCellLineBlock(node)) {
		return false;
	}

	// 空白テキストを除いた子。空なら空行
	const meaningful = [...node.childNodes].filter((child) => !isIgnorableTableCellNode(child));
	// 子が無い行ブロックは空行
	if (meaningful.length === 0) {
		return true;
	}

	// 子が br だけなら空行。Chrome は高さを残すために br を2本置くことがある
	return meaningful.every((child) => child instanceof HTMLElement && child.tagName === 'BR');
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
type TableCellEditableSlot = { kind: 'text'; node: Text } | { kind: 'break'; caret: TableCellCaretPoint };

/** 行やセル直下の子。text は表示される中身、break は br、gap は空テキストや改行だけ */
export type TableCellStructureChild = 'text' | 'break' | 'gap';

/**
 * 子の並びのうち、ソースの改行として残す br の位置を返す
 * 文字に挟まれた最初の br だけを残す。先頭、末尾、連続した2本目以降は行高のための br
 * @param children - 子の種類。先頭から
 * @returns ソースの改行として残す br の位置
 */
export function tableCellSourceBreakIndexes(children: readonly TableCellStructureChild[]): number[] {
	// 残す br の位置。行高のための br は入れない
	const indexes: number[] = [];
	for (let index = 0; index < children.length; index += 1) {
		// br 以外は改行の候補ではない
		if (children[index] !== 'break') {
			continue;
		}

		// この br より前の子
		const before        = children.slice(0, index);
		// この br より後の子
		const after         = children.slice(index + 1);
		// 前に表示される中身があるか
		const hasTextBefore = before.some((kind) => kind === 'text');
		// 後に表示される中身があるか
		const hasTextAfter  = after.some((kind) => kind === 'text');
		// 文字に挟まれていなければ、クリアやフォーカスでブラウザが足した br
		if (!hasTextBefore || !hasTextAfter) {
			continue;
		}

		// 直前の、空白ではない子。無ければ undefined
		const previous = [...before].reverse().find((kind) => kind !== 'gap');
		// 連続 br の2本目以降は、同じ改行を重ねない
		if (previous === 'break') {
			continue;
		}

		indexes.push(index);
	}

	return indexes;
}

/**
 * ノードを、改行判定用の種類へ分ける
 * @param node - 子ノード
 * @returns ノードを、改行判定用の種類へ分ける
 */
function tableCellStructureKind(node: Node): TableCellStructureChild {
	// 空テキストと、改行だけのテキストは隙間
	if (isIgnorableTableCellNode(node)) {
		return 'gap';
	}

	// br は改行候補
	if (node instanceof HTMLElement && node.tagName === 'BR') {
		return 'break';
	}

	// 表示文字を含むテキスト
	if (node.nodeType === Node.TEXT_NODE) {
		return 'text';
	}

	// 要素でなければ隙間
	if (!(node instanceof HTMLElement)) {
		return 'gap';
	}

	// 子が無い要素は画像など。br を挟む中身として扱う
	if (node.childNodes.length === 0) {
		return 'text';
	}

	// 子孫に表示文字がある要素は、その文字の側に数える
	if ([...node.childNodes].some((child) => tableCellStructureKind(child) === 'text')) {
		return 'text';
	}

	return 'gap';
}

/**
 * ソースへ残さない br か
 * 文字の前だけ、後ろだけ、どちらの文字も無い br は、ブラウザが行の高さを残すために付ける
 * @param block - 行またはセル
 * @param child - 子
 * @returns ソースへ残さない br なら true
 */
function isPlaceholderTableCellBr(block: HTMLElement, child: Node): boolean {
	// br 要素でなければ、行高のための br ではない
	if (!(child instanceof HTMLElement) || child.tagName !== 'BR') {
		return false;
	}

	// 行の子。この br の前後を見る
	const children = [...block.childNodes];
	// br の位置。子でなければ -1
	const index    = children.indexOf(child);
	// 行の子でない br は、ここでのプレースホルダにしない
	if (index < 0) {
		return false;
	}

	// 同じ並びでソースへ残す br の位置
	const kept = tableCellSourceBreakIndexes(children.map((node) => tableCellStructureKind(node)));
	return !kept.includes(index);
}

/**
 * ノード先頭のキャレット位置を返す
 * @param node - ノード
 * @returns ノード先頭のキャレット位置
 */
function caretAtNodeStart(node: Node): TableCellCaretPoint {
	// ノードの先頭。オフセット 0
	return {
		// キャレットを置くノード
		node,
		// ノード内の先頭
		offset: 0
	};
}

/**
 * ノード直前のキャレット位置を返す
 * @param node - ノード
 * @returns ノード直前のキャレット位置
 */
function caretBeforeNode(node: Node): TableCellCaretPoint {
	// 親。文書から外れていれば null
	const parent = node.parentNode;
	// 親が無いノードは、そのノードの先頭に置く
	if (!parent) {
		return {
			// キャレットを置くノード
			node,
			// ノード内の先頭
			offset: 0
		};
	}

	// 親の子一覧での位置。直前に置く
	return {
		// 親ノード
		node: parent,
		// 対象ノードの子インデックス
		offset: [...parent.childNodes].indexOf(node as ChildNode)
	};
}

/**
 * セル DOM を、編集用文字列と同じ改行スロットへ分解する
 * 行ブロックの境界と単独 `<br>` を1改行として並べ、連続空行も落とさない
 * @param cell - セル
 * @returns セル DOM を、編集用文字列と同じ改行スロットへ分解する
 */
function collectTableCellEditableSlots(cell: HTMLElement): TableCellEditableSlot[] {
	// 文字と改行の並び。空セルは空配列
	const slots: TableCellEditableSlot[] = [];
	/**
	 * @param node - テキスト
	 */
	const pushText                       = (node: Text): void => {
		// 改行やゼロ幅だけのテキストは文字にしない。ソースの <br> にしない
		if (tableCellStructureKind(node) !== 'text') {
			return;
		}

		// 表示文字を持つテキストノード
		slots.push({
			// 文字スロット
			kind: 'text',
			// そのテキストノード
			node
		});
	};
	/**
	 * @param node - 対象
	 * @param lineBlock - 所属する行
	 */
	const walkInline                     = (node: Node, lineBlock: HTMLElement | null): void => {
		// テキストは文字スロットにする
		if (node.nodeType === Node.TEXT_NODE) {
			pushText(node as Text);
			return;
		}

		// br は、文字に挟まれていなければ改行スロットにしない
		if (node instanceof HTMLElement && node.tagName === 'BR') {
			// 所属行。直下の br は、その親を行として見る
			const owner = lineBlock ?? node.parentElement;
			// 行高のための br はソースの改行にしない
			if (owner instanceof HTMLElement && isPlaceholderTableCellBr(owner, node)) {
				return;
			}

			// br の直前にキャレットを置く改行
			slots.push({
				// 改行スロット
				kind: 'break',
				// br の直前
				caret: caretBeforeNode(node)
			});
			return;
		}

		// 要素でないノードはスロットにしない
		if (!(node instanceof HTMLElement)) {
			return;
		}

		for (const child of node.childNodes) {
			walkInline(child, lineBlock);
		}
	};

	// 行ブロックを一度でも見たか。直下のインラインも行として扱う
	let hasLine = false;
	for (const child of cell.childNodes) {
		// 行ブロックの境界を 1 改行にする
		if (isTableCellLineBlock(child)) {
			// 先頭行より前に文字か行があるときだけ、境界を改行にする。どちらか一方でも足す
			if (hasLine || slots.length > 0) {
				// 行ブロック先頭に置く改行
				slots.push({
					// 改行スロット
					kind: 'break',
					// 行ブロックの先頭
					caret: caretAtNodeStart(child)
				});
			}

			hasLine = true;
			// 空行ブロックは中の br を二重に数えない
			if (!isTableCellEmptyLineBlock(child)) {
				walkInline(child, child);
			}

			continue;
		}

		hasLine = true;
		// 直下の br は、末尾のプレースホルダでなければ改行スロットにする
		if (child instanceof HTMLElement && child.tagName === 'BR') {
			// 文字に挟まれない br は、クリアや取り消しでブラウザが足す。ソースへ残さない
			if (isPlaceholderTableCellBr(cell, child)) {
				continue;
			}

			slots.push({
				// 改行スロット
				kind: 'break',
				// br の直前
				caret: caretBeforeNode(child)
			});
			continue;
		}

		// 直下のテキストは文字スロットにする
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
	// 文字と改行を足した編集用文字列。スロットが無ければ空文字
	let result = '';
	for (const slot of slots) {
		// テキスト内の改行はブラウザの区切り。改行スロット以外はソースの <br> にしない
		const slotText = slot.kind === 'text' ? normalizeEditableCellDomText(slot.node.textContent ?? '').replaceAll('\n', '') : '\n';
		result        += slotText;
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
	// 文字列の内側に収めた挿入位置
	const bounded = Math.max(0, Math.min(offset, value.length));
	return `${value.slice(0, bounded)}\n${value.slice(bounded)}`;
}

/**
 * 表示文字に数えない文字か
 * @param char - 1文字
 * @returns 表示文字に数えない文字かなら true
 */
function isUncountedTableCellChar(char: string): boolean {
	return char === TABLE_CELL_BREAK_CARET || char === '\n' || char === '\r';
}

/**
 * 表示上の文字数を返す。ゼロ幅のキャレット用文字は数えない
 * @param text - テキスト
 * @param rawEnd - 生オフセット。省略可
 * @returns 表示上の文字数を返す。ゼロ幅のキャレット用文字は数えない
 */
export function visibleTableCellTextLength(text: string, rawEnd: number = text.length): number {
	// ゼロ幅文字を除いた文字数
	let visible = 0;
	// 数える生オフセットの終端。文字列長を超えない
	const end   = Math.max(0, Math.min(rawEnd, text.length));
	for (let index = 0; index < end; index += 1) {
		// ゼロ幅文字と、テキストに混ざった改行は表示文字に数えない
		if (!isUncountedTableCellChar(text[index] ?? '')) {
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
	// ここまで数えた表示文字数
	let visible = 0;
	for (let index = 0; index < text.length; index += 1) {
		// 表示オフセットに達した生位置を返す
		if (visible >= visibleOffset) {
			return index;
		}

		// ゼロ幅文字と、テキストに混ざった改行は表示オフセットを進めない
		if (!isUncountedTableCellChar(text[index] ?? '')) {
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
export function syncTableDataAfterCellChange(data: TableData, position: TableCellPosition, insert: string, editableText?: string): number {
	// 書き換えるセルのソース。範囲外は null
	const source = getTableCellSource(data, position);
	// セルが無い、またはソースが同じなら位置をずらさない。どちらか一方でも 0
	if (!source || source.text === insert) {
		return 0;
	}

	// 増えた文字数。短くなれば負
	const delta         = insert.length - source.text.length;
	// 書き換える前のセル終端。これ以降をずらす
	const oldTo         = source.to;
	// 正規化後のソース
	source.text         = insert;
	// 編集用本文。省略時は br を改行にした結合本文
	source.editableText = editableText ?? parseCellSpan(insert).text.replace(/<br\s*\/?>/gi, '\n');
	// 新しい終端
	source.to           = source.from + insert.length;
	data.tableTo       += delta;

	/**
	 * @param other - 他セル
	 */
	const shiftSource = (other: TableCellSource): void => {
		// 同じセル、または書き戻しより前のセルは動かさない。どちらか一方でも戻る
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
	// 改行を br にした 1 行。ゼロ幅文字は除く
	const singleLine = normalizeEditableCellDomText(value).replaceAll('\n', '<br>');
	// パイプをエスケープしたソース。開始時は空文字
	let result       = '';

	for (let index = 0; index < singleLine.length; index += 1) {
		// いま見ている 1 文字
		const character = singleLine[index]!;
		// パイプ以外はそのまま残す
		if (character !== '|') {
			result += character;
			continue;
		}

		// 直前に続いているバックスラッシュの数。偶数ならパイプは未エスケープ
		let backslashCount = 0;
		for (let cursor = index - 1; cursor >= 0 && singleLine[cursor] === '\\'; cursor -= 1) {
			backslashCount += 1;
		}

		// 直前のバックスラッシュが偶数個のときだけ、パイプの前に 1 つ足す
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
	// 文字列の内側に収めたキャレット位置
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
	// 文字列の内側に収めたキャレット位置
	const boundedOffset = Math.max(0, Math.min(offset, value.length));
	// キャレットより前。改行はそのまま、ゼロ幅文字は除く
	const prefix        = normalizeEditableCellDomText(value.slice(0, boundedOffset));
	// 編集用文字列上の位置。未エスケープのパイプごとに 1 足す
	let result          = prefix.length;

	for (let index = 0; index < prefix.length; index += 1) {
		// 未エスケープのパイプは、正規化でバックスラッシュが 1 文字増える
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
export function isTableCellSelectAllKey(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key'>): boolean {
	return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a';
}

/**
 * 表セル内へソフト改行を入力するShift+Enterか判定する
 * @param event - キーイベント
 * @returns 表セル内へソフト改行を入力するShift+Enterなら true
 */
export function isTableCellSoftBreakKey(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
	return event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * 表の編集を閉じて表示へ戻す Escape か判定する
 * 修飾付きや変換中は、メニューや変換のキャンセルに任せる
 * @param event - キーイベント
 * @returns 修飾なしの Escape なら true
 */
export function isTableEditExitKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>): boolean {
	// 変換中の Escape は文字変換のキャンセル。表の編集は閉じない
	if (event.isComposing) {
		return false;
	}

	// 修飾なしの Escape だけ表の編集を閉じる
	return event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

/**
 * 修飾キーなしの上下キーを表セルの縦移動方向へ変換する
 * 左右キーはブラウザー標準のセル移動へ任せる
 * @param event - キーイベント
 * @returns 変換後の修飾キーなしの上下キーを表セルの縦移動方向
 */
export function getTableCellVerticalArrowDirection(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>): 'up' | 'down' | null {
	// Ctrl、Meta、Alt、Shift のどれかがある上下キーはセル移動にしない
	if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
		return null;
	}

	// 修飾なしの上キーだけ上方向
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
export function getTableCellVerticalNavigation(data: TableData, position: TableCellPosition, event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>): TableCellVerticalNavigation | null {
	// 修飾なしの上下。左右や修飾付きは null
	const direction = getTableCellVerticalArrowDirection(event);
	// 上下キーでなければセル移動を解決しない
	if (!direction) {
		return null;
	}

	// 方向と、端では null になる移動先
	return {
		// 上か下
		direction,
		// 隣セル。端なら null
		target: getAdjacentTableCellPosition(data, position, direction)
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
	// ゼロ幅文字を除いた編集用文字列
	const text    = normalizeEditableCellDomText(value);
	// 文字列の内側に収めたキャレット位置
	const bounded = Math.max(0, Math.min(offset, text.length));
	// 改行を数えた行番号。0 始まり
	let line      = 0;
	// その行の中の位置。改行の直後は 0
	let column    = 0;
	for (let index = 0; index < bounded; index += 1) {
		// 改行で次の行の先頭へ戻す
		if (text[index] === '\n') {
			line  += 1;
			column = 0;
			continue;
		}

		column += 1;
	}

	return {
		// 行番号。0 始まり
		line,
		// 行内位置。0 始まり
		column,
		// 編集文字列の行数。最低 1
		lineCount: text.split('\n').length
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
export function getTableCellVerticalCaretOffset(value: string, offset: number, direction: 'up' | 'down'): number | null {
	// ゼロ幅文字を除いた編集用文字列
	const text     = normalizeEditableCellDomText(value);
	// いまの行と行内位置
	const caret    = getTableCellLineCaretPosition(text, offset);
	// 次に移る行。上なら 1 引く。端を越えると null
	const nextLine = caret.line + (direction === 'down' ? 1 : -1);
	// 先頭より前、または最終行より後ろにはセル内で移れない。どちらか一方でも null
	if (nextLine < 0 || nextLine >= caret.lineCount) {
		return null;
	}

	// 改行で分けた行
	const lines        = text.split('\n');
	// 次の行に収めた同じ桁。行が短ければ行末
	const targetColumn = Math.min(caret.column, lines[nextLine]!.length);
	// 次の行の先頭までの文字数。改行も 1 文字
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
export function moveTableCellCaretVertically(cell: HTMLElement, direction: 'up' | 'down'): boolean {
	// 同じ桁の次行位置。端なら null
	const next = getTableCellVerticalCaretOffset(readTableCellEditableValue(cell), getCellCaretOffset(cell), direction);
	// セルの端ではセル内移動をしない
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
export function buildTableCellChange(data: TableData, position: TableCellPosition, value: string): TableDocumentChange | null {
	// 書き換えるセルのソース。範囲外は null
	const source = getTableCellSource(data, position);
	// セルが無ければ文書変更を作らない
	if (!source) {
		return null;
	}

	// いまのセルが持つ結合、配置、寸法
	const existing   = parseCellSpan(source.text);
	// 入力を br とパイプエスケープへ整えたソース
	const normalized = normalizeTableCellSource(value);
	// 入力側に残った結合属性。通常の入力では空
	const typed      = parseCellSpan(normalized);
	// 入力に属性が残っていればそれを、無ければ既存の属性を残す
	const span       = typed.suffix.trim().length > 0 ? typed : existing;

	// セル範囲を、本文は入力、属性は残したソースで置き換える
	return {
		// セルの開始
		from: source.from,
		// セルの終端
		to: source.to,
		// 属性を戻したセルソース
		insert: formatCellSpan(typed.text, span.colspan, span.rowspan, span.align, span.valign, span.colwidths, span.rowheights)
	};
}

/**
 * Tab / Shift+Tab / Enter / 上下キーの移動先を返す
 * @param data - 表データ
 * @param position - 現在位置
 * @param direction - 移動方向
 * @returns Tab / Shift+Tab / Enter / 上下キーの移動先
 */
export function getAdjacentTableCellPosition(data: TableData, position: TableCellPosition, direction: 'next' | 'previous' | 'up' | 'down'): TableCellPosition | null {
	// 列が無い、または行か列が負なら隣セルは無い。どれか一つでも null
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
export function buildAppendTableRowChange(state: EditorState, data: TableData): TableDocumentChange | null {
	// 足す空行の列数。0 なら表が空
	const columnCount = getTableColumnCount(data);
	// 列が無い表には空行を足さない
	if (columnCount === 0) {
		return null;
	}

	// 表の終端が改行でなければ、行の前に足す改行。すでに改行なら空文字
	const separator = data.tableTo > 0 && state.doc.sliceString(data.tableTo - 1, data.tableTo) === '\n' ? '' : '\n';
	// 表の終端へ空行を挿入する変更
	return {
		// 表の終端
		from: data.tableTo,
		// 表の終端。挿入なので from と同じ
		to: data.tableTo,
		// 空セルを列数ぶん並べた 1 行
		insert: `${separator}| ${Array.from({ length: columnCount }, () => '').join(' | ')} |`
	};
}

/**
 * contenteditable 内のキャレットオフセットを返す
 * @param cell - セル
 * @returns contenteditable 内のキャレットオフセット
 */
// インライン種別から、プレビュー用のクラス名
const TABLE_CELL_INLINE_CLASSES: Record<TableCellInlineKind, string> = {
	// 斜体
	em: 'cm-md-em',
	// 太字
	strong: 'cm-md-strong',
	// 打ち消し
	strike: 'cm-md-strike',
	// ハイライト
	highlight: 'cm-md-highlight',
	// インラインコード
	code: 'cm-md-code',
	// リンク
	link: 'cm-md-link',
	// Wiki リンク
	wikilink: 'cm-md-wikilink'
};

/**
 * キャレットを含むインライン要素のIDを返す
 * 入れ子の場合は、それぞれの要素が所有する記法を表示するため全件を返す
 * @param inlineRanges - インライン範囲
 * @param caretOffset - 編集文字列上のキャレット位置
 * @returns キャレットを含むインライン要素のID
 */
export function getActiveTableCellInlineRangeIds(inlineRanges: TableCellInlineRange[], caretOffset: number): number[] {
	return inlineRanges.filter((inlineRange) => inlineRange.from < caretOffset && caretOffset < inlineRange.to).map((inlineRange) => inlineRange.id);
}

/**
 * プレビュー表示上のキャレット位置を、記法を含む編集文字列上の位置へ変換する
 * @param text - 編集用Markdown文字列
 * @param inlineRanges - インライン範囲
 * @param previewOffset - 記法を除いたプレビュー文字列上の位置
 * @returns 変換後のプレビュー表示上のキャレット位置を、記法を含む編集文字列上の位置
 */
export function getTableCellEditableOffsetFromPreview(text: string, inlineRanges: TableCellInlineRange[], previewOffset: number): number {
	// 記法の範囲。開始位置で並べる
	const markRanges    = inlineRanges.flatMap((inlineRange) => inlineRange.markRanges).sort((a, b) => a.from - b.from || a.to - b.to);
	// 記法を除いた表示文字数
	const visibleLength = text.length - markRanges.reduce((total, markRange) => total + Math.max(0, markRange.to - markRange.from), 0);
	// 表示文字数の内側に収めたプレビュー位置
	const boundedOffset = Math.max(0, Math.min(previewOffset, visibleLength));
	// ここまで数えた表示文字数
	let visibleOffset   = 0;
	// 編集文字列上の位置。記法の中は飛ばす
	let sourceOffset    = 0;
	while (sourceOffset < text.length) {
		// いまの位置を含む記法。無ければ undefined
		const markRange = markRanges.find((range) => range.from <= sourceOffset && sourceOffset < range.to);
		// 記法の中は表示文字に数えない
		if (markRange) {
			sourceOffset = markRange.to;
			continue;
		}

		// 表示位置に達した編集文字列上の位置を返す
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
export function fillEditableTableCellContent(cell: HTMLElement, text: string, inlineRanges: TableCellInlineRange[]): void {
	cell.textContent = '';
	// 改行で分けた行。空行も残す
	const lines      = text.split('\n');
	// この行の編集文字列上の開始
	let lineStart    = 0;
	for (const line of lines) {
		// 1 行ぶんのブロック
		const row = cell.ownerDocument.createElement('div');
		// 空行は br だけを入れて行の高さを残す
		if (line.length === 0) {
			row.appendChild(cell.ownerDocument.createElement('br'));
		} else {
			appendEditableTableCellSegments(row, text, inlineRanges, lineStart, lineStart + line.length);
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
function appendEditableTableCellSegments(lineParent: HTMLElement, text: string, inlineRanges: TableCellInlineRange[], rangeFrom: number, rangeTo: number): void {
	/** 装飾範囲を対象セル内へ収め、分割境界がセル外へ漏れないようにする */
	const clip       = (position: number): number => Math.max(rangeFrom, Math.min(rangeTo, position));
	// 行の両端と、記法・マークの境界。行の外は行端へ寄せる
	const boundaries = new Set<number>([rangeFrom, rangeTo]);
	for (const inlineRange of inlineRanges) {
		boundaries.add(clip(inlineRange.from));
		boundaries.add(clip(inlineRange.to));
		for (const markRange of inlineRange.markRanges) {
			boundaries.add(clip(markRange.from));
			boundaries.add(clip(markRange.to));
		}
	}

	// 境界を開始順に並べた位置。隣り合う区間が 1 断片
	const sortedBoundaries              = [...boundaries].sort((a, b) => a - b);
	// いま開いているインラインコードの span。行が変わると null
	let codeWrapper: HTMLElement | null = null;
	// その span が囲むインライン範囲の ID。別のコードなら作り直す
	let codeWrapperId: number | null    = null;

	/**
	 * インラインコード全体を1つの背景で囲む親要素を返す
	 * @param from - セグメント開始
	 * @param to - セグメント終了
	 * @returns インラインコード全体を1つの背景で囲む親要素
	 */
	const getSegmentParent = (from: number, to: number): HTMLElement => {
		// この断片を含むインラインコード。無ければ undefined
		const codeOwner = inlineRanges.find((inlineRange) => inlineRange.kind === 'code' && inlineRange.from <= from && to <= inlineRange.to);
		// コードの外では、行そのものへ足す
		if (!codeOwner) {
			codeWrapper   = null;
			codeWrapperId = null;
			return lineParent;
		}

		// 別のコード範囲に入ったときだけ、新しい背景 span を作る。どちらか一方でも作り直す
		if (codeWrapper === null || codeWrapperId !== codeOwner.id) {
			codeWrapper           = lineParent.ownerDocument.createElement('span');
			codeWrapper.className = 'cm-md-code';
			codeWrapperId         = codeOwner.id;
			lineParent.appendChild(codeWrapper);
		}

		return codeWrapper;
	};

	for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
		// 断片の開始
		const from = sortedBoundaries[index]!;
		// 断片の終端
		const to   = sortedBoundaries[index + 1]!;
		// 幅の無い境界は表示しない
		if (from >= to) {
			continue;
		}

		// 改行を除いた断片の文字
		const segment      = text.slice(from, to).replaceAll('\n', '');
		// コードなら背景 span、それ以外は行
		const parent       = getSegmentParent(from, to);
		// この断片をマーク範囲に含むインライン。記法文字の所有者
		const markerOwners = inlineRanges.filter((inlineRange) => inlineRange.markRanges.some((markRange) => markRange.from <= from && to <= markRange.to));
		// 記法文字はソース用の span にし、表示装飾は付けない
		if (markerOwners.length > 0) {
			// 空の記法断片は要素を作らない
			if (segment) {
				// 記法文字の span。所有者 ID を dataset に残す
				const marker                = lineParent.ownerDocument.createElement('span');
				marker.className            = 'cm-md-table-source-mark';
				marker.dataset.inlineOwners = markerOwners.map((owner) => owner.id).join(',');
				marker.textContent          = segment;
				parent.appendChild(marker);
			}

			continue;
		}

		// この断片を含む表示装飾のクラス。重複は捨てる
		const classNames = new Set(inlineRanges.filter((inlineRange) => inlineRange.from <= from && to <= inlineRange.to).map((inlineRange) => TABLE_CELL_INLINE_CLASSES[inlineRange.kind]));
		// コード背景の中では、同じ code クラスを内側へ重ねない
		if (parent !== lineParent) {
			classNames.delete('cm-md-code');
		}

		// 言語付きインラインコード。言語が無ければ undefined
		const codeOwner = inlineRanges.find((inlineRange) => inlineRange.kind === 'code' && inlineRange.codeLanguage && inlineRange.from <= from && to <= inlineRange.to);
		// 解決できた言語。未知や未指定は null
		const language  = codeOwner?.codeLanguage ? requestCodeLanguage(codeOwner.codeLanguage) : null;

		// 空断片は要素を作らない
		if (!segment) {
			continue;
		}

		// 装飾も言語も無い断片はテキストノードのままにする。どちらかが欠けるとプレーン
		if (classNames.size === 0 && !language) {
			parent.appendChild(lineParent.ownerDocument.createTextNode(segment));
			continue;
		}

		// 装飾またはハイライトを載せる span
		const content     = lineParent.ownerDocument.createElement('span');
		content.className = [...classNames].join(' ');
		// 言語があるコードだけハイライトする
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
	// 点を作る文書。ノードが文書外なら null
	const documentRef = node.ownerDocument;
	// 文書が無い点は選択末尾と同じ扱いにする
	if (!documentRef) {
		return 0;
	}

	// 比較する点の範囲
	const point     = documentRef.createRange();
	// ノードが受け付ける最大オフセット。テキストは文字数、要素は子の数
	const maxOffset = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').length : node.childNodes.length;
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
	// 文字と改行のスロット
	const slots     = collectTableCellEditableSlots(cell);
	// スロットを戻した編集用文字列。選択が無ければこの長さ
	const value     = slotsToEditableValue(slots);
	// セルの文書の選択。ウィンドウが無ければ undefined
	const selection = cell.ownerDocument.defaultView?.getSelection();
	// 選択が無い、または範囲が無いときは末尾とみなす。どちらか一方でも末尾
	if (!selection || selection.rangeCount === 0) {
		return value.length;
	}

	// 選択の末尾側
	const range = selection.getRangeAt(0);
	// 末尾がセルの外なら、セル末尾とみなす
	if (!cell.contains(range.endContainer)) {
		return value.length;
	}

	// ここまで数えた編集用文字数
	let offset = 0;
	for (const slot of slots) {
		// 文字スロットは、選択末尾がその中なら途中まで数える
		if (slot.kind === 'text') {
			// 選択末尾がこのテキストノードなら、その表示文字数で止める
			if (range.endContainer === slot.node) {
				offset += visibleTableCellTextLength(slot.node.textContent ?? '', range.endOffset);
				break;
			}

			// ノード先頭が選択末尾より後ろなら、このスロットより前で止まっている
			if (comparePointToRangeEnd(slot.node, 0, range) > 0) {
				break;
			}

			// このテキストノードの生の文字数
			const textLength = (slot.node.textContent ?? '').length;
			// ノード終端が選択末尾以前なら、表示文字数を全部足す
			if (comparePointToRangeEnd(slot.node, textLength, range) <= 0) {
				offset += visibleTableCellTextLength(slot.node.textContent ?? '');
				// 終端が選択末尾ちょうどなら、ここで止める
				if (comparePointToRangeEnd(slot.node, textLength, range) === 0) {
					break;
				}

				continue;
			}

			break;
		}

		// 改行を数えない呼び出しでは、改行スロットを飛ばす
		if (!countBreaks) {
			continue;
		}

		// 改行位置と選択末尾の前後。正ならまだ手前
		const cmp = comparePointToRangeEnd(slot.caret.node, slot.caret.offset, range);
		// 改行が選択末尾より後ろなら、その手前で止める
		if (cmp > 0) {
			break;
		}

		offset += 1;
		// 改行位置が選択末尾ちょうどなら、改行の直後で止める
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
	// dataset のインライン範囲。壊れた JSON は空
	let inlineRanges: TableCellInlineRange[] = [];
	try {
		inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
	} catch {
		inlineRanges = [];
	}

	// キャレットが含まれるインライン範囲の ID
	const activeIds = new Set(getActiveTableCellInlineRangeIds(inlineRanges, getCellCaretOffset(cell)));
	for (const marker of cell.querySelectorAll<HTMLElement>('.cm-md-table-source-mark')) {
		// この記法文字を所有するインライン ID
		const owners = (marker.dataset.inlineOwners ?? '').split(',').filter(Boolean).map(Number);
		marker.classList.toggle(
			'cm-md-table-source-mark-active',
			owners.some((owner) => activeIds.has(owner))
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
	// dataset のインライン範囲。壊れた JSON は空
	let inlineRanges: TableCellInlineRange[] = [];
	try {
		inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
	} catch {
		inlineRanges = [];
	}

	// いまの編集用文字列
	const value  = readTableCellEditableValue(cell);
	// 改行を入れる位置。選択が無ければ末尾
	const offset = getCellCaretOffset(cell);
	// その位置へ改行を 1 文字入れた文字列
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
	// 行ブロックだけ。直下のテキストは含めない
	const lines = [...cell.childNodes].filter((node): node is HTMLElement => isTableCellLineBlock(node));
	// 先頭行か最終行。行が無ければ undefined
	const line  = atStart ? lines[0] : lines[lines.length - 1];
	// 行ブロックが無いセルには置けない
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
	// セルの文書の選択。ウィンドウが無ければ undefined
	const selection = cell.ownerDocument.defaultView?.getSelection();
	// 選択を取れなければキャレットを置けない
	if (!selection) {
		return;
	}

	// セル全体から始めて、必要なら途中へ縮める
	const range = cell.ownerDocument.createRange();
	range.selectNodeContents(cell);
	// 全選択でないときだけ、オフセットの位置へ縮める
	if (!selectAll) {
		// 文字と改行のスロット
		const slots   = collectTableCellEditableSlots(cell);
		// まだ進んでいない文字数。負にはしない
		let remaining = Math.max(0, offset);
		// スロット内に置けたか。置けなければ行端へ落とす
		let placed    = false;
		for (const slot of slots) {
			// 文字スロットは表示文字数の中へ置く
			if (slot.kind === 'text') {
				// このテキストの表示文字数
				const length = visibleTableCellTextLength(slot.node.textContent ?? '');
				// 残りがこのテキスト以内なら、その中の生位置へ置く
				if (remaining <= length) {
					range.setStart(slot.node, rawTableCellTextOffset(slot.node.textContent ?? '', remaining));
					range.collapse(true);
					placed = true;
					break;
				}

				remaining -= length;
				continue;
			}

			// 残りが 0 なら、改行の位置へ置く
			if (remaining <= 0) {
				range.setStart(slot.caret.node, slot.caret.offset);
				range.collapse(true);
				placed = true;
				break;
			}

			remaining -= 1;
			// 改行を消費して残りが 0 なら、その改行の直後へ置く
			if (remaining === 0) {
				range.setStart(slot.caret.node, slot.caret.offset);
				range.collapse(true);
				placed = true;
				break;
			}
		}

		// スロットに置けず、行端にも置けないときだけセル末尾へ畳む。どちらかが成功すれば畳まない
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
function persistAndDeactivateTableCell(view: EditorView, cell: HTMLElement, tableFrom: number): void {
	// 編集中フラグか編集中クラスがあるセルだけ書き戻す。どちらか一方でも編集中
	const wasEditing = cell.dataset.editing === 'true' || cell.classList.contains('cm-md-table-cell-editing');
	// 編集中でないセルは文書も DOM も変えない
	if (!wasEditing) {
		return;
	}

	// dataset の行と列。整数でなければ書き戻さない
	const position = {
		// 見出しは 0
		row: Number(cell.dataset.tableRow),
		// 列番号。0 始まり
		column: Number(cell.dataset.tableColumn)
	};
	// 編集中で、行と列が整数で、読み取り専用でないときだけ文書へ書く。どれか一つが欠けても書かない
	if (cell.dataset.editing === 'true' && Number.isInteger(position.row) && Number.isInteger(position.column) && !view.state.readOnly) {
		// 表開始を含む表。無ければ文書は変えない
		const tableNode = findTableNodeAt(view.state, tableFrom);
		// 表があるときだけセル変更を作る
		if (tableNode) {
			// いまの文書の表
			const data   = extractTableData(view.state, tableNode);
			// 編集文字列をセルソースへ戻す変更。セルが無ければ null
			const change = buildTableCellChange(data, position, readTableCellEditableValue(cell));
			// いまのセルソース。範囲外は null
			const source = getTableCellSource(data, position);
			// 変更があり、ソースと違うときだけ文書を置き換える。どれか一つが欠けても書かない
			if (change && source && change.insert !== source.text) {
				// セル範囲の置換。入力として履歴に残す
				view.dispatch({
					// セル範囲の置換
					changes: change,
					// 文字入力として履歴に残す
					userEvent: 'input.type'
				});
			}
		}
	}

	cell.dataset.editing = 'false';
	cell.classList.remove('cm-md-table-cell-editing');
	cell.contentEditable = 'false';
	// 行か列が整数でなければ、プレビューへ戻さず寸法だけ通知する。どちらか一方でも通知して戻る
	if (!Number.isInteger(position.row) || !Number.isInteger(position.column)) {
		notifyTableGeometryChange(cell);
		return;
	}

	// 文書から取り直した表示ノード。セルが無ければ null
	const nodes = getCurrentTableCellNodes(view.state, tableFrom, position);
	// 表示ノードが無いセルはプレビューを埋め直さない
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
function deactivateOtherEditingTableCells(view: EditorView, wrap: HTMLElement, tableFrom: number, except: HTMLElement | null): void {
	for (const other of wrap.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')) {
		// 残すセル以外をプレビューへ戻す
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
	// セルが属する表。表の外なら null
	const wrap      = cell.closest<HTMLElement>('.cm-md-table-wrap');
	// 表の開始。dataset が無ければ NaN
	const tableFrom = Number(wrap?.dataset.tableFrom);
	// ビューと表と整数の開始が揃ったときだけ、他の編集セルを閉じる。どれか一つが欠けても閉じない
	if (view && wrap && Number.isInteger(tableFrom)) {
		deactivateOtherEditingTableCells(view, wrap, tableFrom, cell);
	}

	// 編集中は入力を受け付ける。普段のセルは編集不可のまま
	cell.contentEditable = 'true';
	// すでに編集中のセルは DOM を作り直さない
	if (cell.dataset.editing === 'true') {
		return;
	}

	// 画像だけのセルは、明示フラグが無い限りソース編集に入らない。どちらかが欠けると入る
	if (cellShowsOnlyImage(cell) && cell.dataset.forceImageEdit !== 'true') {
		cell.contentEditable = 'false';
		return;
	}

	cell.dataset.forceImageEdit = 'false';
	cell.dataset.editing        = 'true';
	cell.classList.add('cm-md-table-cell-editing');
	// dataset のインライン範囲。壊れた JSON は空
	let inlineRanges: TableCellInlineRange[] = [];
	try {
		inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
	} catch {
		inlineRanges = [];
	}

	fillEditableTableCellContent(cell, cell.dataset.editableText ?? cell.dataset.source ?? '', inlineRanges);
	updateTableCellInlineMarks(cell);
	notifyTableGeometryChange(cell);
}

/** セル内の取り消し実行中の入れ子。0 のときは、表の外にいたキャレットを表へ戻さない */
let tableCellHistoryDepth = 0;

/**
 * 編集中セルの DOM が文書と違うとき、表示を文書へ戻す
 * 入力直後は文書と DOM が同じなので、キャレットは崩さない
 * @param liveInsert - DOM を文書へ書いたときのソース。書けなければ null
 * @param sourceText - いまの文書のセルソース
 * @returns 表示を文書へ戻すとき true
 */
export function shouldRefreshEditingTableCell(liveInsert: string | null, sourceText: string): boolean {
	return liveInsert !== null && liveInsert !== sourceText;
}

/**
 * 表の外で取り消したとき、キャレットを表の中へ戻さない
 * @param inCellHistory - セル内の取り消し実行中
 * @param docChanged - 文書が変わった
 * @param startedInsideTable - 操作前のキャレットが表の中
 * @param historyNavigation - 取り消しまたはやり直し
 * @returns 表の外のキャレットを維持するとき true
 */
export function shouldKeepSelectionOutsideTable(inCellHistory: boolean, docChanged: boolean, startedInsideTable: boolean, historyNavigation: boolean): boolean {
	return historyNavigation && !inCellHistory && docChanged && !startedInsideTable;
}

/**
 * 編集中セルの表示を、いまの文書のセル本文へ合わせる
 * ブラウザが持つ入力の取り消しは捨てる。残すと、消した文字がすぐ戻る
 * @param view - エディタ
 * @param cell - 編集中セル
 * @param tableFrom - 表開始位置
 * @param position - セル位置
 */
function syncEditingCellFromDocument(view: EditorView, cell: HTMLElement, tableFrom: number, position: TableCellPosition): void {
	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, tableFrom);
	// 表が文書に無ければ、表示を合わせられない
	if (!tableNode) {
		return;
	}

	// いまの文書から取り直した表
	const data   = extractTableData(view.state, tableNode);
	// 同じ位置のセルソース。範囲外は null
	const source = getTableCellSource(data, position);
	// セルが無ければ表示を合わせられない
	if (!source) {
		return;
	}

	cell.dataset.inlineRanges = JSON.stringify(source.inlineRanges);
	cell.dataset.source       = source.text;
	cell.dataset.editableText = source.editableText;
	fillEditableTableCellContent(cell, source.editableText, source.inlineRanges);
	// 一度編集不可にすると、ブラウザの取り消し履歴が消える
	cell.contentEditable = 'false';
	cell.contentEditable = 'true';
	cell.dataset.editing = 'true';
	cell.classList.add('cm-md-table-cell-editing');
	cell.focus({ preventScroll: true });
	setCellSelection(cell, source.editableText.length, false);
}

/**
 * 表示更新の文書差分を、表 DOM の再利用判定より前に残す
 * 更新リスナは DOM 更新の後なので、別の表へ選択が乗り移ったかの判定には使わない
 */
const latestTableDocChanges = ViewPlugin.fromClass(
	/** 直前の表示更新が持つ文書差分。表 DOM を別の表へ使い回さない判定に使う */ class {
		/** この表示更新の文書差分。文書が変わっていなければ null */
		public changes: ChangeSet | null = null;

		/**
		 * 表示更新の文書差分を残す
		 * DOM の再利用は、このメソッドのあとに走る
		 * @param update - 今回のビュー更新
		 */
		update(update: ViewUpdate): void {
			// 文書が変わった更新だけ差分を残す。選択だけなら、前の差分で別の表を同じ表と見ない
			this.changes = update.docChanged ? update.changes : null;
		}
	}
);

/**
 * 以前の表開始が、文書差分を経て今の表開始と同じ表を指すか返す
 * 別の表の DOM を、形が同じという理由で再利用しないために使う
 * @param state - 差分適用後の状態
 * @param changes - その表示更新の文書差分。無ければ null
 * @param oldFrom - 再利用しようとする DOM が持っていた表開始
 * @param newFrom - 今描く表の開始
 * @returns 同じ表なら true
 */
export function tableStartNamesSameTable(state: EditorState, changes: ChangeSet | null, oldFrom: number, newFrom: number): boolean {
	// 開始が動いていない表は、差分を見なくても同じ表
	if (oldFrom === newFrom) {
		return true;
	}

	// 差分が無いずれは、別の表として扱う
	if (!changes) {
		return false;
	}

	// 置換の開始側。表全体の置換では、同じ表の先頭に残る
	const before     = changes.mapPos(oldFrom, -1);
	// 開始側の位置を含む表。隙間や本文なら null
	const beforeNode = findTableNodeAt(state, before);
	// 開始側が今の表なら、同じ表
	if (beforeNode?.from === newFrom) {
		return true;
	}

	// 開始側が別の表なら、終端側が次の表に重なってもそちらへは移さない
	if (beforeNode) {
		return false;
	}

	// 表の直前への挿入。開始側は隙間に残り、終端側がずれた表の先頭になる
	const after     = changes.mapPos(oldFrom, 1);
	// 終端側の位置を含む表。隙間なら null
	const afterNode = findTableNodeAt(state, after);
	return afterNode?.from === newFrom;
}

/**
 * 表の外からの取り消しでは、キャレットを操作前の位置へ戻す
 * セルが常時編集可能だと、選択の復元で次の Ctrl+Z がセルに吸われる
 */
export const tableHistoryFocusExtension = [
	// 表 DOM を別の表へ使い回さないための、表示更新の文書差分
	latestTableDocChanges,
	EditorView.updateListener.of((update) => {
		// 取り消しかやり直しの更新か
		const historyNavigation = update.transactions.some((transaction) => transaction.isUserEvent('undo') || transaction.isUserEvent('redo'));
		// セル内の取り消し、本文が変わらない更新、もともと表の中にいたキャレットは動かさない
		if (!shouldKeepSelectionOutsideTable(tableCellHistoryDepth > 0, update.docChanged, findTableNodeAt(update.startState, update.startState.selection.main.head) !== null, historyNavigation)) {
			return;
		}

		// 操作前のキャレットを、取り消した文書の位置へ移したもの
		const mapped = update.startState.selection.map(update.changes);
		// すでにその位置なら、選択を置き換えない
		if (mapped.eq(update.state.selection)) {
			return;
		}

		// 更新の途中では dispatch できない。直後に、表をクリックしていなければ戻す
		const view      = update.view;
		// この取り消し直後の文書長。次の操作が先に入ったら、古い位置は使わない
		const docLength = update.state.doc.length;
		queueMicrotask(() => {
			// セル編集の取り消しに入ったあと、文書が続きで変わった、または選択がすでに同じなら戻さない
			if (tableCellHistoryDepth > 0 || view.state.doc.length !== docLength || mapped.eq(view.state.selection)) {
				return;
			}

			// 待ちのあいだにセルをクリックしていたら、その編集を奪わない
			const active = view.dom.ownerDocument.activeElement;
			if (active instanceof Element && active.closest('[data-table-row]')) {
				return;
			}

			view.dispatch({
				// 表の外にいたキャレット
				selection: mapped,
				// 選択の戻しは、次の Ctrl+Z で取り消さない
				annotations: Transaction.addToHistory.of(false)
			});
		});
	})
];

/**
 * 編集中でないセルを、文書の文字が変わったときだけ埋め直すか
 * 編集中セルは入力 DOM を維持する
 * @param isEditing - そのセルを編集中か
 * @param previousSource - いま表示しているソース
 * @param nextSource - 文書のソース
 * @returns プレビューを文書へ戻すとき true
 */
export function shouldRefreshPreviewTableCell(isEditing: boolean, previousSource: string, nextSource: string): boolean {
	return !isEditing && previousSource !== nextSource;
}

/**
 * 編集中でないセルの表示を、いまの文書へ合わせる
 * セルの文字だけでは表 DOM を作り直さない。取り消した隣セルは、フォーカスを外すまで古い文字が残る
 * @param view - エディタ
 * @param editingCell - 編集中セル。このセルは編集 DOM のまま残す
 * @param tableFrom - 表開始位置
 */
function refreshInactiveTableCellsFromDocument(view: EditorView, editingCell: HTMLElement, tableFrom: number): void {
	// 編集中セルが属する表。表の外なら null
	const wrap = editingCell.closest<HTMLElement>('.cm-md-table-wrap');
	// 表が描画されていなければ、隣セルを埋め直せない
	if (!wrap) {
		return;
	}

	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, tableFrom);
	// 表が文書に無ければ、表示を合わせられない
	if (!tableNode) {
		return;
	}

	// いまの文書から取り直した表
	const data = extractTableData(view.state, tableNode);
	for (const cell of wrap.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')) {
		// 編集中のセルは、キャレット用の DOM を維持する
		if (cell === editingCell || cell.dataset.editing === 'true') {
			continue;
		}

		// セル位置。dataset が数値でなければ NaN
		const position = {
			// 見出しは 0
			row: Number(cell.dataset.tableRow),
			// 列番号。0 始まり
			column: Number(cell.dataset.tableColumn)
		};
		// 行か列が整数でないセルは飛ばす。どちらか一方でも次へ
		if (!Number.isInteger(position.row) || !Number.isInteger(position.column)) {
			continue;
		}

		// 同じ位置のセルソース。範囲外は null
		const source = getTableCellSource(data, position);
		// セルが無い、または表示がすでに文書と同じなら埋め直さない。どちらか一方でも次へ
		if (!source || !shouldRefreshPreviewTableCell(false, cell.dataset.source ?? '', source.text)) {
			continue;
		}

		// 見出しは headers、本体は行配列。セルが無ければ undefined
		const nodes = position.row === 0 ? data.headers[position.column] : data.rows[position.row - 1]?.[position.column];
		// 表示ノードが無いセルは埋め直さない
		if (!nodes) {
			continue;
		}

		cell.dataset.inlineRanges = JSON.stringify(source.inlineRanges);
		applyCellAlignmentClasses(cell, source.text);
		cell.dataset.source       = source.text;
		cell.dataset.editableText = source.editableText;
		fillTableCellContent(cell, nodes, view);
		applyRememberedWidthToCell(cell, nodes, position);
	}
}

/** 文書上のセル範囲。取り消しで変わった位置からセルを引く */
export type TableCellDocumentSpan = {
	/** 行番号。0 は見出し */
	row: number;
	/** 列番号。0 始まり */
	column: number;
	/** セル本文の開始 */
	from: number;
	/** セル本文の終端 */
	to: number;
};

/**
 * 文書位置を含むセルを返す
 * 空セルは開始と終端が同じなので、その位置ちょうどもそのセルにする
 * @param cells - セル範囲
 * @param pos - 文書位置
 * @returns 文書位置を含むセル。無ければ null
 */
function tableCellCoveringPosition(cells: readonly TableCellDocumentSpan[], pos: number): TableCellPosition | null {
	for (const cell of cells) {
		// 本文の内側。終端ちょうどは、次の文字との境なので含めない
		if (cell.from <= pos && pos < cell.to) {
			return {
				// 見出しは 0
				row: cell.row,
				// 列番号。0 始まり
				column: cell.column
			};
		}
	}

	for (const cell of cells) {
		// 空セルは幅が無い。変わった位置がそこなら、そのセル
		if (cell.from === cell.to && cell.from === pos) {
			return {
				// 見出しは 0
				row: cell.row,
				// 列番号。0 始まり
				column: cell.column
			};
		}
	}

	return null;
}

/**
 * 取り消しややり直しで変わったセルを返す
 * 変わった位置は、編集前の文書でその文字があったセルに属する
 * @param beforeText - 操作前の文書
 * @param afterText - 操作後の文書
 * @param cells - 操作前のセル範囲
 * @returns 取り消しややり直しで変わったセル。表の外なら null
 */
export function tableCellPositionForTextChange(beforeText: string, afterText: string, cells: readonly TableCellDocumentSpan[]): TableCellPosition | null {
	// 先頭から、最初に違う文字の位置
	let index   = 0;
	// 比べられる短い方の長さ
	const limit = Math.min(beforeText.length, afterText.length);
	while (index < limit && beforeText[index] === afterText[index]) {
		index += 1;
	}

	// 文書が同じなら、戻るセルは無い
	if (index === beforeText.length && index === afterText.length) {
		return null;
	}

	// 変わった位置のセル。境目なら、直前の文字のセル
	return tableCellCoveringPosition(cells, index) ?? (index > 0 ? tableCellCoveringPosition(cells, index - 1) : null);
}

/**
 * 操作前の表から、セル範囲を並べる
 * @param state - 操作前の状態
 * @param tableFrom - 表開始位置
 * @returns 操作前の表から、セル範囲を並べる。表が無ければ空
 */
function tableCellDocumentSpans(state: EditorState, tableFrom: number): TableCellDocumentSpan[] {
	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(state, tableFrom);
	// 表が無ければ範囲は空
	if (!tableNode) {
		return [];
	}

	// 操作前の表
	const data                           = extractTableData(state, tableNode);
	// 見出しと本体の範囲
	const cells: TableCellDocumentSpan[] = [];
	for (let column = 0; column < data.headerSources.length; column += 1) {
		// 見出しセル。列が無ければ undefined
		const source = data.headerSources[column];
		// ソースが無い列は範囲にしない
		if (!source) {
			continue;
		}

		cells.push({
			// 見出し行
			row: 0,
			// 列番号。0 始まり
			column,
			// セル本文の開始
			from: source.from,
			// セル本文の終端
			to: source.to
		});
	}

	for (let rowIndex = 0; rowIndex < data.rowSources.length; rowIndex += 1) {
		// 本体の1行。行が無ければ undefined
		const row = data.rowSources[rowIndex];
		// 行が無ければ次へ
		if (!row) {
			continue;
		}

		for (let column = 0; column < row.length; column += 1) {
			// 本体セル。列が無ければ undefined
			const source = row[column];
			// ソースが無い列は範囲にしない
			if (!source) {
				continue;
			}

			cells.push({
				// 見出しの次から 1
				row: rowIndex + 1,
				// 列番号。0 始まり
				column,
				// セル本文の開始
				from: source.from,
				// セル本文の終端
				to: source.to
			});
		}
	}

	return cells;
}

/**
 * セル編集中の取り消しとやり直しを、文書の履歴として実行する
 * ウィジェット破棄の blur が、戻した文書へ編集中の文字列を書き戻さない
 * 戻したあとはセルの表示を文書へ合わせ、変わったセルへフォーカスを戻す
 * @param view - エディタ
 * @param cell - 編集中セル
 * @param tableFrom - 表開始位置
 * @param position - セル位置
 * @param command - undo または redo
 */
export function runTableCellDocumentHistory(view: EditorView, cell: HTMLElement, tableFrom: number, position: TableCellPosition, command: (view: EditorView) => boolean): void {
	tableCellHistoryDepth          += 1;
	// 破棄で blur が先に走る。そのあいだは編集 DOM を文書へ書かない
	cell.dataset.skipHistoryPersist = 'true';
	// 履歴コマンドが文書を変えたか
	let changed                     = false;
	// 操作前の状態。変わったセルは、この文書の範囲から引く
	const beforeState               = view.state;
	try {
		changed = command(view);
		// セルが残っているときは、文書の本文をその場へ書く
		if (changed && cell.isConnected) {
			// 操作前のセル範囲。表が無ければ空
			const cells    = tableCellDocumentSpans(beforeState, tableFrom);
			// 文字が変わったセル。表の外なら null
			const target   = tableCellPositionForTextChange(beforeState.doc.toString(), view.state.doc.toString(), cells);
			// いまのセルの取り消しなら、フォーカスは動かさない
			const sameCell = !target || (target.row === position.row && target.column === position.column);
			// 同じセルなら、編集中の表示だけを文書へ合わせる
			if (sameCell) {
				syncEditingCellFromDocument(view, cell, tableFrom, position);
				// 隣セルの文字は、表 DOM を再利用するとフォーカスを外すまで残る
				refreshInactiveTableCellsFromDocument(view, cell, tableFrom);
			} else if (target) {
				// 隣セルの表示を先に文書へ合わせ、そのあと入力していたセルへ入る
				refreshInactiveTableCellsFromDocument(view, cell, tableFrom);
				// 戻したあとの表。無ければ null
				const afterNode = findTableNodeAt(view.state, tableFrom);
				// 戻したあとの表データ。表が無ければ null
				const afterData = afterNode ? extractTableData(view.state, afterNode) : null;
				// 戻したセルのソース。範囲外は null
				const source    = afterData ? getTableCellSource(afterData, target) : null;
				restoreTableCellFocus(view, tableFrom, target, source?.editableText.length ?? 0, false);
			}
		}
	} finally {
		tableCellHistoryDepth -= 1;
		// 表示を戻した直後、ブラウザが br を足す。フラグを先に戻すと、その br が次の取り消しになる
		/**
		 *
		 */
		const releasePersist   = (): void => {
			cell.dataset.skipHistoryPersist = 'false';
		};
		// ウィンドウが無いテストでは、グローバルの待ちを使う
		if (typeof window === 'undefined') {
			setTimeout(releasePersist, 0);
		} else {
			window.setTimeout(releasePersist, 0);
		}
	}

	// セルが残っているときは、作り直した表へ入り直さない
	if (!changed || cell.isConnected) {
		return;
	}

	restoreTableCellFocus(view, tableFrom, position, 0, true);
}

/**
 * 指定セルへフォーカスを戻す
 * @param view - エディタビュー
 * @param tableFrom - 表開始位置
 * @param position - セル位置
 * @param offset - キャレット位置
 * @param selectAll - 全選択するか
 */
export function restoreTableCellFocus(view: EditorView, tableFrom: number, position: TableCellPosition, offset: number, selectAll: boolean): void {
	clearRenderedTableSelection(view, tableFrom);
	// 表ラッパー。まだ描画されていなければ null
	const wrap   = view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`);
	// 行と列が一致するセル。無ければ null
	const target = wrap?.querySelector<HTMLElement>(`[data-table-row="${position.row}"][data-table-column="${position.column}"]`) ?? null;
	// 表があるときだけ、対象以外の編集セルを閉じる
	if (wrap) {
		deactivateOtherEditingTableCells(view, wrap, tableFrom, target);
	}

	// ブラウザでは window の setTimeout。無い環境はグローバル
	const schedule = typeof window === 'undefined' ? setTimeout : window.setTimeout.bind(window);
	schedule(() => {
		// 表とセルを同時に特定するセレクタ
		const selector = [`.cm-md-table-wrap[data-table-from="${tableFrom}"]`, `[data-table-row="${position.row}"][data-table-column="${position.column}"]`].join(' ');
		// 再描画後のセル。消えていれば null
		const cell     = view.dom.querySelector<HTMLElement>(selector);
		// 再描画でセルが消えていれば、エディタへフォーカスを戻す
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
export function getTableVerticalExitPosition(state: EditorState, tableFrom: number, tableTo: number, forward: boolean): number | null {
	// 下方向は終端の直前、上方向は表の開始。表の境界の文書位置
	const boundaryPosition = forward ? Math.max(tableFrom, tableTo - 1) : tableFrom;

	// 境界を含む行
	const boundaryLine = state.doc.lineAt(boundaryPosition);
	// 表の外の隣の行番号。下なら次、上なら前
	const targetLine   = boundaryLine.number + (forward ? 1 : -1);
	// 文書の先頭より前、または最終行より後ろには出られない。どちらか一方でも null
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
function moveTableCellFocusOutside(view: EditorView, tableFrom: number, tableTo: number, forward: boolean): boolean {
	// 表外の隣行の先頭。文書端なら null
	const target = getTableVerticalExitPosition(view.state, tableFrom, tableTo, forward);
	// 文書端ではキャレットを移せない
	if (target === null) {
		return false;
	}

	clearRenderedTableSelection(view, tableFrom);
	// 表ラッパー。描画が無ければ null
	const wrap = view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`);
	// 表があるときだけ、編集中セルをすべて閉じる
	if (wrap) {
		deactivateOtherEditingTableCells(view, wrap, tableFrom, null);
	}

	// 表外の行頭へカーソルを移す選択
	view.dispatch({
		// 隣行の先頭
		selection: EditorSelection.cursor(target),
		// その行が見えるまでスクロールする
		scrollIntoView: true,
		// 縦移動として履歴に残す
		userEvent: 'select.vertical'
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
	// 編集中のセル。無ければ表の縦移動ではない
	const cell = view.dom.querySelector<HTMLElement>('.cm-md-table-cell-editing');
	// 編集中セルが無いときは CodeMirror の移動に任せる
	if (!cell) {
		return false;
	}

	// セルが属する表。表の外なら null
	const wrap      = cell.closest<HTMLElement>('.cm-md-table-wrap');
	// 表の開始。dataset が無ければ NaN
	const tableFrom = Number(wrap?.dataset.tableFrom);
	// 表の終端。dataset が無ければ NaN
	const tableTo   = Number(wrap?.dataset.tableTo);
	// セルの行。dataset が無ければ NaN
	const row       = Number(cell.dataset.tableRow);
	// セルの列。dataset が無ければ NaN
	const column    = Number(cell.dataset.tableColumn);
	// 表、開始、終端、行、列のどれかが欠けてもセル移動にしない
	if (!wrap || !Number.isInteger(tableFrom) || !Number.isInteger(tableTo) || !Number.isInteger(row) || !Number.isInteger(column)) {
		return false;
	}

	// セル内の改行を同じ桁で移れたときは、隣セルへ出ない
	if (moveTableCellCaretVertically(cell, forward ? 'down' : 'up')) {
		return true;
	}

	// 表開始を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, tableFrom);
	// 表があるときだけ取り直したデータ。無ければ null
	const data      = tableNode ? extractTableData(view.state, tableNode) : null;
	// 隣セル。端なら null
	const target    = data ? getAdjacentTableCellPosition(data, { row, column }, forward ? 'down' : 'up') : null;
	// 隣セルがあるときはそのセルへフォーカスを移す
	if (target) {
		restoreTableCellFocus(view, tableFrom, target, getCellCaretOffset(cell, true), false);
		// 隣セルが無く、表外へも出られないときだけ同じセルへ戻す
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
		// 横配置と縦配置のクラスだけ外す。他のクラスは残す
		if (name.startsWith('cm-md-table-align-') || name.startsWith('cm-md-table-valign-')) {
			cell.classList.remove(name);
		}
	}

	// セルの配置。既定は左詰めと上詰め
	const span      = parseCellSpan(sourceText);
	// 既定以外の配置クラス。既定だけなら空文字
	const className = cellAlignmentClassNames(span);
	// 既定以外があるときだけクラスを足す
	if (className.length > 0) {
		cell.classList.add(...className.split(/\s+/));
	}

	// style を持つ要素だけ、既定値は空文字にしてクラス側へ任せる
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
function applyCellSpan(cell: HTMLTableCellElement, occupancy: ReturnType<typeof buildTableOccupancy>, position: TableCellPosition, sourceText = ''): void {
	// この位置の占有。行が短ければ undefined
	const item = occupancy.cells[position.row]?.[position.column];
	// マスが無い、または結合で覆われたマスは属性を付けない。どちらか一方でも戻る
	if (!item || item.covered) {
		return;
	}

	// 横結合が 2 列以上のときだけ colSpan を付ける
	if (item.colspan > 1) {
		cell.colSpan = item.colspan;
	}

	// 縦結合が 2 行以上のときだけ rowSpan を付ける
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
	// dataset の選択。未設定なら空文字
	const raw = wrap.dataset.tableSelection;
	// 選択が無い表は矩形を持たない
	if (!raw) {
		return null;
	}

	// カンマ区切りの 4 整数。壊れていれば NaN を含む
	const parts = raw.split(',').map((item) => Number(item));
	// 4 個でない、または整数でない値があるときは選択を捨てる。どちらか一方でも null
	if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item))) {
		return null;
	}

	// 開始と終了の行と列。0 始まり
	return {
		// 選択開始行
		startRow: parts[0]!,
		// 選択開始列
		startColumn: parts[1]!,
		// 選択終了行
		endRow: parts[2]!,
		// 選択終了列
		endColumn: parts[3]!
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
	/** 行または列の選択。セル選択中や未選択なら null */
	structure: TableStructureSelection | null;
};

/** EditorView から、上部メニューの操作対象。ビューが捨てられるまで */
const activeTableMenuTargets = new WeakMap<EditorView, ActiveTableMenuTarget>();

/** 上部テーブルメニューの操作対象を、このEditorView内の1表へ固定する */
function activateTableMenuTarget(view: EditorView, wrap: HTMLElement, cell?: TableCellPosition | null): void {
	view.dom.querySelectorAll<HTMLElement>('.cm-md-table-wrap[data-table-menu-active="true"]').forEach((candidate) => {
		// 今回の表以外に付いていた操作対象を外す
		if (candidate !== wrap) delete candidate.dataset.tableMenuActive;
	});
	wrap.dataset.tableMenuActive = 'true';
	// セルがあるときだけ、行と列を dataset に残す
	if (cell) wrap.dataset.tableMenuCell = `${cell.row},${cell.column}`;
	else delete wrap.dataset.tableMenuCell;
	// dataset の表開始。数値でなければ NaN
	const tableFrom = Number(wrap.dataset.tableFrom);
	// 整数の開始だけ、このビューの操作対象として覚える
	if (Number.isInteger(tableFrom)) {
		// 同じ表を覚えているときだけ残す行・列選択。別の表へ移ったときは null
		const structure = activeTableMenuTargets.get(view)?.tableFrom === tableFrom ? (activeTableMenuTargets.get(view)?.structure ?? null) : null;
		activeTableMenuTargets.set(view, {
			// 表の開始。文書上の文字位置
			tableFrom,
			// 渡されたセル。無ければ null
			cell: cell ?? null,
			// 同じ表の行・列選択。別の表では null
			structure
		});
	}
	wrap.dispatchEvent(new CustomEvent(TABLE_MENU_STATE_CHANGE_EVENT, { bubbles: true }));
}

/** 表外へ操作対象が移ったとき、上部テーブルメニューの表対象を解除する */
export function clearActiveTableMenuTarget(view: EditorView): void {
	// 覚えていた対象か、表示中の表を外せたか。無ければ false
	let changed = false;
	// ビューに対象が残っていたときだけ、メニューへ知らせる
	if (activeTableMenuTargets.delete(view)) changed = true;
	view.dom.querySelectorAll<HTMLElement>('.cm-md-table-wrap[data-table-menu-active="true"]').forEach((wrap) => {
		delete wrap.dataset.tableMenuActive;
		delete wrap.dataset.tableMenuCell;
		changed = true;
	});
	// 対象か表示のどちらが変わってもメニューへ知らせる。どちらか一方でも通知
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
function writeTableSelectionRect(wrap: HTMLElement, table: HTMLTableElement, rect: TableSelectionRect): void {
	wrap.dataset.tableSelection = [rect.startRow, rect.startColumn, rect.endRow, rect.endColumn].join(',');
	for (const cell of table.querySelectorAll<HTMLElement>('[data-table-row]')) {
		// セルの行。dataset が無ければ NaN
		const row    = Number(cell.dataset.tableRow);
		// セルの列。dataset が無ければ NaN
		const column = Number(cell.dataset.tableColumn);
		// 行か列が整数でないセルは選択枠を付けない。どちらか一方でも飛ばす
		if (!Number.isInteger(row) || !Number.isInteger(column)) {
			continue;
		}

		// th か td なら結合数を読む。それ以外は null
		const tableCell = cell instanceof HTMLTableCellElement ? cell : null;
		// 矩形に対するこのセルの辺。選択外は selected が false
		const edges     = describeTableCellSelection(
			{
				// セルの行。0 始まり
				row,
				// セルの列。0 始まり
				column
			},
			tableCell?.rowSpan ?? 1,
			tableCell?.colSpan ?? 1,
			rect
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
const TABLE_CELL_SELECTION_CLASS_NAMES = ['cm-md-table-cell-selected', 'cm-md-table-sel-n', 'cm-md-table-sel-s', 'cm-md-table-sel-e', 'cm-md-table-sel-w'] as const;

/**
 * 表の矩形選択を消す
 * @param wrap - 表ラッパー
 * @param table - 表
 */
export function clearTableSelectionRect(wrap: HTMLElement, table: HTMLTableElement): void {
	// 選択 dataset があったか。無ければ false
	const changed = wrap.dataset.tableSelection !== undefined;
	delete wrap.dataset.tableSelection;
	for (const cell of table.querySelectorAll<HTMLElement>('[data-table-row]')) {
		cell.classList.remove(...TABLE_CELL_SELECTION_CLASS_NAMES);
	}
	// 選択が消えたときだけメニューへ知らせる
	if (changed) notifyTableMenuStateChange(wrap);
}

/**
 * 単一セルの編集位置へ同期する左クリックか判定する
 * Shift+左クリックは複数セル選択、右クリックは現在の選択を使うメニュー表示に任せる
 */
export function shouldSyncTableCellEditorOnMouseDown(event: Pick<MouseEvent, 'button' | 'shiftKey'>): boolean {
	return event.button === 0 && !event.shiftKey;
}

/** 複数セル選択中の右クリックで、ブラウザー既定のセルフォーカス移動を抑止する */
export function shouldPreserveTableCellSelectionOnMouseDown(event: Pick<MouseEvent, 'button'>, hasSelection: boolean): boolean {
	return event.button === 2 && hasSelection;
}

/**
 * 複数セルなら塗り、1セルなら消す
 * @param wrap - 表ラッパー
 * @param table - 表
 * @param rect - 矩形
 */
function writeOrClearTableSelection(wrap: HTMLElement, table: HTMLTableElement, rect: TableSelectionRect): void {
	// 2 セル以上なら塗る。1 セルは下で消す
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
	// 開始位置の表。描画が無ければ null
	const wrap  = view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`);
	// 中の table 要素。ラッパーが無ければ undefined
	const table = wrap?.querySelector('table.cm-md-table');
	// ラッパーが無い、または table 要素でないときは消す対象が無い。どちらか一方でも戻る
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
function attachTableCellSelection(wrap: HTMLElement, table: HTMLTableElement, data: TableData, view: EditorView): void {
	// 範囲選択の起点。まだクリックが無ければ null
	let anchor: TableCellPosition | null            = null;
	// 左ボタンを押したままか。離すと false
	let dragging                                    = false;
	// 押し始めた座標。動いたかを後で比べる。無ければ null
	let dragOrigin: { x: number; y: number } | null = null;

	/**
	 * クリック先のセル要素から、表の中の位置を読む
	 * @param target - イベントの対象。セルの外なら null
	 * @returns 見出し行を 0 とした位置。セルでなければ null
	 */
	const positionFromTarget = (target: EventTarget | null): TableCellPosition | null => {
		// セル要素。対象が要素でなければ null
		const cell = target instanceof Element ? target.closest<HTMLElement>('[data-table-row][data-table-column]') : null;
		// セルが無い、またはこの表の外なら位置を返さない。どちらか一方でも null
		if (!cell || !table.contains(cell)) {
			return null;
		}

		// セルの行。dataset が無ければ NaN
		const row    = Number(cell.dataset.tableRow);
		// セルの列。dataset が無ければ NaN
		const column = Number(cell.dataset.tableColumn);
		// 行か列が整数でないセルは位置にしない。どちらか一方でも null
		if (!Number.isInteger(row) || !Number.isInteger(column)) {
			return null;
		}

		// 見出しを 0 とした行と列
		return {
			// 行番号。見出しは 0
			row,
			// 列番号。0 始まり
			column
		};
	};

	// 左ドラッグの開始。構造ボタンや画像の上では選択を始めない
	wrap.addEventListener('mousedown', (event) => {
		// 左ボタン以外はセル選択にしない
		if (event.button !== 0) {
			return;
		}

		// 列幅、行高、画像の上ではセル選択を始めない
		if (event.target instanceof Element && event.target.closest('.cm-md-table-col-resizer, .cm-md-table-row-resizer, .cm-md-image-wrap')) {
			return;
		}

		// クリックしたセル。表の外は null
		const position = positionFromTarget(event.target);
		// セルの外では選択を始めない
		if (!position) {
			return;
		}
		activateTableMenuTarget(view, wrap, position);

		// Shift で、すでに起点があるときだけ範囲を広げる。どちらかが欠けても単一セルの開始
		if (event.shiftKey && anchor) {
			event.preventDefault();
			writeOrClearTableSelection(wrap, table, normalizeTableSelectionRect(anchor, position));
			return;
		}

		anchor     = position;
		dragging   = true;
		// 押し始めた座標。後の mouseover で移動量を見る
		dragOrigin = {
			// クライアント X
			x: event.clientX,
			// クライアント Y
			y: event.clientY
		};
		clearTableSelectionRect(wrap, table);
		clearTableStructureSelection(wrap, table);
	});
	// ドラッグ中に入ったセルまで範囲を広げる
	wrap.addEventListener('mouseover', (event) => {
		// ドラッグ中、起点、開始座標、左ボタン、移動量のどれか一つが欠けても範囲を更新しない
		if (
			!dragging ||
			!anchor ||
			!dragOrigin ||
			(event.buttons & 1) === 0 ||
			!hasTableSelectionPointerMoved(dragOrigin, {
				// いまのクライアント X
				x: event.clientX,
				// いまのクライアント Y
				y: event.clientY
			})
		) {
			return;
		}

		// 入ったセル。セルの外は null
		const position = positionFromTarget(event.target);
		// セルの外へ出ただけでは範囲を変えない
		if (!position) {
			return;
		}

		writeOrClearTableSelection(wrap, table, normalizeTableSelectionRect(anchor, position));
	});
	// ボタンを離したらドラッグを終える
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
export function hasTableSelectionPointerMoved(origin: { x: number; y: number }, current: { x: number; y: number }, threshold = 4): boolean {
	// 横の移動量。左が負
	const deltaX = current.x - origin.x;
	// 縦の移動量。上が負
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
export function observeTableStructureGeometry(observer: Pick<ResizeObserver, 'observe'>, wrap: Element, table: Element): void {
	observer.observe(wrap);
	observer.observe(table);
}

/**
 * 選択ヘッダー表示用の余白がレイアウト計測へ反映される前でも、表本体の基準位置を返す
 */
export function resolveTableStructureOffset(measuredOffset: number, controlPadding: number, controlsVisible: boolean): number {
	return controlsVisible ? Math.max(measuredOffset, controlPadding) : measuredOffset;
}

/**
 * セルの表示DOMを差し替えたことを、表外周の補助UIへ通知する
 * @param cell - 対象セル
 */
function notifyTableGeometryChange(cell: HTMLElement): void {
	// セルが属する表。表の外なら null
	const wrap = cell.closest<HTMLElement>('.cm-md-table-wrap');
	// 表が無いセルは外周へ知らせない
	if (!wrap) {
		return;
	}

	wrap.dispatchEvent(new Event(TABLE_GEOMETRY_CHANGE_EVENT));
}

/**
 * 作り直す表に戻す、覚えていた行・列選択を返す
 * 別の表の選択は戻さない
 * @param view - エディタ
 * @param data - 今描く表
 * @returns この表の選択。無ければ null
 */
function rememberedTableStructureSelection(view: EditorView, data: TableData): TableStructureSelection | null {
	// 上部メニューが覚えている表と選択。未操作なら null
	const target = activeTableMenuTargets.get(view);
	// 行・列を覚えていないときは、新しい DOM に選択を戻さない
	if (!target?.structure) {
		return null;
	}

	// この表示更新の文書差分。プラグインが無い、または文書が変わっていなければ null
	const changes = typeof view.plugin === 'function' ? (view.plugin(latestTableDocChanges)?.changes ?? null) : null;
	// 覚えた開始が別の表を指すときは、その選択をこの表へ戻さない
	if (!tableStartNamesSameTable(view.state, changes, target.tableFrom, data.tableFrom)) {
		return null;
	}

	// 今の表の選択単位。操作後に無くなった範囲は戻せない
	const groups    = buildTableStructureGroups(data, target.structure.axis);
	// 開始が今の単位に残っているか
	const fitsStart = groups.some((group) => group.start === target.structure!.start);
	// 終了が今の単位に残っているか
	const fitsEnd   = groups.some((group) => group.end === target.structure!.end);
	// 開始か終了が単位から外れた選択は戻さない。どちらか一方が欠けても null
	if (!fitsStart || !fitsEnd) {
		return null;
	}

	// 手前の編集で開始位置だけが動いたときは、覚えた位置を今の表へ直す
	if (target.tableFrom !== data.tableFrom) {
		activeTableMenuTargets.set(view, {
			// 今描く表の開始
			tableFrom: data.tableFrom,
			// 覚えていたセル。無ければ null
			cell: target.cell,
			// 戻す行・列選択
			structure: target.structure
		});
	}

	return target.structure;
}

/**
 * 表構造選択ヘッダーを表の外周へ追加する
 * @param wrap - 選択ヘッダーを置く表の枠
 * @param table - 選択クラスを付ける表要素
 * @param data - 選択単位を作る表
 * @param view - メニュー対象を覚えるエディタ
 * @param onGeometryChange - ヘッダーの表示が変わったときに呼ぶ
 * @param initialSelection - 作り直した DOM に戻す選択。無ければ null
 */
function attachTableStructureControls(wrap: HTMLElement, table: HTMLTableElement, data: TableData, view: EditorView, onGeometryChange: () => void, initialSelection: TableStructureSelection | null = null): void {
	// 列の選択単位。結合でまとまった列
	const columnGroups = buildTableStructureGroups(data, 'column');
	// 行の選択単位。見出しを除いた行
	const rowGroups    = buildTableStructureGroups(data, 'row');
	// 列が無い表には選択ヘッダーを出さない
	if (columnGroups.length === 0) {
		return;
	}

	// 表の外周に出す選択ヘッダー。最初は隠す
	const controls     = document.createElement('div');
	controls.className = 'cm-md-table-structure-controls';
	controls.setAttribute('contenteditable', 'false');
	controls.hidden = true;
	// 表より前に置く。中身は枠の流れに入り、列選択だけが sticky で留まる
	wrap.insertBefore(controls, table);
	// 列選択の帯。ボタンをこの中に置き、スクロールのたびに top を書き直さない
	const columnBand     = document.createElement('div');
	columnBand.className = 'cm-md-table-structure-column-band';
	columnBand.setAttribute('aria-hidden', 'true');
	controls.appendChild(columnBand);
	// 行選択列の見出し。見出し行の左で留まり、行ボタンがそこをすり抜けない
	const rowHead     = document.createElement('div');
	rowHead.className = 'cm-md-table-structure-row-head';
	rowHead.setAttribute('aria-hidden', 'true');
	controls.appendChild(rowHead);
	// 行ボタンの層。表より手前に置き、見出しの下へ流す
	const rowLayer     = document.createElement('div');
	rowLayer.className = 'cm-md-table-structure-row-layer';
	controls.appendChild(rowLayer);
	// 範囲選択の起点。まだ押していなければ null
	let anchor: { axis: TableStructureAxis; group: TableStructureRange } | null = null;
	// 左ボタンを押したままか。離すと false
	let dragging                                                                = false;

	/**
	 * 行または列の選択ボタンを作る
	 * @param axis - row は行、column は列
	 * @param group - ボタンが担当する選択単位。start と end は 0 始まり
	 * @returns 番号を表示する button。フォーカスは受け取らない
	 */
	const createButton = (axis: TableStructureAxis, group: TableStructureRange): HTMLButtonElement => {
		// 番号を出すボタン。フォーカスは受け取らない
		const button                       = document.createElement('button');
		button.type                        = 'button';
		button.tabIndex                    = -1;
		button.className                   = `cm-md-table-structure-selector is-${axis}`;
		button.dataset.tableStructureAxis  = axis;
		button.dataset.tableStructureStart = String(group.start);
		button.dataset.tableStructureEnd   = String(group.end);
		// 表示する開始番号。列は 1 始まり、行は見出しを 0 のまま
		const numberFrom                   = axis === 'row' ? group.start : group.start + 1;
		// 表示する終了番号。1 単位なら開始と同じ
		const numberTo                     = axis === 'row' ? group.end : group.end + 1;
		// ボタンに出す番号。範囲なら開始と終了を結ぶ
		const label                        = numberFrom === numberTo ? String(numberFrom) : `${numberFrom}–${numberTo}`;
		button.textContent                 = '';
		button.title                       = `${axis === 'row' ? '行' : '列'} ${label} を選択`;
		button.setAttribute('aria-label', button.title);
		button.setAttribute('aria-pressed', 'false');
		return button;
	};

	columnGroups.forEach((group) => columnBand.appendChild(createButton('column', group)));
	rowGroups.forEach((group) => rowLayer.appendChild(createButton('row', group)));

	/** 列選択の幅と、行選択列の見出しを、見出し行へ合わせる */
	const syncPinnedStructureChrome = (): void => {
		// 表の幅に左余白を足す。スクロール中は書き換えない
		columnBand.style.width = `${table.offsetWidth + TABLE_STRUCTURE_CONTROLS_GUTTER_PX}px`;
		// 固定する見出し行。thead が無ければ先頭行
		const headerRow        = table.tHead?.rows[0] ?? table.rows[0];
		// 見出し行が無い表は、行選択列の見出しを置かない
		if (!headerRow) {
			return;
		}

		// 見出し行の高さ。行選択列の見出しはこれと重ね、余白は負の margin で消す
		const headerHeight         = headerRow.getBoundingClientRect().height;
		rowHead.style.height       = `${headerHeight}px`;
		rowHead.style.marginBottom = `${-headerHeight}px`;
	};

	/** ボタンを表の実寸へ合わせる */
	const sync = (): void => {
		// ラッパーの画面上の矩形
		const wrapRect   = wrap.getBoundingClientRect();
		// 表本体の画面上の矩形
		const tableRect  = table.getBoundingClientRect();
		// ヘッダーを出しているか。余白の有無に使う
		const visible    = !controls.hidden;
		// 表本体の左。余白があっても計測前なら余白分を下限にする
		const tableLeft  = resolveTableStructureOffset(resolveTableRelativeOffset(wrapRect.left, tableRect.left, wrap.scrollLeft), TABLE_STRUCTURE_CONTROLS_GUTTER_PX, visible);
		// 表本体の上。余白があっても計測前なら余白分を下限にする
		const tableTop   = resolveTableStructureOffset(resolveTableRelativeOffset(wrapRect.top, tableRect.top, wrap.scrollTop), TABLE_STRUCTURE_CONTROLS_GUTTER_PX, visible);
		// 各列の右端。最終グループの終了列まで
		const rightEdges = computeColumnRightEdges(collectTableCellBoxes(table), columnGroups.at(-1)!.end + 1);
		controls.querySelectorAll<HTMLElement>('.cm-md-table-structure-selector.is-column').forEach((button) => {
			// ボタンが担当する列範囲。dataset が壊れていれば null
			const range = readTableStructureRange(button);
			// 範囲が読めないボタンは位置を変えない
			if (!range) return;
			// 範囲の左端。先頭列は 0
			const left         = range.start === 0 ? 0 : (rightEdges[range.start - 1] ?? 0);
			// 範囲の右端。右端が無ければ左端と同じ
			const right        = rightEdges[range.end] ?? left;
			button.style.left  = `${tableLeft + left}px`;
			button.style.width = `${Math.max(0, right - left)}px`;
		});
		syncPinnedStructureChrome();
		controls.querySelectorAll<HTMLElement>('.cm-md-table-structure-selector.is-row').forEach((button) => {
			// ボタンが担当する行範囲。dataset が壊れていれば null
			const range = readTableStructureRange(button);
			// 範囲が読めないボタンは位置を変えない
			if (!range) return;
			// 範囲の先頭行。行が無ければ undefined
			const first = table.rows[range.start];
			// 範囲の最終行。行が無ければ undefined
			const last  = table.rows[range.end];
			// 先頭か最終の行要素が無いときは高さを付けない。どちらか一方でも戻る
			if (!first || !last) return;
			// 先頭行の画面上の矩形
			const firstRect = first.getBoundingClientRect();
			// 最終行の画面上の矩形
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
			// 表が文書から外れていれば、確定後の再計測はしない
			if (!table.isConnected) return;
			sync();
			onGeometryChange();
		});
	};

	/** ヘッダーと専用余白をまとめて切り替え、表上のリサイズハンドルを追従させる */
	const setVisible = (visible: boolean): void => {
		// すでに同じ表示状態なら余白も計測も変えない
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
		// いま記録されている行または列の選択。未選択なら null
		const current = readTableStructureSelection(wrap);
		// 拡張でなく、同じ軸の同じ範囲を再クリックしたときは選択を消す。どれか一つが欠けても消さない
		if (!extend && current?.axis === axis && current.start === group.start && current.end === group.end) {
			anchor = null;
			clearTableStructureSelection(wrap, table);
			return;
		}

		// 今回の軸の選択単位。行と列は混ぜない
		const groups = axis === 'row' ? rowGroups : columnGroups;
		// 拡張でない、起点が無い、軸が違う、のどれかならその単位だけを選ぶ
		if (!extend || !anchor || anchor.axis !== axis) {
			// 次の拡張の起点
			anchor = {
				// 選択している軸
				axis,
				// クリックした選択単位
				group
			};
			writeTableStructureSelection(wrap, table, {
				// 選択している軸
				axis,
				// クリックした単位の開始と終了
				...group
			});
			return;
		}
		// 起点の単位番号。見つからなければ -1
		const anchorIndex = groups.findIndex((item) => item.start === anchor!.group.start && item.end === anchor!.group.end);
		// クリックした単位番号。見つからなければ -1
		const focusIndex  = groups.findIndex((item) => item.start === group.start && item.end === group.end);
		// 起点かクリック先が単位に無いときは範囲を広げない。どちらか一方でも戻る
		if (anchorIndex < 0 || focusIndex < 0) return;
		// 範囲の早い方の単位番号
		const from = Math.min(anchorIndex, focusIndex);
		// 範囲の遅い方の単位番号
		const to   = Math.max(anchorIndex, focusIndex);
		// 起点とクリック先の間を含む選択
		writeTableStructureSelection(wrap, table, {
			// 選択している軸
			axis,
			// 早い方の単位の開始
			start: groups[from]!.start,
			// 遅い方の単位の終了
			end: groups[to]!.end
		});
	};

	// 選択ボタンの押下。右クリックは範囲を固定し、左クリックは選択を更新する
	controls.addEventListener('mousedown', (event) => {
		// 押した選択ボタン。ボタンの外は null
		const button = event.target instanceof Element ? event.target.closest<HTMLElement>('.cm-md-table-structure-selector') : null;
		// ボタンの軸と範囲。ボタンでなければ null
		const target = button ? readTableStructureButton(button) : null;
		// 選択ボタン以外では構造選択を変えない
		if (!target) return;
		activateTableMenuTarget(view, wrap);
		// 右クリックは、いまの選択か押した単位をメニュー対象として固定する
		if (event.button === 2) {
			// 右クリック用に広げた選択。未選択なら押した単位だけ
			const selection = resolveTableStructureContextSelection(readTableStructureSelection(wrap), {
				// 押したボタンの軸
				axis: target.axis,
				// 押した単位の開始と終了
				...target.range
			});
			// 次の拡張の起点。右クリックで固定した範囲
			anchor          = {
				// 固定した軸
				axis: selection.axis,
				// 固定した開始と終了
				group: {
					// 選択の開始
					start: selection.start,
					// 選択の終了
					end: selection.end
				}
			};
			writeTableStructureSelection(wrap, table, selection);
			return;
		}
		// 左ボタン以外は選択を更新しない
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		dragging = true;
		select(target.axis, target.range, event.shiftKey);
	});
	// ドラッグ中に入ったボタンまで、同じ軸の範囲を広げる
	controls.addEventListener('mouseover', (event) => {
		// ドラッグ中でない、または左ボタンが離れているときは広げない。どちらか一方でも戻る
		if (!dragging || (event.buttons & 1) === 0) return;
		// 入った選択ボタン。ボタンの外は null
		const button = event.target instanceof Element ? event.target.closest<HTMLElement>('.cm-md-table-structure-selector') : null;
		// ボタンの軸と範囲。ボタンでなければ null
		const target = button ? readTableStructureButton(button) : null;
		// ボタンが無い、起点が無い、軸が違う、のどれかでは範囲を広げない
		if (!target || !anchor || target.axis !== anchor.axis) return;
		select(target.axis, target.range, true);
	});
	// 右クリックメニューを開くときも、押した単位を選択として固定する
	controls.addEventListener('contextmenu', (event) => {
		// 右クリックした選択ボタン。ボタンの外は null
		const button = event.target instanceof Element ? event.target.closest<HTMLElement>('.cm-md-table-structure-selector') : null;
		// ボタンの軸と範囲。ボタンでなければ null
		const target = button ? readTableStructureButton(button) : null;
		// 選択ボタン以外では範囲を固定しない
		if (!target) return;
		// 右クリック用に広げた選択。未選択なら押した単位だけ
		const selection = resolveTableStructureContextSelection(readTableStructureSelection(wrap), {
			// 押したボタンの軸
			axis: target.axis,
			// 押した単位の開始と終了
			...target.range
		});
		// 次の拡張の起点。メニュー用に固定した範囲
		anchor          = {
			// 固定した軸
			axis: selection.axis,
			// 固定した開始と終了
			group: {
				// 選択の開始
				start: selection.start,
				// 選択の終了
				end: selection.end
			}
		};
		writeTableStructureSelection(wrap, table, selection);
	});
	// ボタンを離したら構造ヘッダーのドラッグを終える
	controls.addEventListener('mouseup', () => {
		dragging = false;
	});
	// Escape でセル編集を閉じ、選択ヘッダーを隠してエディタの表示へ戻す
	wrap.addEventListener('keydown', (event) => {
		// 表編集を閉じるキーではない、または先に処理済みなら戻す。どちらか一方でも戻る
		if (!isTableEditExitKey(event) || event.defaultPrevented) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		// 行・列選択の起点。残すと次のドラッグが前回の範囲を引き継ぐ
		anchor = null;
		clearTableStructureSelection(wrap, table);
		// いま表の中にあるフォーカス。セルか選択ボタン。表の外なら null
		const active = wrap.ownerDocument.activeElement;
		// 表の中のフォーカスだけ外す。外すと編集中セルは blur でプレビューへ戻る
		if (active instanceof HTMLElement && wrap.contains(active)) {
			active.blur();
		}

		setVisible(false);
		view.focus();
	});
	// 表にフォーカスが入ったら選択ヘッダーを出す
	wrap.addEventListener('focusin', () => {
		setVisible(true);
	});
	// フォーカスが表の外へ出たら、選択が残っていないときだけヘッダーを隠す
	wrap.addEventListener('focusout', () => {
		queueMicrotask(() => {
			setVisible(!shouldHideTableStructureControls(wrap.contains(wrap.ownerDocument.activeElement), Boolean(readTableStructureSelection(wrap))));
		});
	});
	// セル DOM の差し替え後に、ボタン位置を表へ合わせ直す
	wrap.addEventListener(TABLE_GEOMETRY_CHANGE_EVENT, syncAfterGeometryChange);

	// 作り直した DOM には、操作した表の選択だけを戻す。別の表の選択はここに来ない
	if (initialSelection) {
		writeTableStructureSelection(wrap, table, initialSelection);
		setVisible(true);
		wrap.dataset.tableMenuActive = 'true';
	}

	sync();
	requestAnimationFrame(sync);
	// 表かラッパーの寸法が変わったらボタン位置を合わせる。表が外れたら監視を止める
	const observer = new ResizeObserver(() => {
		// 表が文書から外れていれば監視を止める
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
	// dataset の軸。row と column 以外は使わない
	const axis  = button.dataset.tableStructureAxis;
	// 開始と終了。数値でなければ null
	const range = readTableStructureRange(button);
	// 軸が行か列で、範囲もあるときだけ返す。どちらかが欠けても null
	return (axis === 'row' || axis === 'column') && range
		? {
			// 行か列
			axis,
			// 選択単位の開始と終了
			range
		}
		: null;
}

/**
 * 要素の dataset から、選択単位の開始と終了を読む
 * @param element - start と end を dataset に持つ要素
 * @returns 開始が終了以下の範囲。数値でなければ null
 */
function readTableStructureRange(element: HTMLElement): TableStructureRange | null {
	// 開始番号。dataset が無ければ NaN
	const start = Number(element.dataset.tableStructureStart);
	// 終了番号。dataset が無ければ NaN
	const end   = Number(element.dataset.tableStructureEnd);
	// 開始と終了が整数で、開始が終了以下のときだけ範囲にする。どれか一つが欠けても null
	return Number.isInteger(start) && Number.isInteger(end) && start <= end
		? {
			// 選択単位の開始
			start,
			// 選択単位の終了
			end
		}
		: null;
}

/**
 * 表ラッパーに記録した行または列の選択を読む
 * @param wrap - dataset.tableStructureSelection を持つ表の枠
 * @returns 軸と範囲。未選択や壊れた値なら null
 */
function readTableStructureSelection(wrap: HTMLElement): TableStructureSelection | null {
	// dataset を軸、開始、終了に分けた値。未選択なら空文字
	const [axis, rawStart, rawEnd] = (wrap.dataset.tableStructureSelection ?? '').split(',');
	// 開始番号。数値でなければ NaN
	const start                    = Number(rawStart);
	// 終了番号。数値でなければ NaN
	const end                      = Number(rawEnd);
	// 軸が行か列で、開始と終了が整数かつ開始が終了以下のときだけ返す。どれか一つが欠けても null
	return (axis === 'row' || axis === 'column') && Number.isInteger(start) && Number.isInteger(end) && start <= end
		? {
			// 行か列
			axis,
			// 選択の開始
			start,
			// 選択の終了
			end
		}
		: null;
}

/**
 * 行と列の選択表示を消し、メニューへ状態変化を通知する
 * @param wrap - 選択 dataset を消す表の枠
 * @param table - 選択クラスを外す表要素
 */
function clearTableStructureSelection(wrap: HTMLElement, table: HTMLTableElement): void {
	// 選択 dataset があったか。無ければ false
	const changed = wrap.dataset.tableStructureSelection !== undefined;
	delete wrap.dataset.tableStructureSelection;
	wrap.querySelectorAll<HTMLElement>('.cm-md-table-structure-selector').forEach((button) => {
		button.classList.remove('is-selected');
		button.setAttribute('aria-pressed', 'false');
	});
	table.querySelectorAll(`.${TABLE_STRUCTURE_SELECTION_CLASS}`).forEach((cell) => {
		cell.classList.remove(TABLE_STRUCTURE_SELECTION_CLASS);
	});
	// 選択が消えたときだけメニューへ知らせる
	if (changed) notifyTableMenuStateChange(wrap);
}

/**
 * 行または列の選択を dataset とボタンの押下状態へ書く
 * セル範囲の選択は先に消す
 * @param wrap - 選択を記録する表の枠
 * @param table - 選択クラスを付ける表要素
 * @param selection - 書く軸と範囲
 */
function writeTableStructureSelection(wrap: HTMLElement, table: HTMLTableElement, selection: TableStructureSelection): void {
	clearTableSelectionRect(wrap, table);
	wrap.dataset.tableStructureSelection = `${selection.axis},${selection.start},${selection.end}`;
	wrap.querySelectorAll<HTMLElement>('.cm-md-table-structure-selector').forEach((button) => {
		// ボタンの軸と範囲。読めなければ null
		const target   = readTableStructureButton(button);
		// 同じ軸で、選択の内側に収まるボタンだけ押下状態にする。どれか一つが欠けても外す
		const selected = Boolean(target && target.axis === selection.axis && target.range.start >= selection.start && target.range.end <= selection.end);
		button.classList.toggle('is-selected', selected);
		button.setAttribute('aria-pressed', String(selected));
	});
	table.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]').forEach((cell) => {
		// セルの行。dataset が無ければ NaN
		const row      = Number(cell.dataset.tableRow);
		// セルの列。dataset が無ければ NaN
		const column   = Number(cell.dataset.tableColumn);
		// 選択軸に沿った結合数。th/td でなければ 1
		const span     = cell instanceof HTMLTableCellElement ? (selection.axis === 'row' ? cell.rowSpan : cell.colSpan) : 1;
		// 選択軸の位置。行選択なら行、列選択なら列
		const value    = selection.axis === 'row' ? row : column;
		// セルの占有が選択範囲に収まるときだけ選択クラスを付ける
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
export function snapshotTableStructureActionFromEvent(view: EditorView, event: MouseEvent): TableStructureMenuSnapshot | null {
	// 右クリックした選択ボタン。ボタンの外は null
	const button = event.target instanceof Element ? event.target.closest<HTMLElement>('.cm-md-table-structure-selector') : null;
	// ボタンが属する表。表の外は null
	const wrap   = button?.closest<HTMLElement>('.cm-md-table-wrap');
	// ボタンが無い、表が無い、このビューの外、のどれかでは操作対象を固定しない
	if (!button || !wrap || !view.dom.contains(wrap)) return null;
	// 見えている枠の現在の開始。dataset の古い位置より優先する。取れなければ null
	const tableFrom = resolveTableFromForPersist(view, wrap);
	// 記録済みの行または列の選択。未選択なら null
	const selection = readTableStructureSelection(wrap);
	// 表が取れない、または選択が無いときは固定しない。どちらか一方でも null
	if (tableFrom === null || !selection) return null;
	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, tableFrom);
	// 表が文書に無いときは操作可否を作れない
	if (!tableNode) return null;
	// いまの文書から取り直した表
	const data  = extractTableData(view.state, tableNode);
	// 削除と移動の可否
	const state = getTableStructureActionState(data, selection);
	return {
		// 表の開始
		tableFrom,
		// 軸と範囲
		...selection,
		// 削除と移動の可否
		...state
	};
}

/** 固定済みの行・列範囲へ構造操作を適用する */
export function applyTableStructureSnapshot(view: EditorView, snapshot: Pick<TableStructureMenuSnapshot, 'tableFrom' | 'axis' | 'start' | 'end'>, action: TableStructureAction): boolean {
	// 読み取り専用では構造を変えない
	if (view.state.readOnly) return false;
	persistEditingTableCellsAt(view, snapshot.tableFrom);
	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, snapshot.tableFrom);
	// 表が文書に無ければ操作を適用しない
	if (!tableNode) return false;
	// いまの文書から取り直した表
	const data   = extractTableData(view.state, tableNode);
	// 行または列の操作を表全体の置換にしたもの。禁止された操作は null
	const change = buildTableStructureChange(view.state, data, snapshot, action);
	// 変更を作れない操作は文書を変えない
	if (!change) return false;
	// 操作後も同じ行や列を指す選択。削除したときは null
	const nextSelection = structureSelectionAfterAction(data, snapshot, action);
	// 作り直す DOM へ戻すため、適用より前に覚える
	const menuTarget    = activeTableMenuTargets.get(view);
	activeTableMenuTargets.set(view, {
		// 操作した表の開始。表全体の置換では開始は動かない
		tableFrom: data.tableFrom,
		// 覚えていたセル。無ければ null
		cell: menuTarget?.cell ?? null,
		// 操作後の行・列選択。削除なら null
		structure: nextSelection
	});
	// 表全体を 1 区間で置き換える入力
	view.dispatch({
		// 表範囲の置換
		changes: change,
		// 文字入力として履歴に残す
		userEvent: 'input.type'
	});
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

/**
 * メニュー操作の表開始を、見えている枠の位置から決める
 * クリック時に覚えた文字位置は、枠から表が取れないときだけ使う
 * @param view - エディタ
 * @param wrap - 操作中の表枠
 * @param rememberedFrom - クリック時に覚えた開始。無ければ null
 * @returns 操作する表の開始と、見えている枠から取れたか。表が無ければ null
 */
function resolveActiveMenuTableFrom(view: EditorView, wrap: HTMLElement, rememberedFrom: number | null): { tableFrom: number; fromLiveWrap: boolean } | null {
	// 見えている枠から取れた表。DOM から取れなければ null
	const liveFrom = resolveTableFromForPersist(view, wrap);
	// 枠の位置が別の表の中にあっても、覚えた文字位置よりこちらを使う
	if (liveFrom !== null) {
		return {
			// 今の文書での表開始
			tableFrom: liveFrom,
			// 見えている枠から取れた
			fromLiveWrap: true
		};
	}

	// 覚えた開始が整数でないときは予備にしない
	if (rememberedFrom === null || !Number.isInteger(rememberedFrom)) {
		return null;
	}

	// 覚えた位置を含む表。枠がエディタ外のときだけ使う
	const tableNode = findTableNodeAt(view.state, rememberedFrom);
	// 文書に表が無い覚えた位置は操作先にしない
	if (!tableNode) {
		return null;
	}

	return {
		// その表の開始。覚えた位置が表の途中でも開始へ揃える
		tableFrom: tableNode.from,
		// 枠からは取れず、覚えた位置を使った
		fromLiveWrap: false
	};
}

/** 上部メニュー用に、見えている表の現在位置と、その行・列・セル選択を取得する */
export function snapshotActiveTableMenu(view: EditorView): TableMenuSnapshot {
	// このビューが覚えている表とセル。未操作なら null
	const target = activeTableMenuTargets.get(view) ?? null;
	// 選択の印が付いた表。印が無いときは、覚えた位置で別の表を拾わない
	const wrap   = view.dom.querySelector<HTMLElement>('.cm-md-table-wrap[data-table-menu-active="true"]') ?? null;
	// 操作中の表が無いときは、表の外として空の状態を返す
	if (!wrap)
		return {
			// 表の外
			inMarkdownTable: false,
			// 行・列選択は無い
			structure: null,
			// 結合操作は無い
			merge: null
		};

	// 見えている枠の開始。枠から取れないときだけ、覚えた位置を含む表
	const menuTable = resolveActiveMenuTableFrom(view, wrap, target?.tableFrom ?? null);
	// 表の開始が取れないときはメニュー対象にしない
	if (!menuTable)
		return {
			// 表の外
			inMarkdownTable: false,
			// 行・列選択は無い
			structure: null,
			// 結合操作は無い
			merge: null
		};

	// 操作する表の開始。見えている枠を優先した値
	const tableFrom = menuTable.tableFrom;
	// 枠から取れた開始が覚えている位置と違うときは、次のメニューも同じ表を見るよう更新する
	if (menuTable.fromLiveWrap && (!target || target.tableFrom !== tableFrom)) {
		activeTableMenuTargets.set(view, {
			// 今の文書での表開始
			tableFrom,
			// 枠に属するセル。無ければ null
			cell: target?.cell ?? null,
			// 同じ表の行・列選択。未選択なら null
			structure: target?.structure ?? null
		});
	}
	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, tableFrom);
	// 文書に表が無いときはメニュー対象にしない
	if (!tableNode)
		return {
			// 表の外
			inMarkdownTable: false,
			// 行・列選択は無い
			structure: null,
			// 結合操作は無い
			merge: null
		};
	// いまの文書から取り直した表
	const data      = extractTableData(view.state, tableNode);
	// 行または列の選択。セル選択中は null
	const selection = readTableStructureSelection(wrap);
	// 行・列選択があるときは結合操作を出さない
	if (selection) {
		// 表の中で、行・列操作だけを返す
		return {
			// Markdown 表の中
			inMarkdownTable: true,
			// 選択と削除・移動の可否
			structure: {
				// 表の開始
				tableFrom,
				// 軸と範囲
				...selection,
				// 削除と移動の可否
				...getTableStructureActionState(data, selection)
			},
			// 行・列選択中は結合を出さない
			merge: null
		};
	}

	// 覚えたセル。開始位置がずれても、この枠の行と列として使う。無ければ null
	const storedCell          = target?.cell ?? null;
	// dataset の行と列。未設定なら空文字
	const [rawRow, rawColumn] = (wrap.dataset.tableMenuCell ?? '').split(',');
	// 行番号。数値でなければ NaN
	const row                 = Number(rawRow);
	// 列番号。数値でなければ NaN
	const column              = Number(rawColumn);
	// 覚えたセル。無ければ dataset の整数の行と列。どちらも無ければ null
	const clicked             =
		storedCell ??
		(rawRow !== '' && rawColumn !== '' && Number.isInteger(row) && Number.isInteger(column)
			? {
				// 見出しは 0
				row,
				// 列番号。0 始まり
				column
			}
			: null);
	// 選択かクリックから決めた結合対象。範囲が無ければ null
	const resolved            = resolveTableMergeTargetFromParts(view.state, tableFrom, readTableSelectionRect(wrap), clicked);
	// 表の中で、結合操作だけを返す
	return {
		// Markdown 表の中
		inMarkdownTable: true,
		// セル選択中は行・列操作を出さない
		structure: null,
		// 結合できる範囲。範囲が無ければ null
		merge: resolved
			? {
				// 表の開始
				tableFrom,
				// 結合する矩形
				rect: resolved.state.rect,
				// 結合できるか
				canMerge: resolved.state.canMerge,
				// 結合を解除できるか
				canUnmerge: resolved.state.canUnmerge
			}
			: null
	};
}

/**
 * 右クリック時点の結合操作対象を残す。メニュー選択時の DOM には依存しない
 * @param view - エディタ
 * @param event - マウス
 * @returns 右クリック時点の結合操作対象を残す。メニュー選択時の DOM には依存しない。無ければ null
 */
export function snapshotTableMergeActionFromEvent(view: EditorView, event: MouseEvent): TableMergeMenuSnapshot | null {
	// 右クリック位置の表と結合可否。表の外は null
	const resolved = resolveTableMergeTarget(view, event);
	// 表の外では結合対象を残さない
	if (!resolved) {
		return null;
	}

	// メニュー選択後も使う、固定した結合対象
	return {
		// 表の開始
		tableFrom: resolved.data.tableFrom,
		// 結合する矩形
		rect: resolved.state.rect,
		// 結合できるか
		canMerge: resolved.state.canMerge,
		// 結合を解除できるか
		canUnmerge: resolved.state.canUnmerge
	};
}

/** コンテキストメニュー表示中に固定したセル範囲から、結合可否を返す */
export function getTableMergeActionStateFromEvent(view: EditorView, event: MouseEvent): TableMergeActionState | null {
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
export function resolveTableMergeTargetFromParts(state: EditorState, tableFrom: number, selected: TableSelectionRect | null, clicked: TableCellPosition | null): { data: TableData; state: TableMergeActionState } | null {
	// 開始が整数でない位置は表にできない
	if (!Number.isInteger(tableFrom)) {
		return null;
	}

	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(state, tableFrom);
	// 文書に表が無ければ結合対象を決められない
	if (!tableNode) {
		return null;
	}

	// いまの文書から取り直した表
	const data = extractTableData(state, tableNode);
	// 選択かクリックから決めた矩形。範囲が無ければ null
	const rect = resolveTableMergeRect(data, selected, clicked);
	// 矩形が無いセルは結合操作の対象にしない
	if (!rect) {
		return null;
	}

	// 表データと、その矩形の結合可否
	return {
		// 取り直した表
		data,
		// 結合と解除の可否
		state: getTableMergeActionState(data, rect)
	};
}

/**
 * セル結合または解除を文書へ書く
 * @param view - エディタ
 * @param event - マウス
 * @param action - 操作
 * @returns セル結合または解除を文書へ書くなら true
 */
export function applyTableMergeSnapshot(view: EditorView, snapshot: Pick<TableMergeMenuSnapshot, 'tableFrom' | 'rect'>, action: 'merge' | 'unmerge'): boolean {
	// 読み取り専用では結合を変えない
	if (view.state.readOnly) {
		return false;
	}

	persistEditingTableCellsAt(view, snapshot.tableFrom);
	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, snapshot.tableFrom);
	// 表が文書に無ければ結合を書かない
	if (!tableNode) {
		return false;
	}

	// いまの文書から取り直した表
	const data    = extractTableData(view.state, tableNode);
	// 結合か解除のセル置換。範囲が無ければ null
	const changes = action === 'merge' ? buildMergeTableCellsChanges(data, snapshot.rect) : buildUnmergeTableCellsChanges(data, snapshot.rect);
	// 変更が無い、または空なら文書を変えない。どちらか一方でも false
	if (!changes || changes.length === 0) {
		return false;
	}

	// 結合後にフォーカスを戻す左上セル
	const origin = {
		// 矩形の開始行
		row: snapshot.rect.startRow,
		// 矩形の開始列
		column: snapshot.rect.startColumn
	};
	// セル範囲の置換。結合と解除で履歴名を分ける
	view.dispatch({
		// 各セル範囲の置換
		changes: changes.map((change) => ({
			// セルの開始
			from: change.from,
			// セルの終端
			to: change.to,
			// 結合または解除後のソース
			insert: change.insert
		})),
		// 結合か解除の履歴名
		userEvent: action === 'merge' ? 'input.table.merge' : 'input.table.unmerge'
	});
	clearRenderedTableSelection(view, data.tableFrom);
	restoreTableCellFocus(view, data.tableFrom, origin, 0, false);
	return true;
}

/** クリック時点の選択範囲を固定し、再描画後も同じセルへ結合操作を適用する */
export function applyTableMergeAction(view: EditorView, event: MouseEvent, action: 'merge' | 'unmerge'): boolean {
	// 右クリック時点の結合対象。表の外は null
	const snapshot = snapshotTableMergeActionFromEvent(view, event);
	// 対象が無ければ文書を変えない
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
export function applyTableAlignSnapshot(view: EditorView, snapshot: Pick<TableMergeMenuSnapshot, 'tableFrom' | 'rect'>, patch: TableAlignPatch): boolean {
	// 読み取り専用では配置を変えない
	if (view.state.readOnly) {
		return false;
	}

	persistEditingTableCellsAt(view, snapshot.tableFrom);
	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, snapshot.tableFrom);
	// 表が文書に無ければ配置を書かない
	if (!tableNode) {
		return false;
	}

	// いまの文書から取り直した表
	const data    = extractTableData(view.state, tableNode);
	// 矩形へ配置を書いたセル置換。対象が無ければ null
	const changes = buildAlignTableCellsChanges(data, snapshot.rect, patch);
	// 変更が無い、または空なら文書を変えない。どちらか一方でも false
	if (!changes || changes.length === 0) {
		return false;
	}

	// 表全体を 1 区間で置き換える配置の入力
	view.dispatch({
		// セル変更を表全体の 1 置換に畳んだもの
		changes: collapseTableDocumentChanges(view.state.doc.sliceString(data.tableFrom, data.tableTo), data.tableFrom, data.tableTo, changes),
		// 配置変更として履歴に残す
		userEvent: 'input.table.align'
	});
	// 置換後の表開始。表が見つからなければスナップショットの開始
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
export function collapseTableDocumentChanges(tableText: string, tableFrom: number, tableTo: number, changes: TableDocumentChange[]): TableDocumentChange {
	// セル変更を後ろから当てた表ソース。開始時は元の表
	let insert    = tableText;
	// 後ろの変更から当てる並び。前の位置がずれない
	const ordered = [...changes].sort((left, right) => right.from - left.from);
	for (const change of ordered) {
		// 表ソース内の開始。表の前は負になり得る
		const from = change.from - tableFrom;
		// 表ソース内の終端
		const to   = change.to - tableFrom;
		insert     = insert.slice(0, from) + change.insert + insert.slice(to);
	}

	// 表全体を 1 区間で置き換える変更
	return {
		// 表の開始
		from: tableFrom,
		// 表の終端
		to: tableTo,
		// セル変更を当てた表ソース
		insert
	};
}

/**
 * いま描画されている表へ、文書上の配置クラスを付け直す
 * ウィジェット再利用では `eq` が同じだと `updateDOM` が呼ばれず、プレビューだけ古いまま残る
 * @param view - エディタ
 * @param tableFrom - 表開始位置
 */
export function syncRenderedTableAlignment(view: EditorView, tableFrom: number): void {
	// 描画中の表。位置がずれていても拾う。無ければ null
	const wrap = findRenderedTableWrap(view, tableFrom);
	// 描画が無ければクラスを付け直す先が無い
	if (!wrap) {
		return;
	}

	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, tableFrom);
	// 文書に表が無ければ配置を付け直さない
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
	// 内容 DOM とビュー DOM。無い方は除く
	const roots = [view.contentDOM, view.dom].filter((node): node is HTMLElement => Boolean(node));
	for (const root of roots) {
		// 開始位置が一致する表。querySelector が無ければ null
		const exact = typeof root.querySelector === 'function' ? root.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`) : null;
		// 位置が一致する表があればそれを返す
		if (exact) {
			return exact;
		}

		// 描画中の表。querySelectorAll が無ければ空
		const wraps = typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll<HTMLElement>('.cm-md-table-wrap')] : [];
		// 開始が一致するか、開始と終端の間に位置を含む表
		const found = wraps.find((candidate) => {
			// dataset の開始。数値でなければ NaN
			const from = Number(candidate.dataset.tableFrom);
			// dataset の終端。数値でなければ NaN
			const to   = Number(candidate.dataset.tableTo);
			return from === tableFrom || (Number.isInteger(from) && Number.isInteger(to) && from <= tableFrom && tableFrom < to);
		});
		// 範囲に入る表があればそれを返す
		if (found) {
			return found;
		}

		// 表が 1 つだけなら、位置がずれていてもその表を拾う
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
		// dataset の行と列。数値でなければ NaN
		const position = {
			// 見出しは 0
			row: Number(cell.dataset.tableRow),
			// 列番号。0 始まり
			column: Number(cell.dataset.tableColumn)
		};
		// その位置のセルソース。範囲外は null
		const source   = getTableCellSource(data, position);
		// ソースが無い、または行か列が整数でないセルは飛ばす。どれか一つが欠けても付けない
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
export function applyTableAlignAction(view: EditorView, event: MouseEvent, patch: TableAlignPatch): boolean {
	// 右クリック時点の結合対象。表の外は null
	const snapshot = snapshotTableMergeActionFromEvent(view, event);
	// 対象が無ければ文書を変えない
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
export function persistTableLayout(view: EditorView, tableFrom: number, layout: TableLayout, hit: TableResizeHit): boolean {
	// 読み取り専用、または開始が整数でないときは寸法を書かない。どちらか一方でも false
	if (view.state.readOnly || !Number.isInteger(tableFrom)) {
		return false;
	}

	// 開始位置を含む表。無ければ null
	const tableNode = findTableNodeAt(view.state, tableFrom);
	// 表が無い、または開始が表の外なら書かない。どちらか一方でも false
	if (!tableNode || tableFrom < tableNode.from || tableFrom >= tableNode.to) {
		return false;
	}

	// いまの文書から取り直した表
	const data                  = extractTableData(view.state, tableNode);
	// いま左上セルに書いてある幅と高さ
	const current               = readTableLayout(data);
	// 操作した罫線の軸だけ新しい寸法にし、もう一方は現状を残す
	const next: TableSizeLayout =
		hit.kind === 'col'
			? {
				// ドラッグした列幅
				widths: layout.widths,
				// 行高は現状のまま
				heights: current.heights
			}
			: {
				// 列幅は現状のまま
				widths: current.widths,
				// ドラッグした行高
				heights: layout.heights
			};
	// 左上セルへ寸法を戻す置換。書けなければ null
	const change                = buildTableLayoutChange(data, next);
	// 変更を作れなければ文書を変えない
	if (!change) {
		return false;
	}

	forgetTableLayout(getTableLayoutKey(data.tableFrom, getTableColumnCount(data)));
	// 左上セルの範囲を、寸法付きソースで置き換える
	view.dispatch({
		// セル範囲の置換
		changes: {
			// セルの開始
			from: change.from,
			// セルの終端
			to: change.to,
			// 寸法を含むソース
			insert: change.insert
		},
		// 罫線ドラッグとして履歴に残す
		userEvent: 'input.table.resize'
	});
	return true;
}

/**
 * 右クリック位置から、結合または解除の対象を決める
 * @param view - 構文木と表位置を読むエディタ
 * @param event - 右クリック。対象セルが取れなければ null
 * @returns 表データと結合可否。表の外なら null
 */
function resolveTableMergeTarget(view: EditorView, event: MouseEvent): { data: TableData; state: TableMergeActionState } | null {
	// 右クリック先の枠とセル。表の外は null
	const parts = readTableMergeEventParts(event);
	// 表の外では結合対象を決められない
	if (!parts) {
		return null;
	}

	// 見えている枠の現在の開始。dataset の古い位置より優先する。取れなければ null
	const tableFrom = resolveTableFromForPersist(view, parts.wrap);
	// 枠から表が取れないときは結合対象にしない
	if (tableFrom === null) {
		return null;
	}

	return resolveTableMergeTargetFromParts(view.state, tableFrom, parts.selected, parts.clicked);
}

/**
 * 右クリック先の表枠とセル位置を読む
 * 表の開始位置は、呼び出し側が見えている枠から取り直す
 * @param event - マウス
 * @returns 右クリック先の表枠とセル位置。表の外なら null
 */
function readTableMergeEventParts(event: MouseEvent): { wrap: HTMLElement; selected: TableSelectionRect | null; clicked: TableCellPosition | null } | null {
	// クリック対象の要素。テキストノードなら親。それ以外は null
	const start = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
	// 対象が属する表。表の外は null
	const wrap  = start?.closest<HTMLElement>('.cm-md-table-wrap') ?? null;
	// 表が無いときは位置を返さない
	if (!wrap) {
		return null;
	}

	// クリックしたセル。セルの外は null
	const cell    = start?.closest<HTMLElement>('[data-table-row][data-table-column]') ?? null;
	// 行が整数のセルだけ位置にする。セルが無ければ null
	const clicked =
		cell && Number.isInteger(Number(cell.dataset.tableRow))
			? {
				// 見出しは 0
				row: Number(cell.dataset.tableRow),
				// 列番号。0 始まり
				column: Number(cell.dataset.tableColumn)
			}
			: null;
	// 表枠、矩形選択、クリックしたセル
	return {
		// 見えている表。開始位置は呼び出し側が取り直す
		wrap,
		// ドラッグ選択。無ければ null
		selected: readTableSelectionRect(wrap),
		// クリックしたセル。セルの外は null
		clicked
	};
}

/**
 * いま描画されている表の編集中セルを文書へ書いて閉じる
 * @param view - エディタ
 * @param tableFrom - 表開始位置
 */
function persistEditingTableCellsAt(view: EditorView, tableFrom: number): void {
	// 開始位置の表。描画が無ければ null
	const wrap = view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${tableFrom}"]`);
	// 描画があるときだけ、編集中セルを文書へ書いて閉じる
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
	return cellAlignmentClassNames(parseCellSpan(sourceText)).split(/\s+/).filter(Boolean).sort().join(' ');
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
		// dataset の行と列。数値でなければ NaN
		const position = {
			// 見出しは 0
			row: Number(cell.dataset.tableRow),
			// 列番号。0 始まり
			column: Number(cell.dataset.tableColumn)
		};
		// その位置のセルソース。範囲外は null
		const source   = getTableCellSource(data, position);
		// ソースが無い、または行か列が整数でないセルは比較しない。どれか一つが欠けても飛ばす
		if (!source || !Number.isInteger(position.row) || !Number.isInteger(position.column)) {
			continue;
		}

		// 配置クラスが文書と違うセルがあれば、表を作り直す
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
function tableDomMatchesOccupancy(dom: HTMLElement, occupancy: ReturnType<typeof buildTableOccupancy>): boolean {
	// 描画中のセル。行と列を持つものだけ
	const cells                                                                             = [...dom.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')];
	// 結合で覆われていないマス。DOM に出るセル
	const visible: Array<{ row: number; column: number; colspan: number; rowspan: number }> = [];
	for (let row = 0; row < occupancy.rowCount; row += 1) {
		for (let column = 0; column < occupancy.columnCount; column += 1) {
			// このマスの占有。行が短ければ undefined
			const item = occupancy.cells[row]?.[column];
			// マスが無い、または結合で覆われたマスは DOM に出ない。どちらか一方でも飛ばす
			if (!item || item.covered) {
				continue;
			}

			// DOM に出るマスの位置と結合
			visible.push({
				// 行番号。見出しは 0
				row,
				// 列番号。0 始まり
				column,
				// 横結合。1 なら単一列
				colspan: item.colspan,
				// 縦結合。1 なら単一行
				rowspan: item.rowspan
			});
		}
	}

	// 描画セル数と占有の可視マス数が違うときは作り直す
	if (cells.length !== visible.length) {
		return false;
	}

	return visible.every((item) => {
		// 同じ行と列の描画セル。無ければ undefined
		const cell = cells.find((candidate) => Number(candidate.dataset.tableRow) === item.row && Number(candidate.dataset.tableColumn) === item.column);
		// 位置が一致するセルが無いときは占有と違う
		if (!cell) {
			return false;
		}

		// th/td として結合数を読めるか。テスト環境では false
		const isTableCell = typeof HTMLTableCellElement !== 'undefined' && cell instanceof HTMLTableCellElement;
		// 横結合。th/td でなければ 1
		const colSpan     = isTableCell ? cell.colSpan : 1;
		// 縦結合。th/td でなければ 1
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
		// 別種のウィジェットは同じ表として再利用しない
		if (!(other instanceof TableWidget)) {
			return false;
		}

		return other.languageGeneration === this.languageGeneration && other.data.tableFrom === this.data.tableFrom && getTableDataIdentity(other.data) === getTableDataIdentity(this.data);
	}

	/**
	 * 同じ表として再利用するとき、位置と非編集セルだけ更新する
	 * 編集中セルは IME / 改行用に DOM を維持する
	 * @param dom - 既存 DOM
	 * @param view - エディタ
	 * @param previous - この DOM を作った表ウィジェット。別の表なら再利用しない
	 * @returns 同じ表として再利用するとき、位置と非編集セルだけ更新するなら true
	 */
	updateDOM(dom: HTMLElement, view: EditorView, previous?: WidgetType): boolean {
		// 表ラッパーでない DOM は再利用しない
		if (!dom?.classList?.contains('cm-md-table-wrap')) {
			return false;
		}

		// この DOM を作った表。別種のウィジェットなら null
		const previousTable = previous instanceof TableWidget ? previous : null;
		// この DOM を作った表の開始。表でなければ undefined
		const previousFrom  = previousTable?.data.tableFrom;
		// 別の表の DOM は、選択ハイライトごと乗り移るので使わない。テストの仮ビューは plugin を持たない
		if (typeof previousFrom === 'number' && typeof view.plugin === 'function') {
			// この表示更新の文書差分。文書が変わっていなければ null
			const changes = view.plugin(latestTableDocChanges)?.changes ?? null;
			// 差分を経ても同じ表でなければ、この DOM は使わない
			if (!tableStartNamesSameTable(view.state, changes, previousFrom, this.data.tableFrom)) {
				return false;
			}
		}

		// 開始位置を含む表。無ければ null
		const tableNode = findTableNodeAt(view.state, this.data.tableFrom);
		// 文書から取り直した表。表が無ければウィジェットが持つデータ
		const data      = tableNode ? extractTableData(view.state, tableNode) : this.data;
		// 結合の増減でセル数が違うときは作り直す
		if (!tableDomMatchesOccupancy(dom, buildTableOccupancy(data))) {
			return false;
		}

		// 配置クラスが文書と違うときは作り直す
		if (!tableDomMatchesAlignment(dom, data)) {
			return false;
		}

		dom.dataset.tableFrom = String(data.tableFrom);
		dom.dataset.tableTo   = String(data.tableTo);
		for (const cell of dom.querySelectorAll<HTMLElement>('[data-table-row][data-table-column]')) {
			// dataset の行と列。数値でなければ NaN
			const position = {
				// 見出しは 0
				row: Number(cell.dataset.tableRow),
				// 列番号。0 始まり
				column: Number(cell.dataset.tableColumn)
			};
			// その位置のセルソース。範囲外は null
			const source   = getTableCellSource(data, position);
			// ソースが無い、または行か列が整数でないセルは更新しない。どれか一つが欠けても飛ばす
			if (!source || !Number.isInteger(position.row) || !Number.isInteger(position.column)) {
				continue;
			}

			// ソース文字列が前回の表示と違うか。同じなら DOM を埋め直さない
			const changed             = cell.dataset.source !== source.text;
			cell.dataset.inlineRanges = JSON.stringify(source.inlineRanges);
			applyCellAlignmentClasses(cell, source.text);
			cell.dataset.source       = source.text;
			cell.dataset.editableText = source.editableText;
			// 編集中セルは、入力中の DOM を維持する。文書だけが戻ったときだけ中身を合わせる
			if (cell.dataset.editing === 'true') {
				// いまの DOM を文書へ書いたときのソース。セルが無ければ null
				const liveChange = buildTableCellChange(data, position, readTableCellEditableValue(cell));
				// 文書と違うときだけ、取り消し後の本文へ戻す。同じならキャレットを崩さない
				if (shouldRefreshEditingTableCell(liveChange?.insert ?? null, source.text)) {
					// dataset のインライン範囲。壊れた JSON は空
					let inlineRanges: TableCellInlineRange[] = [];
					try {
						inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
					} catch {
						inlineRanges = [];
					}

					fillEditableTableCellContent(cell, source.editableText, inlineRanges);
					// フォーカスがこのセルにあるときだけ、戻した本文の末尾へキャレットを置く
					const active = cell.ownerDocument.activeElement;
					if (active instanceof Node && (active === cell || cell.contains(active))) {
						setCellSelection(cell, source.editableText.length, false);
					}
				}
				continue;
			}

			// ソースが同じセルは表示を作り直さない
			if (!changed) {
				continue;
			}

			// 見出しは headers、本体は行配列。セルが無ければ undefined
			const nodes = position.row === 0 ? data.headers[position.column] : data.rows[position.row - 1]?.[position.column];
			// 表示ノードが無いセルは埋め直さない
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
		// 表全体のラッパー。セル編集の外では編集不可
		const wrap     = document.createElement('div');
		wrap.className = 'cm-md-table-wrap';
		wrap.setAttribute('contenteditable', 'false');
		wrap.dataset.tableFrom = String(this.data.tableFrom);
		wrap.dataset.tableTo   = String(this.data.tableTo);

		// 表要素
		const table               = document.createElement('table');
		table.className           = 'cm-md-table';
		// 見出しと各行の最大列数
		const columnCount         = getTableColumnCount(this.data);
		// 結合の占有。覆われたマスはセルを出さない
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
		const createCell = (tagName: 'th' | 'td', nodes: TableCellNode[], source: TableCellSource | undefined, position: TableCellPosition): HTMLTableCellElement => {
			// th または td
			const cell = document.createElement(tagName);

			cell.dataset.tableRow     = String(position.row);
			cell.dataset.tableColumn  = String(position.column);
			cell.dataset.source       = source?.text ?? '';
			cell.dataset.editableText = source?.editableText ?? '';
			cell.dataset.inlineRanges = JSON.stringify(source?.inlineRanges ?? []);
			cell.contentEditable      = 'false';
			cell.spellcheck           = false;
			cell.setAttribute('aria-label', `表 ${position.row + 1} 行 ${position.column + 1} 列`);
			fillTableCellContent(cell, nodes, view);
			applyRememberedWidthToCell(cell, nodes, position);
			/**
			 * セル内画像へ、表の view から直接書き戻す処理を束縛する
			 * @param cellNodes - セル AST
			 */
			const bindCellImagePersist = (cellNodes: TableCellNode[]): void => {
				// 読み取り専用では幅を書き戻さない
				if (view.state.readOnly) {
					return;
				}

				// セル内の画像ラッパー。画像が無ければ null
				const imageWrap = cell.querySelector<HTMLElement>('.cm-md-image-wrap');
				// 画像が無いセルは幅の書き戻しを束縛しない
				if (!imageWrap) {
					return;
				}

				bindImageWrapEditorView(imageWrap, view);
				bindImageResizePersister(imageWrap, (width) => writeTableCellImageWidth(view, this.data, position, imageWrap, cellNodes, width));
			};

			bindCellImagePersist(nodes);
			// 画像の上から入った操作では、直後のフォーカスで編集を開かない
			let skipEditFromImage = false;
			// 画像の上では編集へ入らず、複数選択中の右クリックは選択を維持する
			cell.addEventListener('mousedown', (event) => {
				// 押した要素。画像ラッパーの中かどうか
				const target      = event.target;
				skipEditFromImage = target instanceof Element && Boolean(target.closest('.cm-md-image-wrap'));
				// 画像の上ではセル選択や編集へイベントを渡さない
				if (skipEditFromImage) {
					event.stopPropagation();
					return;
				}
				// 複数セル選択中の右クリックでは、選択を消さずフォーカス移動も抑止する
				if (shouldPreserveTableCellSelectionOnMouseDown(event, Boolean(readTableSelectionRect(wrap)))) {
					event.preventDefault();
					return;
				}
				// 左クリック以外、または Shift 付きは単一セルの編集位置へ同期しない
				if (!shouldSyncTableCellEditorOnMouseDown(event)) {
					return;
				}

				// クリックのあいだだけ入力を受け付ける。普段は編集不可で、取り消しのキャレットを吸わない
				if (!view.state.readOnly) {
					cell.contentEditable = 'true';
				}
				// CodeMirror のカーソル同期で再描画される前に、直前の表選択表示を確実に消す
				clearTableSelectionRect(wrap, table);
				clearTableStructureSelection(wrap, table);
				syncTableCellEditorSelection(view, this.data, position);
			});

			// ソースが無い、または読み取り専用のセルは編集イベントを付けない。どちらか一方でも戻る
			if (!source || view.state.readOnly) {
				return cell;
			}

			// 画像リサイズ後に、幅をソースと dataset へ書き戻す
			cell.addEventListener('tms-mde-table-image-resized', (event: Event) => {
				// イベントの幅と、すでに書いたか。detail が無ければ undefined
				const detail = (event as CustomEvent<{ width?: number; persisted?: boolean }>).detail;
				// 書き戻す幅（px）。数値でなければ使わない
				const width  = detail?.width;
				// 幅が数値でない、または有限でないときはソースを変えない。どちらか一方でも戻る
				if (typeof width !== 'number' || !Number.isFinite(width)) {
					return;
				}

				// セル内の画像ラッパー。画像が無ければ null
				const imageWrap = cell.querySelector<HTMLElement>('.cm-md-image-wrap');
				// 画像が無いセルは幅を書けない
				if (!imageWrap) {
					return;
				}

				/**
				 * 束縛済み view からソースへ書く
				 * @returns 書けたか
				 */
				const persist = (): boolean => writeTableCellImageWidth(view, this.data, position, imageWrap, nodes, width);

				// すでに書いた、または今書けたときだけ dataset を合わせる。どちらか一方でも入る
				if (detail?.persisted || persist()) {
					// セルが属する表。表の外なら null
					const tableWrap = cell.closest<HTMLElement>('.cm-md-table-wrap');
					// 表があるときだけ、終端 dataset を新しい文字数に合わせる
					if (tableWrap) {
						tableWrap.dataset.tableTo = String(this.data.tableTo);
					}

					// 幅を入れたセルソース。画像が無ければ空文字
					const next = replaceImageWidthInCellText(cell.dataset.source ?? '', width, true);
					// 書き戻し文字列があるときだけ dataset を更新する
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

			// IME 変換中か。変換中は文書へ書かない
			let composing                = false;
			// 変換確定の直後か。次の input の履歴名に使う
			let compositionCommitPending = false;
			// keydown で取り消しを処理したか。続く beforeinput では重ねて取り消さない
			let historyShortcutHandled   = false;
			// 文書へ書いているあいだの再入回数。0 なら書き込み中ではない
			let persistGuard             = 0;
			/**
			 * セル値だけを文書へ書く。フォーカスは動かさない
			 * @param userEvent - CodeMirror のユーザーイベント名
			 * @returns 書いたか
			 */
			const persistCellValue       = (userEvent: string): boolean => {
				// 編集中でない、または変換中は文書を変えない。どちらか一方でも false
				if (cell.dataset.editing !== 'true' || composing) {
					return false;
				}

				// 開始位置を含む表。無ければ null
				const tableNode = findTableNodeAt(view.state, this.data.tableFrom);
				// 表が文書に無ければセル値を書けない
				if (!tableNode) {
					return false;
				}

				// いまの文書から取り直した表
				const data       = extractTableData(view.state, tableNode);
				// 同じ位置の現ソース。範囲外は null
				const liveSource = getTableCellSource(data, position);
				// 編集 DOM から読んだ文字列
				const value      = readTableCellEditableValue(cell);
				// 文書へ書く変更。セルが無ければ null
				const change     = buildTableCellChange(data, position, value);
				// 変更が無い、ソースが無い、中身が同じ、のどれかでは書かない
				if (!change || !liveSource || change.insert === liveSource.text) {
					return false;
				}

				forgetCellImageWidthIfSourceDropped(liveSource.text, change.insert, position);
				persistGuard += 1;
				try {
					// セル範囲を、編集結果で置き換える
					view.dispatch({
						// セル範囲の置換
						changes: change,
						// 呼び出し元が渡した履歴名
						userEvent
					});
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
				// 書く前のキャレット。再描画後に戻す
				const caret = getCellCaretOffset(cell);
				// 文書が変わらなければキャレットも動かさない
				if (!persistCellValue(userEvent)) {
					return;
				}

				// セルがまだ文書にあり、編集中ならその場でキャレットを戻す。どちらかが欠けると表の外から戻す
				if (cell.isConnected && cell.dataset.editing === 'true') {
					cell.focus({ preventScroll: true });
					setCellSelection(cell, caret, false);
					return;
				}

				restoreTableCellFocus(view, this.data.tableFrom, position, caret, false);
			};

			// ボタンを離したとき、編集中ならキャレット位置の記法を出す
			cell.addEventListener('mouseup', () => {
				// 編集中のセルだけ記法の表示を切り替える
				if (cell.dataset.editing === 'true') {
					updateTableCellInlineMarks(cell);
				}
			});
			// キーを離したとき、取り消しの二重処理を消し、キャレット位置の記法を出す
			cell.addEventListener('keyup', () => {
				historyShortcutHandled = false;
				updateTableCellInlineMarks(cell);
			});
			// ダブルクリックでは画像セルもソース編集へ入り、中身を全選択する
			cell.addEventListener('dblclick', (event) => {
				event.preventDefault();
				event.stopPropagation();
				cell.dataset.forceImageEdit = 'true';
				activateTableCell(cell, view);
				setCellSelection(cell, 0, true);
			});
			// フォーカスが入ったとき、プレビュー位置を編集文字列上の位置へ戻して編集を開く
			cell.addEventListener('focus', () => {
				// すでに編集中、画像から入った、画像だけのセル、のどれかでは編集を開かない
				if (cell.dataset.editing === 'true' || skipEditFromImage || cellShowsOnlyImage(cell)) {
					skipEditFromImage = false;
					return;
				}

				window.setTimeout(() => {
					// 待ちのあいだに編集へ入った、画像操作だった、画像だけ、のどれかでは開かない
					if (cell.dataset.editing === 'true' || skipEditFromImage || cellShowsOnlyImage(cell)) {
						skipEditFromImage = false;
						return;
					}

					// dataset のインライン範囲。壊れた JSON は空
					let inlineRanges: TableCellInlineRange[] = [];
					try {
						inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
					} catch {
						inlineRanges = [];
					}

					// 編集用文字列。dataset が無ければソース、それも無ければ空文字
					const editableText   = cell.dataset.editableText ?? cell.dataset.source ?? '';
					// プレビュー上のキャレット。記法は数えない
					const previewOffset  = getCellCaretOffset(cell, true);
					// 記法を含む編集文字列上の位置
					const editableOffset = getTableCellEditableOffsetFromPreview(editableText, inlineRanges, previewOffset);
					activateTableCell(cell, view);
					setCellSelection(cell, editableOffset, false);
				}, 0);
			});
			// フォーカスが外れたとき、編集中なら文書へ書いてプレビューへ戻す
			cell.addEventListener('blur', () => {
				// 取り消しで DOM が捨てられたときは、編集中の文字列を文書へ戻さない
				if (cell.dataset.skipHistoryPersist === 'true') {
					cell.dataset.editing = 'false';
					cell.classList.remove('cm-md-table-cell-editing');
					return;
				}

				// 文書へ書いている途中なら、書き終わりとフォーカス移動を待って閉じる
				if (persistGuard > 0) {
					window.queueMicrotask(() => {
						// まだ書き込み中、またはセルへフォーカスが戻っているときは閉じない。どちらか一方でも戻る
						if (persistGuard > 0 || cell.ownerDocument.activeElement === cell) {
							return;
						}

						persistAndDeactivateTableCell(view, cell, this.data.tableFrom);
					});
					return;
				}

				// 閉じる直前まで編集中だったか。プレビューへ戻すかはこれで決める
				const wasEditing = cell.dataset.editing === 'true';
				// 編集中だったセルだけ、変換状態を消して文書へ書く
				if (wasEditing) {
					composing                = false;
					compositionCommitPending = false;
					persistCellValue('input.type');
				}

				cell.dataset.editing = 'false';
				cell.classList.remove('cm-md-table-cell-editing');
				// 編集を閉じたセルは入力を受けない。取り消しのキャレットがセルへ入らない
				cell.contentEditable = 'false';
				// 編集していたセルだけ、文書の表示へ戻して画像幅を付け直す
				if (wasEditing) {
					// 文書から取り直した表示ノード。セルが無ければ null
					const fresh = getCurrentTableCellNodes(view.state, this.data.tableFrom, position);
					// 取り直せなければ、セル生成時のノードを使う
					const next  = fresh ?? nodes;
					fillTableCellContent(cell, next, view);
					applyRememberedWidthToCell(cell, next, position);
					bindCellImagePersist(next);
					notifyTableGeometryChange(cell);
				}
			});
			// 変換開始では文書へ書かず、確定待ちも消す
			cell.addEventListener('compositionstart', () => {
				composing                = true;
				compositionCommitPending = false;
			});
			// 変換確定のあと、次の変換が始まっていなければ文書へ書く
			cell.addEventListener('compositionend', () => {
				composing                = false;
				compositionCommitPending = true;
				window.setTimeout(() => {
					// 待ちのあいだに次の変換が始まっていれば、まだ書かない
					if (composing) {
						return;
					}

					compositionCommitPending = false;
					dispatchCellValue('input.type.compose');
				}, 0);
			});
			// 編集中の貼り付けはプレーンテキストだけを挿入する
			cell.addEventListener('paste', (event) => {
				// 編集中でないセルは貼り付けを横取りしない
				if (cell.dataset.editing !== 'true') {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				// クリップボードのプレーンテキスト。取れなければ空文字
				const pasted = event.clipboardData?.getData('text/plain') ?? '';
				cell.ownerDocument.execCommand('insertText', false, pasted);
			});
			// 入力のたびに文書へ書く。変換中は確定まで待つ
			cell.addEventListener('input', (event) => {
				// InputEvent として変換中フラグを見る
				const inputEvent = event as InputEvent;
				// 変換中、または変換中イベントでは文書へ書かない。どちらか一方でも戻る
				if (composing || inputEvent.isComposing) {
					return;
				}

				// ブラウザの取り消しは、文書へ書き戻さず、文書の表示へ合わせる
				if (inputEvent.inputType === 'historyUndo' || inputEvent.inputType === 'historyRedo') {
					// 表の開始。dataset が無ければ NaN
					const tableFrom = Number(cell.closest<HTMLElement>('.cm-md-table-wrap')?.dataset.tableFrom);
					// 表の開始が整数のときだけ、文書の本文をセルへ書く
					if (Number.isInteger(tableFrom)) {
						syncEditingCellFromDocument(view, cell, tableFrom, position);
					}
					return;
				}

				// 文書の取り消し中に起きた入力は、編集 DOM を文書へ書き戻さない
				if (cell.dataset.skipHistoryPersist === 'true') {
					return;
				}

				// 変換確定の直後だけ compose の履歴名。それ以外は通常入力
				const userEvent          = compositionCommitPending ? 'input.type.compose' : 'input.type';
				compositionCommitPending = false;
				dispatchCellValue(userEvent);
			});
			// ブラウザの取り消しは contenteditable の履歴を使う。文書の履歴と二重にしない
			cell.addEventListener('beforeinput', (event) => {
				// InputEvent 以外は取り消しの入力種を持たない
				const inputEvent = event as InputEvent;
				// 取り消しとやり直し以外は、文字入力の beforeinput に任せる
				if (inputEvent.inputType !== 'historyUndo' && inputEvent.inputType !== 'historyRedo') {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				// keydown が先に文書を戻していれば、ここでは重ねない
				if (historyShortcutHandled) {
					historyShortcutHandled = false;
					return;
				}

				// keydown が来ない環境では、ここで文書の履歴を動かす
				const command = inputEvent.inputType === 'historyUndo' ? undo : redo;
				runTableCellDocumentHistory(view, cell, this.data.tableFrom, position, command);
			});
			// 全選択、改行、取り消し、上下、Tab と Enter をセル側で処理する
			cell.addEventListener('keydown', (event) => {
				// 変換中のキーはセル移動や取り消しにしない。どちらか一方でも戻る
				if (event.isComposing || composing) {
					return;
				}

				// セル内の全選択は、表全体のソース選択へ渡さない
				if (isTableCellSelectAllKey(event)) {
					event.preventDefault();
					event.stopPropagation();
					setCellSelection(cell, 0, true);
					return;
				}

				// Shift+Enter はセル内のソフト改行にする
				if (isTableCellSoftBreakKey(event)) {
					event.preventDefault();
					event.stopPropagation();
					// まだ編集中でなければ、プレビュー位置を編集位置へ戻してから改行する
					if (cell.dataset.editing !== 'true') {
						// dataset のインライン範囲。壊れた JSON は空
						let inlineRanges: TableCellInlineRange[] = [];
						try {
							inlineRanges = JSON.parse(cell.dataset.inlineRanges ?? '[]') as TableCellInlineRange[];
						} catch {
							inlineRanges = [];
						}

						// プレビュー上のキャレット。記法は数えない
						const previewOffset  = getCellCaretOffset(cell, true);
						// 記法を含む編集文字列上の位置
						const editableOffset = getTableCellEditableOffsetFromPreview(cell.dataset.editableText ?? cell.dataset.source ?? '', inlineRanges, previewOffset);
						activateTableCell(cell, view);
						setCellSelection(cell, editableOffset, false);
					}

					// 改行を入れられたときだけ、その文字列を文書へ書く
					if (insertTableCellLineBreak(cell)) {
						dispatchCellValue('input.type');
					}
					return;
				}

				// Ctrl か Meta。どちらか一方でも修飾あり
				const modKey = event.ctrlKey || event.metaKey;
				// Alt 無しの Ctrl+Z か Ctrl+Shift+Z は、セル内ではなく文書の取り消しにする。どれか一つが欠けても入らない
				if (modKey && !event.altKey && event.key.toLowerCase() === 'z') {
					event.preventDefault();
					event.stopPropagation();
					// 続く beforeinput では、同じ取り消しを重ねない
					historyShortcutHandled = true;
					// Shift 付きはやり直し、無ければ取り消し
					const command          = event.shiftKey ? redo : undo;
					runTableCellDocumentHistory(view, cell, this.data.tableFrom, position, command);
					return;
				}

				// Alt 無しの Ctrl+Y は文書のやり直しにする。どれか一つが欠けても入らない
				if (modKey && !event.altKey && event.key.toLowerCase() === 'y') {
					event.preventDefault();
					event.stopPropagation();
					// 続く beforeinput では、同じやり直しを重ねない
					historyShortcutHandled = true;
					runTableCellDocumentHistory(view, cell, this.data.tableFrom, position, redo);
					return;
				}

				// 修飾なしの上下。左右や修飾付きは null
				const verticalNavigation = getTableCellVerticalNavigation(this.data, position, event);
				// 上下キーはセル内の行か、隣セルか、表の外へ移す
				if (verticalNavigation) {
					event.preventDefault();
					event.stopPropagation();
					// セル内の改行を同じ桁で移れたときは、隣セルへ出ない
					if (moveTableCellCaretVertically(cell, verticalNavigation.direction)) {
						return;
					}

					// 隣セルがあるときはそのセルへフォーカスを移す
					if (verticalNavigation.target) {
						restoreTableCellFocus(view, this.data.tableFrom, verticalNavigation.target, getCellCaretOffset(cell, true), false);
						// 隣セルが無く、表の外へも出られないときだけ同じセルへ戻す
					} else if (!moveTableCellFocusOutside(view, this.data.tableFrom, this.data.tableTo, verticalNavigation.direction === 'down')) {
						restoreTableCellFocus(view, this.data.tableFrom, position, getCellCaretOffset(cell, true), false);
					}
					return;
				}

				// Tab と Enter 以外はブラウザのキー処理に任せる。どちらでもないとき戻る
				if (event.key !== 'Tab' && event.key !== 'Enter') {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				// Enter は下、Shift+Tab は前、Tab は次
				const direction = event.key === 'Enter' ? 'down' : event.shiftKey ? 'previous' : 'next';
				// 隣セル。端なら null
				const target    = getAdjacentTableCellPosition(this.data, position, direction);
				// 隣セルがあるときはそのセルを全選択で開く
				if (target) {
					restoreTableCellFocus(view, this.data.tableFrom, target, 0, true);
					return;
				}

				// Tab 以外、または Shift+Tab では空行を足さない。どちらか一方でも戻る
				if (event.key !== 'Tab' || event.shiftKey) {
					return;
				}

				// 最終セルの次に足す空行。列が無ければ null
				const change = buildAppendTableRowChange(view.state, this.data);
				// 空行を作れなければフォーカスも動かさない
				if (!change) {
					return;
				}

				// 表の終端へ空行を足す入力
				view.dispatch({
					// 空行の挿入
					changes: change,
					// 文字入力として履歴に残す
					userEvent: 'input.type'
				});
				restoreTableCellFocus(
					view,
					this.data.tableFrom,
					{
						// 足した行。見出しを 0 とした番号
						row: this.data.rowSources.length + 1,
						// 先頭列
						column: 0
					},
					0,
					true
				);
			});
			return cell;
		};

		// 見出しがある表だけ thead を出す
		if (this.data.headers.length > 0) {
			// 見出し行の要素
			const thead = document.createElement('thead');
			// 見出しの 1 行
			const tr    = document.createElement('tr');
			for (let index = 0; index < columnCount; index += 1) {
				// 結合で覆われた見出し列はセルを出さない
				if (
					isCoveredTableCell(occupancy, {
						// 見出し行
						row: 0,
						// この列
						column: index
					})
				) {
					continue;
				}

				// 見出しセル。ソースが無い列は空
				const cell = createCell('th', this.data.headers[index] ?? [], this.data.headerSources[index], {
					// 見出し行
					row: 0,
					// この列
					column: index
				});
				applyCellSpan(
					cell,
					occupancy,
					{
						// 見出し行
						row: 0,
						// この列
						column: index
					},
					this.data.headerSources[index]?.text ?? ''
				);
				tr.appendChild(cell);
			}

			thead.appendChild(tr);
			table.appendChild(thead);
		}

		// 本体行がある表だけ tbody を出す
		if (this.data.rows.length > 0) {
			// 本体の要素
			const tbody = document.createElement('tbody');
			for (let rowIndex = 0; rowIndex < this.data.rows.length; rowIndex += 1) {
				// この本体行の表示ノード
				const row = this.data.rows[rowIndex]!;
				// 本体の 1 行
				const tr  = document.createElement('tr');
				for (let index = 0; index < columnCount; index += 1) {
					// 見出しを 1 ずらした行と列。結合判定に使う
					const position = {
						// 本体の行。見出しの次が 1
						row: rowIndex + 1,
						// この列
						column: index
					};
					// 結合で覆われたマスはセルを出さない
					if (isCoveredTableCell(occupancy, position)) {
						continue;
					}

					// 本体セル。ソースが無い列は空
					const cell = createCell('td', row[index] ?? [], this.data.rowSources[rowIndex]?.[index], position);
					applyCellSpan(cell, occupancy, position, this.data.rowSources[rowIndex]?.[index]?.text ?? '');
					tr.appendChild(cell);
				}

				tbody.appendChild(tr);
			}

			table.appendChild(tbody);
		}

		wrap.appendChild(table);
		attachTableCellSelection(wrap, table, this.data, view);
		/** 構造ヘッダーの余白切替後にリサイズハンドルを表へ合わせ直す */
		// 列が無いときは何もしない。列があるときだけ実ハンドルの同期に差し替える
		let syncResizeHandles = (): void => undefined;
		// 列がある表だけ、罫線ドラッグを付ける
		if (columnCount > 0) {
			syncResizeHandles = attachTableResize(wrap, table, getTableLayoutKey(this.data.tableFrom, columnCount), {
				// いま左上セルに書いてある幅と高さ
				layout: readTableLayout(this.data),
				// 読み取り専用では書かない。それ以外はドラッグ結果を文書へ書く
				onPersist: view.state.readOnly
					? undefined
					: (layout, hit) => {
						// ドラッグ中にフォーカスがあるセル。表の外なら null
						const activeCell = wrap.ownerDocument.activeElement instanceof HTMLElement ? wrap.ownerDocument.activeElement.closest<HTMLElement>('[data-table-row][data-table-column]') : null;
						// この表の中のセル位置。表の外やセルでなければ null
						const position   =
								activeCell && table.contains(activeCell)
									? {
										// 見出しは 0
										row: Number(activeCell.dataset.tableRow),
										// 列番号。0 始まり
										column: Number(activeCell.dataset.tableColumn)
									}
									: null;
							// 書く前のキャレット。セルが無ければ 0
						const caret      = activeCell && position ? getCellCaretOffset(activeCell) : 0;
						// 書き戻す表の開始。DOM から取れなければ null
						const tableFrom  = resolveTableFromForPersist(view, wrap);
						// 表の開始が取れなければ寸法を書かない
						if (tableFrom === null) {
							return;
						}

						// 寸法を書けて、編集中セルがあるときだけそのセルへフォーカスを戻す。どちらかが欠けても戻さない
						if (persistTableLayout(view, tableFrom, layout, hit) && position) {
							restoreTableCellFocus(view, tableFrom, position, caret, false);
						}
					}
			});
		}
		// 横にはみ出す表のスクロール同期
		const syncHorizontalOverflow = attachTableHorizontalOverflow(wrap, table);
		// 操作した表の選択。別の表や、もう無い範囲なら null
		const initialSelection       = rememberedTableStructureSelection(view, this.data);
		attachTableStructureControls(
			wrap,
			table,
			this.data,
			view,
			() => {
				syncResizeHandles();
				syncHorizontalOverflow();
			},
			initialSelection
		);

		return wrap;
	}

	/**
	 * 行数に応じた推定高さ（ビューポート計測の安定化）
	 * @returns 行数に応じた推定高さ（ビューポート計測の安定化）
	 */
	get estimatedHeight(): number {
		// 見出しを 1 行として数えた行数。見出しが無ければ本体だけ
		const rowCount = this.data.headers.length > 0 ? 1 + this.data.rows.length : this.data.rows.length;
		return Math.max(1, rowCount) * 42 + 40;
	}

	/**
	 * ウィジェットを捨てる直前に、進んでいるスクロール位置を覚えておく
	 * 先頭付近の値では、すでに覚えた途中位置を上書きしない
	 * @param dom - 破棄する表ラッパー
	 */
	destroy(dom: HTMLElement): void {
		// 枠でない DOM はスクロール位置を持たない
		if (!dom?.classList?.contains('cm-md-table-wrap')) {
			return;
		}

		// 表の開始位置。dataset が無ければ空で、記憶先が無い
		const tableFrom = dom.dataset.tableFrom ?? '';
		// 先頭付近なら、再生成前に覚えた途中位置を消さない
		if (dom.scrollTop <= 1 && dom.scrollLeft <= 1) {
			return;
		}

		rememberTableScroll(tableFrom, {
			// 破棄直前の横位置
			left: dom.scrollLeft,
			// 破棄直前の縦位置
			top: dom.scrollTop
		});
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
export function pushTableReplace(entries: DecorationEntry[], from: number, to: number, data: TableData): void {
	// 幅の無い範囲はウィジェットにしない
	if (from >= to) {
		return;
	}

	// 表範囲をウィジェットで置き換える装飾
	entries.push({
		// 表の開始
		from,
		// 表の終端
		to,
		// 複数行をインラインの置換にする装飾
		decoration: Decoration.replace({
			// 表の描画
			widget: new TableWidget(data)
		})
	});
}
