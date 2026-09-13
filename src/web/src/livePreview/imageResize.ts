import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { formatMarkdownImage, formatWikiEmbed, splitImageAlt, splitWikiEmbedTarget } from './imageSize';

export type ImageMarkupKind = 'WikiEmbed' | 'Image';

export type ImageMarkupRange = {
	from: number;
	to: number;
	kind: ImageMarkupKind;
};

/**
 * 指定位置の画像記法へ表示幅を書き戻す
 * @param {EditorView} view エディタ
 * @param {number} pos 画像ウィジェット位置
 * @param {number} width 幅（px）
 * @param {number} [end] 記法の終了位置
 * @returns {boolean} 更新したか
 */
export function applyImageDisplayWidth(
	view: EditorView,
	pos: number,
	width: number,
	end?: number,
): boolean {
	const rounded = Math.max(24, Math.round(width));
	ensureSyntaxTree(view.state, view.state.doc.length, 200);
	const markup = findImageMarkupAt(view.state, pos, end);
	if (!markup) {
		return false;
	}

	const text        = view.state.sliceDoc(markup.from, markup.to);
	const escapePipe  = isInsideTable(view.state, markup.from);
	const sizeOptions = { escapePipe };
	let insert        = '';
	if (markup.kind === 'WikiEmbed') {
		if (!text.startsWith('![[') || !text.endsWith(']]')) {
			return false;
		}

		const { path } = splitWikiEmbedTarget(text.slice(3, -2));
		insert         = formatWikiEmbed(path, rounded, sizeOptions);
	} else {
		const closeAlt = text.indexOf('](');
		if (!text.startsWith('![') || closeAlt < 0 || !text.endsWith(')')) {
			return false;
		}

		const alt           = text.slice(2, closeAlt);
		const url           = text.slice(closeAlt + 2, -1);
		const { alt: name } = splitImageAlt(alt);
		insert              = formatMarkdownImage(name, url, rounded, sizeOptions);
	}

	if (insert === text) {
		return false;
	}

	view.dispatch({
		changes  : { from: markup.from, to: markup.to, insert },
		userEvent: 'input.imageResize',
	});
	return true;
}

/**
 * 行テキストだけを見て画像幅を書き戻す。
 * 表の構文木が未完成でも、セルの `|` を増やさずに `\|幅` を残せる。
 * @param {EditorView} view エディタ
 * @param {number} pos 画像位置
 * @param {number} width 幅（px）
 * @returns {boolean} 更新したか
 */
export function applyImageWidthOnDocumentLine(
	view: EditorView,
	pos: number,
	width: number,
): boolean {
	const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
	const line    = view.state.doc.lineAt(clamped);
	const insert  = replaceImageWidthInCellText(line.text, width, /^\s*\|/.test(line.text));
	if (insert === null || insert === line.text) {
		return false;
	}

	view.dispatch({
		changes  : { from: line.from, to: line.to, insert },
		userEvent: 'input.imageResize',
	});
	return true;
}

/**
 * パスを比較用に正規化する
 * @param {string} path 画像パス
 * @returns {string}
 */
export function normalizeImagePathKey(path: string): string {
	return path.trim().replaceAll('/', '\\').toLowerCase();
}

/**
 * 文書内の画像パスを探して幅を書き戻す。
 * 表セルでは列が割れないよう `\|幅` にする。
 * @param {EditorView} view エディタ
 * @param {string} path 画像パス
 * @param {number} width 幅（px）
 * @param {number} [hintPos] 優先する文書位置
 * @returns {boolean} 更新したか
 */
export function applyImageWidthByPath(
	view: EditorView,
	path: string,
	width: number,
	hintPos?: number,
): boolean {
	const pathKey = path.trim();
	if (!pathKey) {
		return false;
	}

	const rounded                                   = Math.max(24, Math.round(width));
	const wanted                                    = normalizeImagePathKey(pathKey);
	const doc                                       = view.state.doc.toString();
	const wiki                                      = /!\[\[([\s\S]*?)\]\]/g;
	let match                                       = wiki.exec(doc);
	let chosen: { from: number; to: number } | null = null;
	while (match) {
		const { path: embedPath } = splitWikiEmbedTarget(match[1] ?? '');
		if (normalizeImagePathKey(embedPath) !== wanted) {
			match = wiki.exec(doc);
			continue;
		}

		const from         = match.index;
		const to           = from + match[0].length;
		const containsHint = hintPos !== undefined
			&& Number.isFinite(hintPos)
			&& hintPos >= from
			&& hintPos <= to;
		if (containsHint) {
			chosen = { from, to };
			break;
		}

		if (!chosen) {
			chosen = { from, to };
		}

		match = wiki.exec(doc);
	}

	if (!chosen) {
		return false;
	}

	const text       = doc.slice(chosen.from, chosen.to);
	const line       = view.state.doc.lineAt(chosen.from);
	const escapePipe = /^\s*\|/.test(line.text);
	if (!text.startsWith('![[') || !text.endsWith(']]')) {
		return false;
	}

	const { path: embedPath } = splitWikiEmbedTarget(text.slice(3, -2));
	const insert              = formatWikiEmbed(embedPath, rounded, { escapePipe });
	if (insert === text) {
		return false;
	}

	view.dispatch({
		changes  : { from: chosen.from, to: chosen.to, insert },
		userEvent: 'input.imageResize',
	});
	return true;
}

/**
 * 文書位置にある画像記法の範囲を返す
 * @param {import('@codemirror/state').EditorState} state 状態
 * @param {number} pos 開始位置
 * @param {number} [end] 終了位置
 * @returns {ImageMarkupRange | null}
 */
export function findImageMarkupAt(
	state: EditorState,
	pos: number,
	end?: number,
): ImageMarkupRange | null {
	const from = Math.max(0, Math.min(pos, state.doc.length));
	if (end !== undefined && Number.isFinite(end) && end > from) {
		const exact = classifyImageMarkup(state.sliceDoc(from, Math.min(end, state.doc.length)));
		if (exact) {
			return { from, to: Math.min(end, state.doc.length), kind: exact };
		}
	}

	const fromTree = findImageMarkupInTree(state, from);
	if (fromTree) {
		return fromTree;
	}

	return scanImageMarkupOnLine(state, from);
}

/**
 * 記法文字列の種別を返す
 * @param {string} text 記法
 * @returns {ImageMarkupKind | null}
 */
function classifyImageMarkup(text: string): ImageMarkupKind | null {
	if (text.startsWith('![[') && text.endsWith(']]') && text.length > 5) {
		return 'WikiEmbed';
	}

	const closeAlt = text.indexOf('](');
	if (text.startsWith('![') && closeAlt >= 0 && text.endsWith(')')) {
		return 'Image';
	}

	return null;
}

/**
 * 構文木から画像記法を探す
 * @param {import('@codemirror/state').EditorState} state 状態
 * @param {number} pos 位置
 * @returns {ImageMarkupRange | null}
 */
function findImageMarkupInTree(state: EditorState, pos: number): ImageMarkupRange | null {
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
	while (node && node.name !== 'WikiEmbed' && node.name !== 'Image') {
		node = node.parent;
	}

	if (!node || (node.name !== 'WikiEmbed' && node.name !== 'Image')) {
		return null;
	}

	return {
		from: node.from,
		to  : node.to,
		kind: node.name,
	};
}

/**
 * 行内の `![[ ]]` / `![]()` を探す
 * @param {import('@codemirror/state').EditorState} state 状態
 * @param {number} pos 位置
 * @returns {ImageMarkupRange | null}
 */
function scanImageMarkupOnLine(state: EditorState, pos: number): ImageMarkupRange | null {
	const line = state.doc.lineAt(pos);
	const wiki = /!\[\[[\s\S]*?\]\]/g;
	let match  = wiki.exec(line.text);
	while (match) {
		const from = line.from + match.index;
		const to   = from + match[0].length;
		if (pos >= from && pos <= to) {
			return { from, to, kind: 'WikiEmbed' };
		}

		match = wiki.exec(line.text);
	}

	const markdown = /!\[[^\]]*\]\([^)]+\)/g;
	match          = markdown.exec(line.text);
	while (match) {
		const from = line.from + match.index;
		const to   = from + match[0].length;
		if (pos >= from && pos <= to) {
			return { from, to, kind: 'Image' };
		}

		match = markdown.exec(line.text);
	}

	return null;
}

/**
 * 指定位置が GFM 表の中か判定する
 * @param {import('@codemirror/state').EditorState} state 状態
 * @param {number} pos 位置
 * @returns {boolean}
 */
function isInsideTable(state: EditorState, pos: number): boolean {
	let current: SyntaxNode | null = syntaxTree(state).resolveInner(Math.min(pos, state.doc.length), 1);
	while (current) {
		if (current.name === 'Table') {
			return true;
		}

		current = current.parent;
	}

	return /^\s*\|/.test(state.doc.lineAt(pos).text);
}

/**
 * セル文字列内の先頭画像へ表示幅を書き戻した文字列を返す
 * @param {string} text セルソース
 * @param {number} width 幅（px）
 * @param {boolean} [escapePipe=true] 表セルなら `\|`
 * @returns {string | null} 変更後。画像が無ければ null
 */
export function replaceImageWidthInCellText(
	text: string,
	width: number,
	escapePipe: boolean = true,
): string | null {
	const rounded     = Math.max(24, Math.round(width));
	const sizeOptions = { escapePipe };
	const wiki        = /!\[\[[\s\S]*?\]\]/;
	const wikiMatch   = wiki.exec(text);
	if (wikiMatch) {
		const { path } = splitWikiEmbedTarget(wikiMatch[0].slice(3, -2));
		const insert   = formatWikiEmbed(path, rounded, sizeOptions);
		return `${text.slice(0, wikiMatch.index)}${insert}${text.slice(wikiMatch.index + wikiMatch[0].length)}`;
	}

	const markdown      = /!\[[^\]]*\]\([^)]+\)/;
	const markdownMatch = markdown.exec(text);
	if (!markdownMatch) {
		return null;
	}

	const raw      = markdownMatch[0];
	const closeAlt = raw.indexOf('](');
	if (closeAlt < 0) {
		return null;
	}

	const { alt: name } = splitImageAlt(raw.slice(2, closeAlt));
	const insert        = formatMarkdownImage(name, raw.slice(closeAlt + 2, -1), rounded, sizeOptions);
	return `${text.slice(0, markdownMatch.index)}${insert}${text.slice(markdownMatch.index + raw.length)}`;
}
