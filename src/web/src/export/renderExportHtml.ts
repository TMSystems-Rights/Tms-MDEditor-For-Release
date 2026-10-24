/**
 * Markdown を、プレビューと同じ見た目の自己完結 HTML へ変換する
 * @file
 */

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
import type { CustomDecorationRule, ExportOutlineSettings, ImageBorderSettings } from '../types/app';
import { buildCodeFontCss, sanitizeCssFontFamily } from '../app/codeFont';
import { buildImageBorderCss } from '../app/imageBorder';
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
import { classifyImageSource, type ImageSourceKind, type ImageSpec } from '../livePreview/imageWidget';
import { splitImageAlt, splitWikiEmbedTarget } from '../livePreview/imageSize';
import { splitWikiLinkAlias } from '../livePreview/wikiLink';
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
	buildTableOccupancy,
	cellAlignmentClassNames,
	isCoveredTableCell,
	parseCellSpan,
	readTableLayout,
} from '../livePreview/tableMerge';
import { clampColumnWidth, clampRowHeight } from '../livePreview/tableResize';
import { isHtmlTableBlock, sanitizeHtmlTable } from '../livePreview/htmlTable';
import {
	EXPORT_OUTLINE_CSS,
	EXPORT_PREVIEW_CSS,
	EXPORT_PRINT_CSS,
	EXPORT_THEME_DARK_CSS,
	EXPORT_THEME_LIGHT_CSS,
} from './exportCss';
import { escapeAttribute, escapeHtml, escapeInlineHtml } from './htmlEscape';

/** 構文木を末尾まで作る待ち時間（ミリ秒）。大きい文書でもここで打ち切る */
const FULL_PARSE_TIMEOUT_MS = 20_000;

/**
 * 書き出しが画像を解決するときに渡す、文書上の画像 1 件
 */
export type ExportImageRequest = {
	/** 文書に書かれた画像記法の原文 */
	raw: string;
	/** ローカル、リモート、埋め込みなどの種類 */
	kind: ImageSourceKind;
	/** 代替テキスト。幅指定を除いた表示名 */
	alt: string;
	/** 埋め込み記法なら true。リンク記法なら false */
	embed: boolean;
	/** 相対パスの基準になる文書パス。未保存なら null */
	documentPath: string | null;
};

/**
 * Mermaid を SVG にした結果
 * 失敗しても HTML 変換は続け、図の代わりにエラーを出す
 */
export type ExportMermaidResult = {
	/** 図を SVG にできたか */
	ok: boolean;
	/** 成功したときの SVG。失敗時は省略 */
	svg?: string;
	/** 失敗理由。成功時は省略 */
	error?: string;
};

/**
 * HTML 変換の入力
 * 画像と Mermaid の解決を省略したときは、代替表示で書き出す
 */
export type RenderExportHtmlOptions = {
	/** 変換する本文 */
	markdown: string;
	/** HTML の title。省略時は呼び出し側の既定 */
	title?: string;
	/** 画像の相対パスを解く文書パス。未保存なら null */
	filePath?: string | null;
	/** 書き出しの明暗 */
	theme: 'light' | 'dark';
	/** 本文フォント。省略時は CSS の既定 */
	editorFontFamily?: string;
	/** 本文の大きさ（px）。省略時は CSS の既定 */
	editorFontSize?: number;
	/** 等幅フォント。省略時は CSS の既定 */
	codeFontFamily?: string;
	/** 画像枠線。未指定の項目は既定 */
	imageBorder?: Partial<ImageBorderSettings>;
	/** 有効な CSS スニペット。並びが適用順 */
	snippetsCss?: string[];
	/** カスタム装飾ルール。無効なものは変換時に除く */
	customDecorations?: CustomDecorationRule[];
	/** リモート画像を取得するか。false なら代替表示 */
	loadRemoteImages?: boolean;
	/** 書き出しのアウトライン設定。未指定の項目は既定 */
	outline?: Partial<ExportOutlineSettings>;
	/** 画像を Data URL などへ解決する。null は未解決。省略時は代替表示 */
	resolveImage?: (request: ExportImageRequest) => Promise<string | null>;
	/** Mermaid を SVG にする。省略時は同梱の描画 */
	renderMermaid?: (source: string, theme: 'default' | 'dark') => Promise<ExportMermaidResult>;
};

/**
 * 変換のあいだ共有する、構文木と解決関数
 */
type ExportContext = {
	/** 変換に使う、構文木つきの文書 */
	state: EditorState;
	/** 書き出しの明暗 */
	theme: 'light' | 'dark';
	/** コンパイル済みの装飾ルール */
	rules: CompiledCustomDecorationRule[];
	/** 本文上の装飾範囲 */
	decorationRanges: CustomDecorationRange[];
	/** リモート画像を取得するか */
	loadRemoteImages: boolean;
	/** 相対パスの基準。未保存なら null */
	filePath: string | null;
	/** 見出しの開始位置から、HTML の id */
	headingIds: Map<number, string>;
	/** 画像解決。失敗時は null を返す */
	resolveImage: (request: ExportImageRequest) => Promise<string | null>;
	/** Mermaid を SVG にする */
	renderMermaid: (source: string, theme: 'default' | 'dark') => Promise<ExportMermaidResult>;
};

/** HTML へ文字として出さない構文マーク。記号自体は別の要素へ置き換える */
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

/** 見出しノード名から、1 始まりのレベル */
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

/** フェンスコードへ付けるハイライトのクラス */
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
 * 画像と Mermaid はオプションの解決関数が終わるまで待つ
 * @param options - 本文、テーマ、フォント、画像解決
 * @returns スタイルとスクリプトを含む HTML 文書
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

	const body              = await renderBlocks(context, tree.topNode);
	const title             = escapeHtml(options.title?.trim() || '無題');
	const css               = buildExportCss(options);
	const isDark            = context.theme === 'dark';
	const htmlClass         = isDark ? 'tms-mde-export-root tms-mde-theme-dark' : 'tms-mde-export-root';
	const osThemeAttr       = isDark ? ' data-os-theme="dark"' : '';
	const bodyClass         = isDark ? 'tms-mde-body tms-mde-theme-dark' : 'tms-mde-body tms-mde-theme-light';
	const article           = `<article class="tms-mde-editor-host tms-mde-export">
<div class="cm-editor tms-mde-cm-live-preview">
${body}
</div>
</article>`;
	const main              = outline.enabled
		? wrapExportWithOutline(article, outlineItems)
		: article;
	const headingFoldScript = `<script>${EXPORT_HEADING_FOLD_SCRIPT}</script>`;

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
${headingFoldScript}
</body>
</html>
`;
}

/**
 * エクスポート用 CSS を組み立てる
 * @param options - オプション
 * @returns テーマ、フォント、枠線、スニペットを連結した CSS
 */
export function buildExportCss(options: Pick<RenderExportHtmlOptions, 'theme' | 'snippetsCss' | 'editorFontFamily' | 'editorFontSize' | 'codeFontFamily' | 'imageBorder'>): string {
	const snippets = (options.snippetsCss ?? []).filter((item) => item.trim().length > 0);
	return [
		EXPORT_THEME_LIGHT_CSS,
		options.theme === 'dark' ? EXPORT_THEME_DARK_CSS : '',
		EXPORT_PREVIEW_CSS,
		buildExportEditorTypographyCss(options.editorFontFamily, options.editorFontSize),
		buildCodeFontCss(options.codeFontFamily, '.tms-mde-export-root'),
		buildImageBorderCss(options.imageBorder, '.tms-mde-export-root'),
		...snippets,
		EXPORT_OUTLINE_CSS,
		EXPORT_PRINT_CSS,
	].filter(Boolean).join('\n');
}

/**
 * アプリのエディタフォントを HTML 出力へ反映する
 * @param fontFamily - エディタフォント
 * @param fontSize - エディタフォントサイズ
 * @returns 本文とコードのフォント指定。空なら空文字
 */
function buildExportEditorTypographyCss(
	fontFamily: string | undefined,
	fontSize: number | undefined,
): string {
	const rules           = [];
	const numericFontSize = fontSize ?? Number.NaN;
	if (fontFamily?.trim()) {
		rules.push(`.tms-mde-export-root { --tms-mde-font-family: ${sanitizeCssFontFamily(fontFamily)}; }`);
	}

	if (Number.isFinite(numericFontSize)) {
		const normalized = Math.min(72, Math.max(8, Math.round(numericFontSize)));
		rules.push(`.tms-mde-export .cm-editor { font-size: ${normalized}px; }`);
	}

	return rules.join('\n');
}

/**
 * HTML 出力アウトライン設定を正規化する
 * @param outline - 指定値
 * @returns 有効フラグ。未指定は有効
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
 * @param index - 文書順の見出し番号。0 始まり
 * @returns `tms-mde-h-` に番号を付けた id
 */
function createExportHeadingId(index: number): string {
	return `tms-mde-h-${index}`;
}

/**
 * エクスポート本文の見出し開閉を行う固定スクリプト
 * 状態は保存せず、ページ読込時は常に全展開から開始する
 */
const EXPORT_HEADING_FOLD_SCRIPT = [
	'(function(){',
	'var editor=document.querySelector(".tms-mde-export > .cm-editor");',
	'if(!editor)return;',
	'var nodes=Array.prototype.slice.call(editor.children);',
	'var headings=[];',
	'var stack=[];',
	'nodes.forEach(function(node){',
	'if(!/^H[1-6]$/.test(node.tagName))return;',
	'var level=Number(node.tagName.slice(1));',
	'while(stack.length&&stack[stack.length-1].level>=level)stack.pop();',
	'var button=document.createElement("button");',
	'button.type="button";',
	'button.className="tms-mde-export-heading-fold";',
	'button.setAttribute("aria-expanded","true");',
	'button.setAttribute("aria-label","見出しを折りたたむ");',
	'button.textContent="▼";',
	'node.insertBefore(button,node.firstChild);',
	'var entry={heading:node,button:button,level:level,collapsed:false,parents:stack.slice()};',
	'headings.push(entry);stack.push(entry);',
	'});',
	'if(headings.length===0)return;',
	'function entryFor(node){for(var i=0;i<headings.length;i+=1)if(headings[i].heading===node)return headings[i];return null;}',
	'function setHidden(node,hidden){',
	'node.classList.toggle("tms-mde-export-heading-fold-hidden",hidden);',
	'if(hidden)node.setAttribute("aria-hidden","true");else node.removeAttribute("aria-hidden");',
	'}',
	'function render(){',
	'var active=[];',
	'nodes.forEach(function(node){',
	'var entry=entryFor(node);',
	'if(entry){while(active.length&&active[active.length-1].level>=entry.level)active.pop();setHidden(node,active.some(function(parent){return parent.collapsed;}));active.push(entry);}',
	'else setHidden(node,active.some(function(parent){return parent.collapsed;}));',
	'});',
	'headings.forEach(function(entry){entry.button.textContent=entry.collapsed?"▶":"▼";entry.button.setAttribute("aria-expanded",entry.collapsed?"false":"true");entry.button.setAttribute("aria-label",entry.collapsed?"見出しを展開":"見出しを折りたたむ");});',
	'}',
	'headings.forEach(function(entry){entry.button.addEventListener("click",function(ev){ev.preventDefault();entry.collapsed=!entry.collapsed;render();});});',
	'function revealEntry(entry){entry.collapsed=false;entry.parents.forEach(function(parent){parent.collapsed=false;});render();}',
	'var outline=document.getElementById("tms-mde-export-outline");',
	'if(outline)outline.addEventListener("click",function(ev){',
	'var source=ev.target;var link=source&&source.closest?source.closest("a.tms-mde-export-outline-item"):null;',
	'if(!link)return;',
	'var href=link.getAttribute("href")||"";var target=href.charAt(0)==="#"?document.getElementById(href.slice(1)):null;',
	'var entry=target?entryFor(target):null;if(entry)revealEntry(entry);',
	'});',
	'function revealHash(){',
	'if(!location.hash)return;',
	'var target=document.getElementById(decodeURIComponent(location.hash.slice(1)));',
	'var entry=target?entryFor(target):null;',
	'if(!entry)return;',
	'revealEntry(entry);',
	'}',
	'window.addEventListener("hashchange",revealHash);',
	'render();revealHash();',
	'})();',
].join('');

/**
 * 見出し位置と id の対応を作る
 * @param items - アウトライン項目
 * @returns 見出しの開始位置から HTML id
 */
function createExportHeadingIdMap(items: OutlineItem[]): Map<number, string> {
	return new Map(items.map((item, index) => [item.from, createExportHeadingId(index)]));
}

/**
 * 本文をアウトライン付きのシェルで包む
 * @param article - 本文 HTML
 * @param items - 見出し
 * @returns 本文とアウトラインを並べた HTML
 */
function wrapExportWithOutline(article: string, items: OutlineItem[]): string {
	return `<div class="tms-mde-export-shell">
${article}
${renderExportOutlineNav(items)}
</div>`;
}

/**
 * アウトラインの開閉と本文スクロール追従を行う固定スクリプト
 * Markdown 由来の文字列は埋め込まない
 */
const EXPORT_OUTLINE_SCRIPT = [
	'(function(){',
	'var root=document.getElementById("tms-mde-export-outline");',
	'if(!root)return;',
	'var shell=root.closest(".tms-mde-export-shell");',
	'var panel=root.querySelector(".tms-mde-export-outline-panel");',
	'var resizer=root.querySelector(".tms-mde-export-outline-resizer");',
	'var widthKey="tms-mde-export-outline-width";',
	'var minWidth=180;',
	'var minArticleWidth=240;',
	'function clampWidth(width){',
	'var shellWidth=shell?shell.getBoundingClientRect().width:window.innerWidth;',
	'return Math.round(Math.min(Math.max(minWidth,shellWidth-minArticleWidth),Math.max(minWidth,width)));',
	'}',
	'function applyWidth(width,save){',
	'if(!shell)return;',
	'var next=clampWidth(width);',
	'shell.style.setProperty("--tms-mde-export-outline-width",next+"px");',
	'if(resizer)resizer.setAttribute("aria-valuenow",String(next));',
	'if(save){try{localStorage.setItem(widthKey,String(next));}catch(_error){}}',
	'}',
	'try{var storedWidth=Number(localStorage.getItem(widthKey));if(storedWidth>0)applyWidth(storedWidth,false);}catch(_error){}',
	'if(resizer&&shell){',
	'var resizePointer=null;',
	'var resizeStartWidth=300;',
	'resizer.addEventListener("pointerdown",function(ev){',
	'if(ev.button!==0||resizePointer!==null)return;',
	'ev.preventDefault();resizePointer=ev.pointerId;resizeStartWidth=root.getBoundingClientRect().width;',
	'resizer.setPointerCapture(ev.pointerId);document.documentElement.classList.add("is-outline-resizing");',
	'});',
	'resizer.addEventListener("pointermove",function(ev){',
	'if(ev.pointerId!==resizePointer)return;',
	'var rect=shell.getBoundingClientRect();',
	'var left=root.querySelector("#tms-mde-export-outline-side-left").checked;',
	'applyWidth(left?ev.clientX-rect.left:rect.right-ev.clientX,false);',
	'});',
	'function finishResize(ev,save){',
	'if(ev.pointerId!==resizePointer)return;',
	'if(resizer.hasPointerCapture(ev.pointerId))resizer.releasePointerCapture(ev.pointerId);',
	'resizePointer=null;document.documentElement.classList.remove("is-outline-resizing");',
	'applyWidth(save?root.getBoundingClientRect().width:resizeStartWidth,save);',
	'}',
	'resizer.addEventListener("pointerup",function(ev){finishResize(ev,true);});',
	'resizer.addEventListener("pointercancel",function(ev){finishResize(ev,false);});',
	'resizer.addEventListener("keydown",function(ev){',
	'if(ev.key!=="ArrowLeft"&&ev.key!=="ArrowRight")return;',
	'ev.preventDefault();',
	'var left=root.querySelector("#tms-mde-export-outline-side-left").checked;',
	'var direction=ev.key==="ArrowRight"?1:-1;',
	'applyWidth(root.getBoundingClientRect().width+direction*(left?1:-1)*10,true);',
	'});',
	'}',
	'var links=Array.prototype.slice.call(root.querySelectorAll("a.tms-mde-export-outline-item"));',
	'var entries=[];',
	'links.forEach(function(link){',
	'var href=link.getAttribute("href")||"";',
	'var heading=href.charAt(0)==="#"?document.getElementById(href.slice(1)):null;',
	'if(heading)entries.push({link:link,heading:heading});',
	'});',
	'var activeLink=null;',
	'var frame=0;',
	'function setFolds(open){',
	'root.querySelectorAll("input.tms-mde-export-outline-fold").forEach(function(el){el.checked=open;});',
	'}',
	'function expandAncestors(link){',
	'var node=link.closest(".tms-mde-export-outline-node");',
	'while(node&&root.contains(node)){',
	'var fold=node.firstElementChild;',
	'if(fold&&fold.matches("input.tms-mde-export-outline-fold"))fold.checked=true;',
	'var parent=node.parentElement;',
	'node=parent?parent.closest(".tms-mde-export-outline-node"):null;',
	'}',
	'}',
	'function reveal(link){',
	'if(!panel||!link)return;',
	'expandAncestors(link);',
	'var itemRect=link.getBoundingClientRect();',
	'var panelRect=panel.getBoundingClientRect();',
	'var margin=6;',
	'if(itemRect.top<panelRect.top+margin)panel.scrollTop+=itemRect.top-panelRect.top-margin;',
	'else if(itemRect.bottom>panelRect.bottom-margin)panel.scrollTop+=itemRect.bottom-panelRect.bottom+margin;',
	'}',
	'function setActive(link){',
	'if(activeLink!==link){',
	'links.forEach(function(item){',
	'var active=item===link;',
	'item.classList.toggle("is-active",active);',
	'if(active)item.setAttribute("aria-current","location");else item.removeAttribute("aria-current");',
	'});',
	'activeLink=link;',
	'}',
	'reveal(link);',
	'}',
	'function syncActive(){',
	'if(entries.length===0){setActive(null);return;}',
	'var threshold=Math.min(120,window.innerHeight*0.25);',
	'var current=null;',
	'for(var i=0;i<entries.length;i+=1){',
	'if(entries[i].heading.getBoundingClientRect().top>threshold)break;',
	'current=entries[i].link;',
	'}',
	'var doc=document.documentElement;',
	'if(doc.scrollHeight>window.innerHeight+1&&window.scrollY+window.innerHeight>=doc.scrollHeight-1)current=entries[entries.length-1].link;',
	'setActive(current);',
	'}',
	'function scheduleSync(){',
	'if(frame)return;',
	'frame=window.requestAnimationFrame(function(){frame=0;syncActive();});',
	'}',
	'root.addEventListener("click",function(ev){',
	'var t=ev.target;',
	'if(!t||!t.closest)return;',
	'if(t.closest("[data-outline-expand]"))setFolds(true);',
	'if(t.closest("[data-outline-collapse]"))setFolds(false);',
	'scheduleSync();',
	'});',
	'window.addEventListener("scroll",scheduleSync,{passive:true});',
	'window.addEventListener("resize",scheduleSync);',
	'window.addEventListener("hashchange",scheduleSync);',
	'window.addEventListener("load",scheduleSync);',
	'scheduleSync();',
	'})();',
].join('');

/**
 * 閲覧者が左右を切り替えられるアウトライン見出しを描画する
 * @returns 左右の切り替えと見出しを含む断片
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
 * @param items - 見出し
 * @returns 見出し一覧の nav
 */
function renderExportOutlineNav(items: OutlineItem[]): string {
	const header = renderExportOutlineHeader();
	const script = `<script>${EXPORT_OUTLINE_SCRIPT}</script>`;
	const toggle = `<input type="checkbox" id="tms-mde-export-outline-dock" class="tms-mde-export-outline-dock" checked>
<div class="tms-mde-export-outline-resizer" role="separator" aria-label="アウトラインの幅を変更" aria-orientation="vertical" tabindex="0"></div>
<label for="tms-mde-export-outline-dock" class="tms-mde-export-outline-toggle" title="アウトラインの表示を切り替える" aria-label="アウトラインの表示を切り替える"></label>`;
	if (items.length === 0) {
		return `<nav id="tms-mde-export-outline" class="tms-mde-export-outline" aria-label="アウトライン">
${toggle}
<div class="tms-mde-export-outline-panel">
${header}
<p class="tms-mde-export-outline-empty">見出しはありません</p>
</div>
${script}
</nav>`;
	}

	return `<nav id="tms-mde-export-outline" class="tms-mde-export-outline" aria-label="アウトライン">
${toggle}
<div class="tms-mde-export-outline-panel">
${header}
${renderExportOutlineTree(buildOutlineTree(items), 'tms-mde-export-outline-list')}
</div>
${script}
</nav>`;
}

/**
 * アウトラインツリーを入れ子のノードにする
 * @param nodes - ノード
 * @param listClass - ラッパの class
 * @returns 入れ子のリスト HTML
 */
function renderExportOutlineTree(nodes: readonly OutlineTreeNode[], listClass: string): string {
	if (nodes.length === 0) return '';
	const items = nodes.map((node) => renderExportOutlineNode(node)).join('\n');
	return `<div class="${listClass}">\n${items}\n</div>`;
}

/**
 * 見出しレベルに応じたインデント縦線を描く
 * @param level - 見出しレベル
 * @returns レベルの深さに応じたガイド HTML
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
 * @param node - ノード
 * @returns 1 見出しと、その子の HTML
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
 * @returns 常に null。呼び出し側が代替表示にする
 */
async function unresolvedExportImage(): Promise<null> {
	return null;
}

/**
 * 同梱の描画で Mermaid を SVG にする
 * 失敗しても例外にはせず、結果の ok を false にする
 * @param source - 図のソース
 * @param theme - 図の明暗。文書がダークのときだけ dark
 * @returns 成功時は SVG、失敗時は理由を含む結果
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param parent - 親ノード
 * @returns 並べたブロックの HTML
 */
async function renderBlocks(context: ExportContext, parent: SyntaxNode): Promise<string> {
	return renderChildBlocks(context, parent, () => false);
}

/**
 * 子ブロックを描画し、ソース上の空行を残す
 * @param context - 変換中の構文木、装飾、画像解決
 * @param parent - 親ノード
 * @param shouldSkip - 飛ばす子
 * @returns 子ブロックと、間の空行を含む HTML
 */
async function renderChildBlocks(
	context: ExportContext,
	parent: SyntaxNode,
	shouldSkip: (node: SyntaxNode) => boolean,
): Promise<string> {
	const parts: string[] = [];
	let cursor            = parent.from;
	for (let child = parent.firstChild; child; child = child.nextSibling) {
		parts.push(...repeatExportBlankLines(countBlankLines(context.state, cursor, child.from)));
		if (shouldSkip(child)) {
			cursor = child.to;
			continue;
		}

		const html = await renderBlock(context, child);
		if (html) {
			parts.push(html);
		} else if (child.name === 'Paragraph') {
			parts.push(...repeatExportBlankLines(countBlankLines(context.state, child.from, child.to)));
		}

		cursor = child.to;
	}

	parts.push(...repeatExportBlankLines(countBlankLines(context.state, cursor, parent.to)));
	return parts.join('\n');
}

/**
 * 範囲内の空行数を返す。直前ブロックの行の残りは数えない
 * @param state - 文書
 * @param from - 開始
 * @param to - 終了
 * @returns 範囲内の空行数
 */
function countBlankLines(state: EditorState, from: number, to: number): number {
	if (from >= to) {
		return 0;
	}

	let count   = 0;
	const start = state.doc.lineAt(from);
	const last  = state.doc.lineAt(Math.max(from, to - 1));
	for (let number = start.number; number <= last.number; number += 1) {
		const line = state.doc.line(number);
		if (line.from < from || line.from >= to) {
			continue;
		}

		if (state.doc.sliceString(line.from, line.to).trim().length === 0) {
			count += 1;
		}
	}

	return count;
}

/**
 * 空行プレースホルダを繰り返す
 * @param count - 行数
 * @returns 空行プレースホルダの配列。長さは count
 */
function repeatExportBlankLines(count: number): string[] {
	return Array.from(
		{ length: Math.max(0, count) },
		() => '<div class="cm-line cm-md-blank" aria-hidden="true"><br></div>',
	);
}

/**
 * 1 ブロックを描画する
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - ノード
	 * @returns そのブロックの HTML。YAML、表以外の生 HTML、出力しないマークは空文字
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
		return await renderTable(context, node);
	}

	if (node.name === 'HorizontalRule') {
		return '<hr class="cm-line cm-md-hr">';
	}

	if (node.name.startsWith('YamlFrontMatter')) {
		return '';
	}

	if (node.name === 'HTMLBlock') {
		const raw = context.state.doc.sliceString(node.from, node.to);
		if (!isHtmlTableBlock(raw)) {
			return '';
		}

		const html = sanitizeHtmlTable(raw);
		return html ? `<div class="cm-md-table-wrap cm-md-html-table-wrap">${html}</div>` : '';
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param listNode - リスト
 * @returns リスト項目を含む HTML
 */
async function renderListItems(context: ExportContext, listNode: SyntaxNode): Promise<string> {
	const items: SyntaxNode[] = [];
	for (let child = listNode.firstChild; child; child = child.nextSibling) {
		if (child.name === 'ListItem') {
			items.push(child);
		}
	}

	const parts: string[] = [];
	for (let index = 0; index < items.length; index += 1) {
		const child  = items[index];
		const next   = items[index + 1];
		const task   = findTaskInItem(context, child);
		const prefix = task
			? `<input type="checkbox" class="cm-md-checkbox" disabled${task.checked ? ' checked' : ''}>`
			: '';
		const inner  = await renderListItemContent(context, child);
		const extra  = next
			? repeatExportBlankLines(countBlankLines(context.state, child.to, next.from)).join('')
			: '';
		parts.push(`<li>${prefix}${inner}${extra}</li>`);
	}

	return `${parts.join('\n')}\n`;
}

/**
 * リスト項目の本文を描画する
 * @param context - 変換中の構文木、装飾、画像解決
 * @param item - 項目
 * @returns マーカーを除いた項目の中身
 */
async function renderListItemContent(context: ExportContext, item: SyntaxNode): Promise<string> {
	const parts: string[] = [];
	let cursor            = item.from;
	for (let child = item.firstChild; child; child = child.nextSibling) {
		if (SKIP_MARKS.has(child.name)) {
			cursor = child.to;
			continue;
		}

		parts.push(...repeatExportBlankLines(countBlankLines(context.state, cursor, child.from)));
		if (child.name === 'Task' || child.name === 'Paragraph') {
			parts.push(await renderCovered(context, child));
			cursor = child.to;
			continue;
		}

		parts.push(await renderBlock(context, child));
		cursor = child.to;
	}

	parts.push(...repeatExportBlankLines(countBlankLines(context.state, cursor, item.to)));
	return parts.join('').trim();
}

/**
 * リスト項目のタスク状態を返す
 * @param context - 変換中の構文木、装飾、画像解決
 * @param item - 項目
 * @returns チェック状態。タスクでなければ null
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - Blockquote
 * @returns blockquote またはコールアウトの HTML
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - Blockquote
 * @param calloutFrom - コールアウト開始位置
 * @returns タイトル HTML と本文 HTML
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - Blockquote
 * @returns 引用の中身の HTML
 */
async function renderQuoteChildren(context: ExportContext, node: SyntaxNode): Promise<string> {
	return renderChildBlocks(context, node, (child) => SKIP_MARKS.has(child.name));
}

/**
 * フェンスコードまたは Mermaid を描画する
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - FencedCode
 * @returns ハイライトしたコード、または図の HTML
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - Table
 * @returns 結合と幅を反映した table
 */
async function renderTable(context: ExportContext, node: SyntaxNode): Promise<string> {
	const data      = extractTableData(context.state, node);
	const occupancy = buildTableOccupancy(data);
	const layout    = readTableLayout(data);
	const headCells = [];
	for (let index = 0; index < data.headers.length; index += 1) {
		if (isCoveredTableCell(occupancy, { row: 0, column: index })) {
			continue;
		}

		const span  = occupancy.cells[0]?.[index];
		const attrs = htmlCellAttribute(
			span?.colspan ?? 1,
			span?.rowspan ?? 1,
			parseCellSpan(data.headerSources[index]?.text ?? ''),
		);
		headCells.push(`<th${attrs}>${await tableCellToHtml(context, data.headers[index] ?? [])}</th>`);
	}

	const head     = headCells.length > 0
		? `<thead><tr${htmlRowHeightAttribute(layout.heights?.[0])}>${headCells.join('')}</tr></thead>`
		: '';
	const bodyRows = [];
	for (let rowIndex = 0; rowIndex < data.rows.length; rowIndex += 1) {
		const row   = data.rows[rowIndex]!;
		const cells = [];
		for (let index = 0; index < row.length; index += 1) {
			const position = { row: rowIndex + 1, column: index };
			if (isCoveredTableCell(occupancy, position)) {
				continue;
			}

			const span  = occupancy.cells[position.row]?.[position.column];
			const attrs = htmlCellAttribute(
				span?.colspan ?? 1,
				span?.rowspan ?? 1,
				parseCellSpan(data.rowSources[rowIndex]?.[index]?.text ?? ''),
			);
			cells.push(`<td${attrs}>${await tableCellToHtml(context, row[index] ?? [])}</td>`);
		}

		bodyRows.push(`<tr${htmlRowHeightAttribute(layout.heights?.[rowIndex + 1])}>${cells.join('')}</tr>`);
	}

	const colgroup   = htmlTableColGroup(layout.widths);
	const tableClass = layout.widths?.some((width) => width > 0) || layout.heights?.some((height) => height > 0)
		? 'cm-md-table is-resized'
		: 'cm-md-table';
	const tableWidth = (layout.widths ?? []).reduce((total, width) => total + (width > 0 ? clampColumnWidth(width) : 0), 0);
	const widthAttr  = tableWidth > 0 ? ` style="width:${tableWidth}px"` : '';
	return `<div class="cm-md-table-wrap"><table class="${tableClass}"${widthAttr}>${colgroup}${head}<tbody>${bodyRows.join('')}</tbody></table></div>`;
}

/**
 * セルの結合と配置を、HTML 属性の文字列にする
 * @param colspan - 横方向の結合数。1 のときは属性を出さない
 * @param rowspan - 縦方向の結合数。1 のときは属性を出さない
 * @param span - 水平と垂直の配置。未指定の方向は属性を出さない
 * @returns 先頭に空白を含む属性。何も無ければ空文字
 */
function htmlCellAttribute(
	colspan: number,
	rowspan: number,
	span: ReturnType<typeof parseCellSpan>,
): string {
	const parts: string[] = [];
	if (colspan > 1) {
		parts.push(` colspan="${colspan}"`);
	}

	if (rowspan > 1) {
		parts.push(` rowspan="${rowspan}"`);
	}

	const className = cellAlignmentClassNames(span);
	if (className.length > 0) {
		parts.push(` class="${className}"`);
	}

	return parts.join('');
}

/**
 * 列幅の colgroup を返す
 * @param widths - 列幅
 * @returns 列幅の colgroup。幅が無ければ空文字
 */
function htmlTableColGroup(widths: number[] | undefined): string {
	if (!widths || widths.every((width) => width <= 0)) {
		return '';
	}

	const cols = widths.map((width) => (
		width > 0 ? `<col style="width:${clampColumnWidth(width)}px">` : '<col>'
	));
	return `<colgroup>${cols.join('')}</colgroup>`;
}

/**
 * 行高属性を返す
 * @param height - 行高
 * @returns 行高の style 属性。高さが無ければ空文字
 */
function htmlRowHeightAttribute(height: number | undefined): string {
	return height && height > 0 ? ` style="height:${clampRowHeight(height)}px"` : '';
}

/**
 * セル AST を HTML にする
 * @param context - 変換中の構文木、装飾、画像解決
 * @param nodes - セル
 * @returns セルの中身の HTML
 */
async function tableCellToHtml(context: ExportContext, nodes: TableCellNode[]): Promise<string> {
	const parts = await Promise.all(nodes.map(async (node) => {
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

			return `<${node.tagName}${attrs}>${await tableCellToHtml(context, node.children)}</${node.tagName}>`;
		}

		if (node.kind === 'link') {
			return `<a class="cm-md-link" href="${escapeAttribute(node.href)}">${await tableCellToHtml(context, node.children)}</a>`;
		}

		if (node.kind === 'wikilink') {
			return `<span class="cm-md-wikilink">${await tableCellToHtml(context, node.children)}</span>`;
		}

		if (node.kind === 'image') {
			return renderTableCellImage(context, node.spec);
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
		return `<${tag} class="${className}">${await tableCellToHtml(context, node.children)}</${tag}>`;
	}));
	return parts.join('');
}

/**
 * 表セル内画像を HTML にする
 * @param context - 変換中の構文木、装飾、画像解決
 * @param spec - 画像
 * @returns セル内の img または代替表示
 */
async function renderTableCellImage(context: ExportContext, spec: ImageSpec): Promise<string> {
	const sizedClass = spec.width ? ' cm-md-image is-sized' : ' cm-md-image';
	const sizedStyle = imageWidthStyle(spec.width, spec.height);
	if (spec.kind === 'url' && !spec.raw.startsWith('data:') && !context.loadRemoteImages) {
		return imageFallback(spec.raw || 'リモート画像');
	}

	if (spec.kind === 'url') {
		return `<img class="${sizedClass.trim()}" src="${escapeAttribute(spec.raw)}" alt="${escapeAttribute(spec.alt)}"${sizedStyle}>`;
	}

	const dataUrl = await context.resolveImage({
		raw         : spec.raw,
		kind        : spec.kind,
		alt         : spec.alt,
		embed       : spec.kind === 'embed',
		documentPath: context.filePath,
	});
	if (!dataUrl) {
		return imageFallback(spec.raw);
	}

	return `<img class="${sizedClass.trim()}" src="${escapeAttribute(dataUrl)}" alt="${escapeAttribute(spec.alt)}"${sizedStyle}>`;
}

/**
 * 画像または埋め込み画像を描画する
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - Image / WikiEmbed
 * @returns 解決した img。未解決なら代替表示
 */
async function renderImage(context: ExportContext, node: SyntaxNode): Promise<string> {
	const embed                       = node.name === 'WikiEmbed';
	const extracted                   = embed
		? null
		: extractImageAltAndUrl(context.state, node);
	const altWithSize                 = extracted?.alt ?? '';
	const { alt, size: markdownSize } = splitImageAlt(altWithSize);
	const rawWithSize                 = embed
		? extractWikiEmbedPath(context.state, node)
		: extracted?.url ?? '';
	const parsedEmbed                 = embed ? splitWikiEmbedTarget(rawWithSize) : null;
	const raw                         = parsedEmbed?.path ?? rawWithSize;
	const size                        = parsedEmbed?.size ?? markdownSize;
	const kind                        = embed ? 'embed' : classifyImageSource(raw);
	const sizedClass                  = size.width ? ' cm-md-image is-sized' : ' cm-md-image';
	const sizedStyle                  = imageWidthStyle(size.width, size.height);

	if (kind === 'url' && !raw.startsWith('data:') && !context.loadRemoteImages) {
		return imageFallback(raw || 'リモート画像');
	}

	if (kind === 'url') {
		return `<img class="${sizedClass.trim()}" src="${escapeAttribute(raw)}" alt="${escapeAttribute(alt)}"${sizedStyle}>`;
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

	return `<img class="${sizedClass.trim()}" src="${escapeAttribute(dataUrl)}" alt="${escapeAttribute(alt)}"${sizedStyle}>`;
}

/**
 * 指定幅があるとき img の style を返す
 * @param width - 幅
 * @param height - 高さ
	 * @returns 幅の style。幅が無いときは空文字で、高さは幅があるときだけ付ける
 */
function imageWidthStyle(width: number | null, height: number | null): string {
	if (!width || width <= 0) {
		return '';
	}

	const heightCss = height && height > 0 ? ` height: ${height}px;` : ' height: auto;';
	return ` style="width: ${width}px; max-width: 100%;${heightCss}"`;
}

/**
 * 画像プレースホルダを返す
 * @param raw - 元パス
 * @returns 未解決画像の代替 HTML
 */
function imageFallback(raw: string): string {
	return `<span class="cm-md-image-fallback">画像を読み込めません: ${escapeHtml(raw)}</span>`;
}

/**
 * ノード配下のインラインを描画する
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - ノード
 * @param clipFrom - 切り出し開始
 * @param clipTo - 切り出し終了
 * @returns 切り出した範囲のインライン HTML
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - ノード
 * @returns そのインラインの HTML
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
		const raw         = context.state.doc.sliceString(pageFrom, pageTo);
		const split       = splitWikiLinkAlias(raw);
		const visibleFrom = split.alias ? pageFrom + split.hideLength : pageFrom;
		return `<span class="cm-md-wikilink">${emitDecorated(context, visibleFrom, pageTo)}</span>`;
	}

	if (node.name === 'Image' || node.name === 'WikiEmbed') {
		return renderImage(context, node);
	}

	if (node.name === 'HTMLBlock') {
		const raw = context.state.doc.sliceString(node.from, node.to);
		if (!isHtmlTableBlock(raw)) {
			return '';
		}

		const html = sanitizeHtmlTable(raw);
		return html ? `<div class="cm-md-table-wrap cm-md-html-table-wrap">${html}</div>` : '';
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - InlineCode
 * @returns 言語指定を除いた code 要素
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param node - Link / URL
 * @returns アンカーの HTML
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
 * @param raw - 生タグ
 * @returns 許可したタグ。それ以外はエスケープした文字
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
 * @param className - クラス
 * @param style - スタイル
 * @param extraClass - 追加クラス
 * @returns class と style を連結した属性。空なら空文字
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
 * @param code - コード
 * @param languageName - 言語
 * @returns 色クラスを付けた code の中身
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
 * @param code - コード
 * @param ranges - 範囲
 * @returns 範囲ごとの span を連結した HTML
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
 * @param context - 変換中の構文木、装飾、画像解決
 * @param from - 開始
 * @param to - 終了
 * @returns 装飾クラスを付けた HTML
 */
function emitDecorated(context: ExportContext, from: number, to: number): string {
	if (from >= to) {
		return '';
	}

	return decorateSlice(context.state.doc.sliceString(from, to), from, context.decorationRanges);
}

/**
 * カスタム装飾をテキストへ適用する
 * @param text - 生テキスト
 * @param rules - ルール
 * @returns 装飾を反映した HTML
 */
export function decorateText(text: string, rules: CompiledCustomDecorationRule[]): string {
	return decorateSlice(text, 0, collectCustomDecorationRangesFromText(text, rules, 0));
}

/**
 * スライスへ絶対座標の装飾を載せる
 * @param text - スライス
 * @param origin - スライス先頭のドキュメント座標
 * @param ranges - 装飾範囲
 * @returns スライス上の装飾を反映した HTML
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
 * @param svg - SVG
	 * @returns svg 要素があり、script を含まなければ true
 */
function isSafeSvg(svg: string): boolean {
	return /<svg[\s>]/i.test(svg) && !/<script/i.test(svg);
}
