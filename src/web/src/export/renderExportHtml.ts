import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { highlightTree, tags, tagHighlighter } from '@lezer/highlight';
import { isTaskMarkerChecked } from '../editor/checkboxToggle';
import {
	collectCodeHighlightRanges,
	splitInlineCodeLanguageContent,
} from '../editor/codeHighlight';
import {
	extractCodeLanguageName,
	getLoadedCodeLanguage,
	requestCodeLanguage,
} from '../editor/codeLanguage';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { buildOutlineTree, collectOutlineItems, type OutlineItem, type OutlineTreeNode } from '../outline/outline';
import type { CustomDecorationRule, ExportOutlineSettings } from '../types/app';
import { buildCodeFontCss } from '../app/codeFont';
import { extractImageAltAndUrl, extractWikiEmbedPath } from '../livePreview/blockWidgets';
import {
	collectCustomDecorationRangesFromDoc,
	collectCustomDecorationRangesFromText,
	compileCustomDecorationRules,
	type CompiledCustomDecorationRule,
	type CustomDecorationRange,
} from '../livePreview/customDecorations';
import {
	isAllowedHtmlTagName,
	parseHtmlTag,
	sanitizeHtmlAttributes,
	VOID_HTML_TAGS,
} from '../livePreview/htmlSanitizer';
import { classifyImageSource, type ImageSourceKind } from '../livePreview/imageWidget';
import { findCalloutInfo } from '../livePreview/lineDecorations';
import {
	extractFencedCodeInfo,
	extractFencedCodeText,
	isMermaidFencedCode,
	renderMermaidSource,
} from '../livePreview/mermaidWidget';
import {
	extractTableData,
	type TableCellNode,
} from '../livePreview/tableWidget';
import {
	EXPORT_OUTLINE_CSS,
	EXPORT_PREVIEW_CSS,
	EXPORT_PRINT_CSS,
	EXPORT_THEME_DARK_CSS,
	EXPORT_THEME_LIGHT_CSS,
} from './exportCss';
import { escapeAttribute, escapeHtml, escapeInlineHtml } from './htmlEscape';

const FULL_PARSE_TIMEOUT_MS = 20_000;

export type ExportImageRequest = {
	raw: string;
	kind: ImageSourceKind;
	alt: string;
	embed: boolean;
	documentPath: string | null;
};

export type ExportMermaidResult = {
	ok: boolean;
	svg?: string;
	error?: string;
};

export type RenderExportHtmlOptions = {
	markdown: string;
	title?: string;
	filePath?: string | null;
	theme: 'light' | 'dark';
	codeFontFamily?: string;
	snippetsCss?: string[];
	customDecorations?: CustomDecorationRule[];
	loadRemoteImages?: boolean;
	outline?: Partial<ExportOutlineSettings>;
	resolveImage?: (request: ExportImageRequest) => Promise<string | null>;
	renderMermaid?: (source: string, theme: 'default' | 'dark') => Promise<ExportMermaidResult>;
};

type ExportContext = {
	state: EditorState;
	theme: 'light' | 'dark';
	rules: CompiledCustomDecorationRule[];
	decorationRanges: CustomDecorationRange[];
	loadRemoteImages: boolean;
	filePath: string | null;
	headingIds: Map<number, string>;
	resolveImage: (request: ExportImageRequest) => Promise<string | null>;
	renderMermaid: (source: string, theme: 'default' | 'dark') => Promise<ExportMermaidResult>;
};

const SKIP_MARKS = new Set([
	'HeaderMark',
	'SetextHeadingMark',
	'ListMark',
	'QuoteMark',
	'CodeMark',
	'LinkMark',
	'EmphasisMark',
	'HighlightMark',
	'WikiLinkMark',
	'WikiEmbedMark',
	'CalloutMark',
	'CalloutType',
	'CalloutFoldMark',
	'TaskMarker',
	'YamlFrontMatter',
	'YamlFrontMatterMark',
	'YamlFrontMatterContent',
]);

const HEADING_LEVELS: Record<string, number> = {
	ATXHeading1   : 1,
	ATXHeading2   : 2,
	ATXHeading3   : 3,
	ATXHeading4   : 4,
	ATXHeading5   : 5,
	ATXHeading6   : 6,
	SetextHeading1: 1,
	SetextHeading2: 2,
};

const exportCodeHighlighter = tagHighlighter([
	{ tag: tags.keyword, class: 'cm-md-syntax-keyword' },
	{ tag: [tags.atom, tags.bool, tags.labelName], class: 'cm-md-syntax-atom' },
	{ tag: [tags.number, tags.literal], class: 'cm-md-syntax-number' },
	{ tag: [tags.string, tags.special(tags.string)], class: 'cm-md-syntax-string' },
	{ tag: [tags.regexp, tags.escape], class: 'cm-md-syntax-regexp' },
	{ tag: tags.comment, class: 'cm-md-syntax-comment' },
	{ tag: [tags.variableName, tags.special(tags.variableName)], class: 'cm-md-syntax-variable' },
	{ tag: [tags.typeName, tags.namespace, tags.className], class: 'cm-md-syntax-type' },
	{ tag: [tags.propertyName, tags.macroName], class: 'cm-md-syntax-property' },
	{ tag: tags.invalid, class: 'cm-md-syntax-invalid' },
]);

/**
 * Markdown を自己完結 HTML 文書へ変換する
 * @param {RenderExportHtmlOptions} options 変換オプション
 * @returns {Promise<string>}
 */
export async function renderExportHtml(options: RenderExportHtmlOptions): Promise<string> {
	const state                  = EditorState.create({
		doc       : options.markdown,
		extensions: [createTmsMarkdownSupport()],
	});
	const compiled               = compileCustomDecorationRules(options.customDecorations);
	const tree                   = ensureSyntaxTree(state, state.doc.length, FULL_PARSE_TIMEOUT_MS)
		?? syntaxTree(state);
	const outline                = resolveExportOutline(options.outline);
	const outlineItems           = outline.enabled ? collectOutlineItems(state, tree) : [];
	const headingIds             = createExportHeadingIdMap(outlineItems);
	const context: ExportContext = {
		state,
		theme           : options.theme,
		rules           : compiled.rules,
		decorationRanges: collectCustomDecorationRangesFromDoc(state.doc, compiled.rules),
		loadRemoteImages: options.loadRemoteImages !== false,
		filePath        : options.filePath ?? null,
		headingIds,
		resolveImage    : options.resolveImage ?? unresolvedExportImage,
		renderMermaid   : options.renderMermaid ?? defaultRenderMermaid,
	};

	const body        = await renderBlocks(context, tree.topNode);
	const title       = escapeHtml(options.title?.trim() || '無題');
	const css         = buildExportCss(options);
	const isDark      = context.theme === 'dark';
	const htmlClass   = isDark ? 'tms-mde-export-root tms-mde-theme-dark' : 'tms-mde-export-root';
	const osThemeAttr = isDark ? ' data-os-theme="dark"' : '';
	const bodyClass   = isDark ? 'tms-mde-body tms-mde-theme-dark' : 'tms-mde-body tms-mde-theme-light';
	const article     = `<article class="tms-mde-editor-host tms-mde-export">
<div class="cm-editor tms-mde-cm-live-preview">
${body}
</div>
</article>`;
	const main        = outline.enabled
		? wrapExportWithOutline(article, outlineItems)
		: article;

	return `<!DOCTYPE html>
<html lang="ja" class="${htmlClass}"${osThemeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body class="${bodyClass}">
${main}
</body>
</html>
`;
}

/**
 * エクスポート用 CSS を組み立てる
 * @param {RenderExportHtmlOptions} options オプション
 * @returns {string}
 */
export function buildExportCss(options: Pick<RenderExportHtmlOptions, 'theme' | 'snippetsCss' | 'codeFontFamily'>): string {
	const snippets = (options.snippetsCss ?? []).filter((item) => item.trim().length > 0);
	return [
		EXPORT_THEME_LIGHT_CSS,
		options.theme === 'dark' ? EXPORT_THEME_DARK_CSS : '',
		EXPORT_PREVIEW_CSS,
		buildCodeFontCss(options.codeFontFamily, '.tms-mde-export-root'),
		...snippets,
		EXPORT_OUTLINE_CSS,
		EXPORT_PRINT_CSS,
	].filter(Boolean).join('\n');
}

/**
 * HTML 出力アウトライン設定を正規化する
 * @param {Partial<ExportOutlineSettings> | undefined} outline 指定値
 * @returns {{ enabled: boolean }}
 */
function resolveExportOutline(
	outline: Partial<ExportOutlineSettings> | undefined,
): { enabled: boolean } {
	return {
		enabled: outline?.enabled !== false,
	};
}

/**
 * 見出し位置から HTML の id を作る
 * @param {number} index 文書順の見出し番号
 * @returns {string}
 */
function createExportHeadingId(index: number): string {
	return `tms-mde-h-${index}`;
}

/**
 * 見出し位置と id の対応を作る
 * @param {OutlineItem[]} items アウトライン項目
 * @returns {Map<number, string>}
 */
function createExportHeadingIdMap(items: OutlineItem[]): Map<number, string> {
	return new Map(items.map((item, index) => [item.from, createExportHeadingId(index)]));
}

/**
 * 本文をアウトライン付きのシェルで包む
 * @param {string} article 本文 HTML
 * @param {OutlineItem[]} items 見出し
 * @returns {string}
 */
function wrapExportWithOutline(article: string, items: OutlineItem[]): string {
	return `<div class="tms-mde-export-shell">
${article}
${renderExportOutlineNav(items)}
</div>`;
}

/**
 * アウトラインの「すべて展開 / すべて折りたたむ」だけを動かす固定スクリプト。
 * Markdown 由来の文字列は埋め込まない。
 */
const EXPORT_OUTLINE_FOLD_SCRIPT = [
	'(function(){',
	'var root=document.getElementById("tms-mde-export-outline");',
	'if(!root)return;',
	'function setFolds(open){',
	'root.querySelectorAll("input.tms-mde-export-outline-fold").forEach(function(el){el.checked=open;});',
	'}',
	'root.addEventListener("click",function(ev){',
	'var t=ev.target;',
	'if(!t||!t.closest)return;',
	'if(t.closest("[data-outline-expand]"))setFolds(true);',
	'if(t.closest("[data-outline-collapse]"))setFolds(false);',
	'});',
	'})();',
].join('');

/**
 * 閲覧者が左右を切り替えられるアウトライン見出しを描画する
 * @returns {string}
 */
function renderExportOutlineHeader(): string {
	return `<header class="tms-mde-export-outline-header">
<h2 class="tms-mde-export-outline-title">アウトライン</h2>
<div class="tms-mde-export-outline-toolbar">
<button type="button" class="tms-mde-export-outline-fold-all" data-outline-expand>すべて展開</button>
<button type="button" class="tms-mde-export-outline-fold-all" data-outline-collapse>すべて折りたたむ</button>
<fieldset class="tms-mde-export-outline-side">
<legend class="tms-mde-export-outline-side-legend">位置</legend>
<input type="radio" name="tms-mde-export-outline-side" id="tms-mde-export-outline-side-left" value="left">
<label for="tms-mde-export-outline-side-left">左</label>
<input type="radio" name="tms-mde-export-outline-side" id="tms-mde-export-outline-side-right" value="right" checked>
<label for="tms-mde-export-outline-side-right">右</label>
</fieldset>
</div>
</header>`;
}

/**
 * HTML 出力用のアウトラインを描画する
 * @param {OutlineItem[]} items 見出し
 * @returns {string}
 */
function renderExportOutlineNav(items: OutlineItem[]): string {
	const header = renderExportOutlineHeader();
	const script = `<script>${EXPORT_OUTLINE_FOLD_SCRIPT}</script>`;
	if (items.length === 0) {
		return `<nav id="tms-mde-export-outline" class="tms-mde-export-outline" aria-label="アウトライン">
${header}
<p class="tms-mde-export-outline-empty">見出しはありません</p>
${script}
</nav>`;
	}

	return `<nav id="tms-mde-export-outline" class="tms-mde-export-outline" aria-label="アウトライン">
${header}
${renderExportOutlineTree(buildOutlineTree(items), 'tms-mde-export-outline-list')}
${script}
</nav>`;
}

/**
 * アウトラインツリーを入れ子のノードにする
 * @param {readonly OutlineTreeNode[]} nodes ノード
 * @param {string} listClass ラッパの class
 * @returns {string}
 */
function renderExportOutlineTree(nodes: readonly OutlineTreeNode[], listClass: string): string {
	if (nodes.length === 0) return '';
	const items = nodes.map((node) => renderExportOutlineNode(node)).join('\n');
	return `<div class="${listClass}">\n${items}\n</div>`;
}

/**
 * 見出しレベルに応じたインデント縦線を描く
 * @param {number} level 見出しレベル
 * @returns {string}
 */
function renderExportOutlineGuides(level: number): string {
	const count = Math.max(0, level - 1);
	if (count === 0) return '';
	const marks = Array.from(
		{ length: count },
		() => '<span class="tms-mde-export-outline-guide"></span>',
	).join('');
	return `<span class="tms-mde-export-outline-guides" aria-hidden="true">${marks}</span>`;
}

/**
 * アウトラインの1見出しを描画する
 * @param {OutlineTreeNode} node ノード
 * @returns {string}
 */
function renderExportOutlineNode(node: OutlineTreeNode): string {
	const headingId = createExportHeadingId(node.index);
	const title     = escapeHtml(node.item.title);
	const rowStart  = `<div class="tms-mde-export-outline-row" style="--tms-mde-outline-level: ${node.item.level}">${renderExportOutlineGuides(node.item.level)}`;
	const link      = `<a class="tms-mde-export-outline-item" href="#${headingId}">${title}</a>`;
	if (node.children.length === 0) {
		return `<div class="tms-mde-export-outline-node">${rowStart}<span class="tms-mde-export-outline-twist is-leaf" aria-hidden="true"></span>${link}</div></div>`;
	}

	const foldId = `tms-mde-export-outline-fold-${node.index}`;
	return `<div class="tms-mde-export-outline-node"><input type="checkbox" class="tms-mde-export-outline-fold" id="${foldId}" checked>${rowStart}<label class="tms-mde-export-outline-twist" for="${foldId}" aria-label="見出しの開閉"></label>${link}</div>${renderExportOutlineTree(node.children, 'tms-mde-export-outline-children')}</div>`;
}

/**
 * 画像を解決できないときの既定実装
 * @returns {Promise<null>}
 */
async function unresolvedExportImage(): Promise<null> {
	return null;
}

/**
 * @param {string} source Mermaid ソース
 * @param {'default' | 'dark'} theme テーマ
 * @returns {Promise<ExportMermaidResult>}
 */
async function defaultRenderMermaid(
	source: string,
	theme: 'default' | 'dark',
): Promise<ExportMermaidResult> {
	const result = await renderMermaidSource(source, theme);
	if (result.ok) {
		return { ok: true, svg: result.svg };
	}

	return { ok: false, error: result.error };
}

/**
 * ブロック列を描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} parent 親ノード
 * @returns {Promise<string>}
 */
async function renderBlocks(context: ExportContext, parent: SyntaxNode): Promise<string> {
	const parts: string[] = [];
	for (let child = parent.firstChild; child; child = child.nextSibling) {
		const html = await renderBlock(context, child);
		if (html) {
			parts.push(html);
		}
	}

	return parts.join('\n');
}

/**
 * 1 ブロックを描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node ノード
 * @returns {Promise<string>}
 */
async function renderBlock(context: ExportContext, node: SyntaxNode): Promise<string> {
	const headingLevel = HEADING_LEVELS[node.name];
	if (headingLevel) {
		const inner     = (await renderCovered(context, node)).trim();
		const headingId = context.headingIds.get(node.from);
		const idAttr    = headingId ? ` id="${escapeAttribute(headingId)}"` : '';
		return `<h${headingLevel} class="cm-line cm-md-h${headingLevel}"${idAttr}>${inner}</h${headingLevel}>`;
	}

	if (node.name === 'Paragraph') {
		const inner = await renderCovered(context, node);
		return inner.trim() ? `<p>${inner}</p>` : '';
	}

	if (node.name === 'BulletList') {
		return `<ul>\n${await renderListItems(context, node)}</ul>`;
	}

	if (node.name === 'OrderedList') {
		return `<ol>\n${await renderListItems(context, node)}</ol>`;
	}

	if (node.name === 'Blockquote') {
		return renderBlockquote(context, node);
	}

	if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
		return renderFencedCode(context, node);
	}

	if (node.name === 'Table') {
		return renderTable(context, node);
	}

	if (node.name === 'HorizontalRule') {
		return '<hr class="cm-line cm-md-hr">';
	}

	if (node.name.startsWith('YamlFrontMatter') || node.name === 'HTMLBlock') {
		return '';
	}

	if (node.name === 'Image' || node.name === 'WikiEmbed') {
		return renderImage(context, node);
	}

	if (SKIP_MARKS.has(node.name)) {
		return '';
	}

	return renderCovered(context, node);
}

/**
 * リスト項目を描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} listNode リスト
 * @returns {Promise<string>}
 */
async function renderListItems(context: ExportContext, listNode: SyntaxNode): Promise<string> {
	const parts: string[] = [];
	for (let child = listNode.firstChild; child; child = child.nextSibling) {
		if (child.name !== 'ListItem') {
			continue;
		}

		const task   = findTaskInItem(context, child);
		const prefix = task
			? `<input type="checkbox" class="cm-md-checkbox" disabled${task.checked ? ' checked' : ''}>`
			: '';
		const inner  = await renderListItemContent(context, child);
		parts.push(`<li>${prefix}${inner}</li>`);
	}

	return `${parts.join('\n')}\n`;
}

/**
 * リスト項目の本文を描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} item 項目
 * @returns {Promise<string>}
 */
async function renderListItemContent(context: ExportContext, item: SyntaxNode): Promise<string> {
	const parts: string[] = [];
	for (let child = item.firstChild; child; child = child.nextSibling) {
		if (SKIP_MARKS.has(child.name)) {
			continue;
		}

		if (child.name === 'Task' || child.name === 'Paragraph') {
			parts.push(await renderCovered(context, child));
			continue;
		}

		parts.push(await renderBlock(context, child));
	}

	return parts.join('').trim();
}

/**
 * リスト項目のタスク状態を返す
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} item 項目
 * @returns {{ checked: boolean } | null}
 */
function findTaskInItem(context: ExportContext, item: SyntaxNode): { checked: boolean } | null {
	let found: { checked: boolean } | null = null;
	item.cursor().iterate((child) => {
		if (child.name === 'TaskMarker' && !found) {
			found = {
				checked: isTaskMarkerChecked(context.state.doc.sliceString(child.from, child.to)),
			};
			return false;
		}
	});
	return found;
}

/**
 * 引用またはコールアウトを描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node Blockquote
 * @returns {Promise<string>}
 */
async function renderBlockquote(context: ExportContext, node: SyntaxNode): Promise<string> {
	const callout = findCalloutInfo(context.state, node);
	if (!callout) {
		const inner = await renderQuoteChildren(context, node);
		return `<blockquote class="cm-line cm-md-blockquote">${inner}</blockquote>`;
	}

	const { title, body } = await splitCalloutContent(context, node, callout.calloutFrom);
	const typeClass       = `cm-md-callout cm-md-callout-${callout.type}`;
	const titleHtml       = `<p class="cm-md-callout-title">${title || escapeHtml(callout.type)}</p>`;
	return `<blockquote class="${typeClass}">${titleHtml}${body}</blockquote>`;
}

/**
 * コールアウトのタイトル行と本文を分ける
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node Blockquote
 * @param {number} calloutFrom コールアウト開始位置
 * @returns {Promise<{ title: string; body: string }>}
 */
async function splitCalloutContent(
	context: ExportContext,
	node: SyntaxNode,
	calloutFrom: number,
): Promise<{ title: string; body: string }> {
	const titleEnd  = context.state.doc.lineAt(calloutFrom).to;
	let title       = '';
	const bodyParts = [];

	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (SKIP_MARKS.has(child.name)) {
			continue;
		}

		if (child.to <= titleEnd) {
			title += await renderCovered(context, child);
			continue;
		}

		if (child.from >= titleEnd) {
			bodyParts.push(await renderBlock(context, child));
			continue;
		}

		title         += await renderCovered(context, child, child.from, titleEnd);
		const leftover = (await renderCovered(context, child, titleEnd, child.to)).trim();
		if (leftover) {
			bodyParts.push(child.name === 'Paragraph' ? `<p class="cm-md-callout-body">${leftover}</p>` : leftover);
		}
	}

	return { title: title.trim(), body: bodyParts.filter(Boolean).join('\n') };
}

/**
 * 引用の子を描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node Blockquote
 * @returns {Promise<string>}
 */
async function renderQuoteChildren(context: ExportContext, node: SyntaxNode): Promise<string> {
	const parts: string[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (SKIP_MARKS.has(child.name)) {
			continue;
		}

		parts.push(await renderBlock(context, child));
	}

	return parts.join('');
}

/**
 * フェンスコードまたは Mermaid を描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node FencedCode
 * @returns {Promise<string>}
 */
async function renderFencedCode(context: ExportContext, node: SyntaxNode): Promise<string> {
	if (isMermaidFencedCode(context.state, node)) {
		const source = extractFencedCodeText(context.state, node);
		const theme  = context.theme === 'dark' ? 'dark' : 'default';
		const result = await context.renderMermaid(source, theme);
		if (result.ok && result.svg && isSafeSvg(result.svg)) {
			return `<figure class="cm-md-mermaid">${result.svg}</figure>`;
		}

		const message = escapeHtml(result.error ?? 'Mermaid を描画できませんでした');
		return `<figure class="cm-md-mermaid-error"><p>${message}</p><pre><code>${escapeHtml(source)}</code></pre></figure>`;
	}

	const info     = extractFencedCodeInfo(context.state, node);
	const language = extractCodeLanguageName(info);
	const code     = extractFencedCodeText(context.state, node);
	const inner    = highlightCodeHtml(code, language);
	const langAttr = language ? ` data-language="${escapeAttribute(language)}"` : '';
	return `<pre class="cm-line cm-md-fenced-code"${langAttr}><code>${inner}</code></pre>`;
}

/**
 * テーブルを描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node Table
 * @returns {string}
 */
function renderTable(context: ExportContext, node: SyntaxNode): string {
	const data = extractTableData(context.state, node);
	const head = data.headers.length > 0
		? `<thead><tr>${data.headers.map((cell) => `<th>${tableCellToHtml(context, cell)}</th>`).join('')}</tr></thead>`
		: '';
	const body = data.rows.map((row) => (
		`<tr>${row.map((cell) => `<td>${tableCellToHtml(context, cell)}</td>`).join('')}</tr>`
	)).join('');
	return `<div class="cm-md-table-wrap"><table class="cm-md-table">${head}<tbody>${body}</tbody></table></div>`;
}

/**
 * セル AST を HTML にする
 * @param {ExportContext} context 文脈
 * @param {TableCellNode[]} nodes セル
 * @returns {string}
 */
function tableCellToHtml(context: ExportContext, nodes: TableCellNode[]): string {
	return nodes.map((node) => {
		if (node.kind === 'text') {
			return decorateText(node.text, context.rules);
		}

		if (node.kind === 'br') {
			return '<br>';
		}

		if (node.kind === 'html') {
			const attrs = htmlAttributeString(node.attributes.className, node.attributes.style, `cm-md-html cm-md-html-${node.tagName}`);
			if (VOID_HTML_TAGS.has(node.tagName)) {
				return `<${node.tagName}${attrs}>`;
			}

			return `<${node.tagName}${attrs}>${tableCellToHtml(context, node.children)}</${node.tagName}>`;
		}

		if (node.kind === 'link') {
			return `<a class="cm-md-link" href="${escapeAttribute(node.href)}">${tableCellToHtml(context, node.children)}</a>`;
		}

		if (node.kind === 'wikilink') {
			return `<span class="cm-md-wikilink">${tableCellToHtml(context, node.children)}</span>`;
		}

		const className = node.kind === 'highlight'
			? 'cm-md-highlight'
			: node.kind === 'code'
				? 'cm-md-code'
				: node.kind === 'strike'
					? 'cm-md-strike'
					: `cm-md-${node.kind}`;
		const tag       = node.kind === 'highlight'
			? 'mark'
			: node.kind === 'code'
				? 'code'
				: node.kind === 'strike'
					? 's'
					: node.kind;
		return `<${tag} class="${className}">${tableCellToHtml(context, node.children)}</${tag}>`;
	}).join('');
}

/**
 * 画像または埋め込み画像を描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node Image / WikiEmbed
 * @returns {Promise<string>}
 */
async function renderImage(context: ExportContext, node: SyntaxNode): Promise<string> {
	const embed = node.name === 'WikiEmbed';
	const alt   = embed ? '' : extractImageAltAndUrl(context.state, node).alt;
	const raw   = embed
		? extractWikiEmbedPath(context.state, node)
		: extractImageAltAndUrl(context.state, node).url;
	const kind  = embed ? 'embed' : classifyImageSource(raw);

	if (kind === 'url' && !raw.startsWith('data:') && !context.loadRemoteImages) {
		return imageFallback(raw || 'リモート画像');
	}

	if (kind === 'url') {
		return `<img class="cm-md-image" src="${escapeAttribute(raw)}" alt="${escapeAttribute(alt)}">`;
	}

	const dataUrl = await context.resolveImage({
		raw,
		kind,
		alt,
		embed,
		documentPath: context.filePath,
	});
	if (!dataUrl) {
		return imageFallback(raw);
	}

	return `<img class="cm-md-image" src="${escapeAttribute(dataUrl)}" alt="${escapeAttribute(alt)}">`;
}

/**
 * 画像プレースホルダを返す
 * @param {string} raw 元パス
 * @returns {string}
 */
function imageFallback(raw: string): string {
	return `<span class="cm-md-image-fallback">画像を読み込めません: ${escapeHtml(raw)}</span>`;
}

/**
 * ノード配下のインラインを描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node ノード
 * @param {number} [clipFrom] 切り出し開始
 * @param {number} [clipTo] 切り出し終了
 * @returns {Promise<string>}
 */
async function renderCovered(
	context: ExportContext,
	node: SyntaxNode,
	clipFrom: number = node.from,
	clipTo: number = node.to,
): Promise<string> {
	const rangeFrom = Math.max(node.from, clipFrom);
	const rangeTo   = Math.min(node.to, clipTo);
	if (rangeFrom >= rangeTo) {
		return '';
	}

	let html                          = '';
	let pos                           = rangeFrom;
	let skipUntilClose: string | null = null;
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.to <= rangeFrom) {
			continue;
		}

		if (child.from >= rangeTo) {
			break;
		}

		if (skipUntilClose) {
			if (child.name === 'HTMLTag') {
				const parsed = parseHtmlTag(context.state.doc.sliceString(child.from, child.to));
				if (parsed?.kind === 'close' && parsed.name === skipUntilClose) {
					skipUntilClose = null;
				}
			}

			pos = Math.min(child.to, rangeTo);
			continue;
		}

		if (child.name === 'HTMLTag') {
			const parsed = parseHtmlTag(context.state.doc.sliceString(child.from, child.to));
			if (parsed && !parsed.allowed && parsed.kind === 'open') {
				if (child.from > pos) {
					html += emitDecorated(context, pos, Math.min(child.from, rangeTo));
				}

				skipUntilClose = parsed.name;
				pos            = Math.min(child.to, rangeTo);
				continue;
			}
		}

		if (SKIP_MARKS.has(child.name)) {
			if (child.from > pos) {
				html += emitDecorated(context, pos, Math.min(child.from, rangeTo));
			}

			pos = Math.min(child.to, rangeTo);
			continue;
		}

		if (child.from > pos) {
			html += emitDecorated(context, pos, Math.min(child.from, rangeTo));
		}

		if (child.from >= rangeFrom && child.to <= rangeTo) {
			html += await renderInline(context, child);
		} else {
			html += await renderCovered(context, child, rangeFrom, rangeTo);
		}

		pos = Math.min(child.to, rangeTo);
	}

	if (!skipUntilClose && pos < rangeTo) {
		html += emitDecorated(context, pos, rangeTo);
	}

	return html;
}

/**
 * インラインノードを描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node ノード
 * @returns {Promise<string>}
 */
async function renderInline(context: ExportContext, node: SyntaxNode): Promise<string> {
	if (node.name === 'Emphasis') {
		return `<em class="cm-md-em">${await renderCovered(context, node)}</em>`;
	}

	if (node.name === 'StrongEmphasis') {
		return `<strong class="cm-md-strong">${await renderCovered(context, node)}</strong>`;
	}

	if (node.name === 'Strikethrough') {
		return `<s class="cm-md-strike">${await renderCovered(context, node)}</s>`;
	}

	if (node.name === 'Highlight') {
		return `<mark class="cm-md-highlight">${await renderCovered(context, node)}</mark>`;
	}

	if (node.name === 'InlineCode') {
		return renderInlineCode(context, node);
	}

	if (node.name === 'Link' || node.name === 'URL') {
		return renderLink(context, node);
	}

	if (node.name === 'WikiLink') {
		let pageFrom = 0;
		let pageTo   = 0;
		node.cursor().iterate((child) => {
			if (child.name === 'WikiLinkPage') {
				pageFrom = child.from;
				pageTo   = child.to;
			}
		});
		return `<span class="cm-md-wikilink">${emitDecorated(context, pageFrom, pageTo)}</span>`;
	}

	if (node.name === 'Image' || node.name === 'WikiEmbed') {
		return renderImage(context, node);
	}

	if (node.name === 'HTMLBlock') {
		return '';
	}

	if (node.name === 'HTMLTag') {
		return renderHtmlTag(context.state.doc.sliceString(node.from, node.to));
	}

	if (node.name === 'HardBreak') {
		return '<br>';
	}

	if (SKIP_MARKS.has(node.name)) {
		return '';
	}

	if (node.firstChild) {
		return renderCovered(context, node);
	}

	return emitDecorated(context, node.from, node.to);
}

/**
 * インラインコードを描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node InlineCode
 * @returns {string}
 */
function renderInlineCode(context: ExportContext, node: SyntaxNode): string {
	const raw   = context.state.doc.sliceString(node.from, node.to);
	const inner = raw.replace(/^`+/, '').replace(/`+$/, '');
	const split = splitInlineCodeLanguageContent(inner);
	const code  = split && getLoadedCodeLanguage(split.language) ? split.code : (split?.code ?? inner);
	return `<code class="cm-md-code">${escapeHtml(code || inner)}</code>`;
}

/**
 * リンクを描画する
 * @param {ExportContext} context 文脈
 * @param {SyntaxNode} node Link / URL
 * @returns {Promise<string>}
 */
async function renderLink(context: ExportContext, node: SyntaxNode): Promise<string> {
	if (node.name === 'URL') {
		const href = context.state.doc.sliceString(node.from, node.to);
		return `<a class="cm-md-link" href="${escapeAttribute(href)}">${escapeHtml(href)}</a>`;
	}

	let href = '';
	node.cursor().iterate((child) => {
		if (child.name === 'URL') {
			href = context.state.doc.sliceString(child.from, child.to);
		}
	});
	const label = await renderCovered(context, node);
	return `<a class="cm-md-link" href="${escapeAttribute(href)}">${label || escapeHtml(href)}</a>`;
}

/**
 * 許可タグだけを HTML として出す
 * @param {string} raw 生タグ
 * @returns {string}
 */
function renderHtmlTag(raw: string): string {
	const parsed = parseHtmlTag(raw);
	if (!parsed || !parsed.allowed || !isAllowedHtmlTagName(parsed.name)) {
		return '';
	}

	if (parsed.kind === 'close') {
		return `</${parsed.name}>`;
	}

	const sanitized = sanitizeHtmlAttributes(parsed.attributes);
	const attrs     = htmlAttributeString(sanitized.className, sanitized.style, `cm-md-html cm-md-html-${parsed.name}`);
	if (parsed.kind === 'selfClosing' || VOID_HTML_TAGS.has(parsed.name)) {
		return `<${parsed.name}${attrs}>`;
	}

	return `<${parsed.name}${attrs}>`;
}

/**
 * 属性文字列を組み立てる
 * @param {string | undefined} className クラス
 * @param {string | undefined} style スタイル
 * @param {string} extraClass 追加クラス
 * @returns {string}
 */
function htmlAttributeString(
	className: string | undefined,
	style: string | undefined,
	extraClass: string,
): string {
	const classes = [extraClass, className].filter(Boolean).join(' ');
	const parts   = [` class="${escapeAttribute(classes)}"`];
	if (style) {
		parts.push(` style="${escapeAttribute(style)}"`);
	}

	return parts.join('');
}

/**
 * フェンスコードをトークン色付き HTML にする
 * @param {string} code コード
 * @param {string} languageName 言語
 * @returns {string}
 */
function highlightCodeHtml(code: string, languageName: string): string {
	if (!code) {
		return '';
	}

	const language = languageName
		? (getLoadedCodeLanguage(languageName) ?? requestCodeLanguage(languageName))
		: null;
	if (!language) {
		return escapeHtml(code);
	}

	try {
		const tree                                                           = language.parser.parse(code);
		const ranges: Array<{ from: number; to: number; className: string }> = [];
		highlightTree(tree, exportCodeHighlighter, (from, to, className) => {
			if (from < to && className) {
				ranges.push({ from, to, className });
			}
		});
		if (ranges.length === 0) {
			const fallback = collectCodeHighlightRanges(code, language);
			return fallback.length > 0 ? emitHighlighted(code, fallback) : escapeHtml(code);
		}

		return emitHighlighted(code, ranges);
	} catch {
		return escapeHtml(code);
	}
}

/**
 * ハイライト範囲を span にする
 * @param {string} code コード
 * @param {Array<{ from: number; to: number; className: string }>} ranges 範囲
 * @returns {string}
 */
function emitHighlighted(
	code: string,
	ranges: Array<{ from: number; to: number; className: string }>,
): string {
	let html   = '';
	let cursor = 0;
	for (const range of ranges) {
		if (range.from > cursor) {
			html += escapeHtml(code.slice(cursor, range.from));
		}

		html  += `<span class="${escapeAttribute(range.className)}">${escapeHtml(code.slice(range.from, range.to))}</span>`;
		cursor = range.to;
	}

	if (cursor < code.length) {
		html += escapeHtml(code.slice(cursor));
	}

	return html;
}

/**
 * ドキュメント絶対座標でカスタム装飾を適用する
 * @param {ExportContext} context 文脈
 * @param {number} from 開始
 * @param {number} to 終了
 * @returns {string}
 */
function emitDecorated(context: ExportContext, from: number, to: number): string {
	if (from >= to) {
		return '';
	}

	return decorateSlice(context.state.doc.sliceString(from, to), from, context.decorationRanges);
}

/**
 * カスタム装飾をテキストへ適用する
 * @param {string} text 生テキスト
 * @param {CompiledCustomDecorationRule[]} rules ルール
 * @returns {string}
 */
export function decorateText(text: string, rules: CompiledCustomDecorationRule[]): string {
	return decorateSlice(text, 0, collectCustomDecorationRangesFromText(text, rules, 0));
}

/**
 * スライスへ絶対座標の装飾を載せる
 * @param {string} text スライス
 * @param {number} origin スライス先頭のドキュメント座標
 * @param {CustomDecorationRange[]} ranges 装飾範囲
 * @returns {string}
 */
function decorateSlice(text: string, origin: number, ranges: CustomDecorationRange[]): string {
	if (!text) {
		return '';
	}

	if (ranges.length === 0) {
		return escapeInlineHtml(text);
	}

	type HideSpan = [number, number];
	type MarkSpan = { from: number; to: number; cssClass: string };
	const end                 = origin + text.length;
	const hidden : HideSpan[] = [];
	const marks  : MarkSpan[] = [];

	for (const range of ranges) {
		if (range.from < range.to && range.to > origin && range.from < end) {
			marks.push({ from: range.from, to: range.to, cssClass: range.cssClass });
		}

		if (range.hideDelimiters) {
			if (range.fullFrom < range.from) {
				hidden.push([range.fullFrom, range.from]);
			}

			if (range.to < range.fullTo) {
				hidden.push([range.to, range.fullTo]);
			}
		}
	}

	if (hidden.length === 0 && marks.length === 0) {
		return escapeInlineHtml(text);
	}

	const points = new Set<number>([origin, end]);
	for (const [hideFrom, hideTo] of hidden) {
		if (hideTo > origin && hideFrom < end) {
			points.add(Math.max(hideFrom, origin));
			points.add(Math.min(hideTo, end));
		}
	}

	for (const mark of marks) {
		points.add(Math.max(mark.from, origin));
		points.add(Math.min(mark.to, end));
	}

	const sorted = [...points].sort((left, right) => left - right);
	let html     = '';
	for (let index = 0; index < sorted.length - 1; index += 1) {
		const from = sorted[index] ?? origin;
		const to   = sorted[index + 1] ?? end;
		if (from >= to) {
			continue;
		}

		if (hidden.some(([hideFrom, hideTo]) => hideFrom <= from && to <= hideTo)) {
			continue;
		}

		let chunk               = escapeInlineHtml(text.slice(from - origin, to - origin));
		const classes: string[] = [];
		for (const mark of marks) {
			if (mark.from <= from && to <= mark.to && !classes.includes(mark.cssClass)) {
				classes.push(mark.cssClass);
			}
		}

		for (const cssClass of classes) {
			chunk = `<span class="${escapeAttribute(cssClass)}">${chunk}</span>`;
		}

		html += chunk;
	}

	return html;
}

/**
 * SVG に script が無いか
 * @param {string} svg SVG
 * @returns {boolean}
 */
function isSafeSvg(svg: string): boolean {
	return /<svg[\s>]/i.test(svg) && !/<script/i.test(svg);
}
