import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { collectSourceLineNumbers, isPreviewLineNumber } from './cursorLine';
import { documentContextFacet } from './documentContext';
import { classifyImageSource, pushImageReplace, type ImageSpec } from './imageWidget';
import { splitImageAlt, splitWikiEmbedTarget } from './imageSize';
import type { DecorationEntry } from './inlineDecorations';
import {
	extractFencedCodeText,
	isMermaidFencedCode,
	pushMermaidReplace,
} from './mermaidWidget';
import { extractTableData, pushTableReplace } from './tableWidget';

/**
 * ノード範囲の全行がプレビュー行か判定する
 * @param {EditorState} state エディタ状態
 * @param {number} from 開始
 * @param {number} to 終了
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {boolean}
 */
function isFullyPreviewRange(
	state: EditorState,
	from: number,
	to: number,
	sourceLineNumbers: Set<number>,
): boolean {
	const startLine = state.doc.lineAt(from).number;
	const endLine   = state.doc.lineAt(Math.max(from, to - 1)).number;
	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
		if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
			return false;
		}
	}

	return true;
}

/**
 * Image ノードから alt / URL を取得する
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} imageNode Image ノード
 * @returns {{ alt: string; url: string }}
 */
export function extractImageAltAndUrl(
	state: EditorState,
	imageNode: SyntaxNode,
): { alt: string; url: string } {
	let url      = '';
	let altStart = imageNode.from;
	let altEnd   = imageNode.from;

	// ![alt](url) → LinkMark(![) ... LinkMark(]) LinkMark(() URL LinkMark())
	let afterOpen                                    = false;
	const marks: Array<{ from: number; to: number }> = [];

	imageNode.cursor().iterate((child) => {
		if (child.name === 'URL') {
			url = state.doc.sliceString(child.from, child.to).trim();
			return;
		}

		if (child.name === 'LinkMark') {
			marks.push({ from: child.from, to: child.to });
		}
	});

	if (marks.length >= 2) {
		const open  = marks[0]!;
		const close = marks[1]!;
		afterOpen   = true;
		altStart    = open.to;
		altEnd      = close.from;
	}

	const alt = afterOpen
		? state.doc.sliceString(altStart, altEnd)
		: '';

	return { alt, url };
}

/**
 * WikiEmbed からパスを取得する
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} node WikiEmbed ノード
 * @returns {string}
 */
export function extractWikiEmbedPath(state: EditorState, node: SyntaxNode): string {
	let path = '';
	node.cursor().iterate((child) => {
		if (child.name === 'WikiEmbedPath') {
			path = state.doc.sliceString(child.from, child.to).trim();
		}
	});
	return path;
}

/**
 * テーブル・画像・Mermaid のブロック / インライン widget 装飾を収集する
 * @param {EditorState} state エディタ状態
 * @param {Set<number>} [sourceLineNumbers] ソース行集合
 * @returns {DecorationEntry[]}
 */
export function collectBlockDecorationEntries(
	state: EditorState,
	sourceLineNumbers: Set<number> = collectSourceLineNumbers(state),
): DecorationEntry[] {
	const entries: DecorationEntry[] = [];
	const context                    = state.facet(documentContextFacet);

	syntaxTree(state).iterate({
		/**
		 * @param {{ name: string; from: number; to: number; node: SyntaxNode }} ref ノード
		 * @returns {boolean | void}
		 */
		enter(ref) {
			if (ref.name === 'FencedCode') {
				if (!isMermaidFencedCode(state, ref.node)) {
					return false;
				}

				if (!isFullyPreviewRange(state, ref.from, ref.to, sourceLineNumbers)) {
					return false;
				}

				const source = extractFencedCodeText(state, ref.node);
				pushMermaidReplace(entries, ref.from, ref.to, source);
				return false;
			}

			if (ref.name === 'Table') {
				const data = extractTableData(state, ref.node);
				if (data.headers.length === 0 && data.rows.length === 0) {
					return false;
				}

				pushTableReplace(entries, ref.from, ref.to, data);
				return false;
			}

			if (ref.name === 'Image') {
				const lineNumber = state.doc.lineAt(ref.from).number;
				if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
					return false;
				}

				const { alt, url } = extractImageAltAndUrl(state, ref.node);
				if (!url) {
					return false;
				}

				const { alt: altText, size } = splitImageAlt(alt);
				const kind                   = classifyImageSource(url);
				const spec: ImageSpec        = {
					alt              : altText,
					raw              : url,
					kind,
					documentPath     : context.filePath,
					loadRemoteImages : context.loadRemoteImages,
					width            : size.width,
					height           : size.height,
				};
				pushImageReplace(entries, ref.from, ref.to, spec);
				return false;
			}

			if (ref.name === 'WikiEmbed') {
				const lineNumber = state.doc.lineAt(ref.from).number;
				if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
					return false;
				}

				const rawPath = extractWikiEmbedPath(state, ref.node);
				if (!rawPath) {
					return false;
				}

				const { path, size }  = splitWikiEmbedTarget(rawPath);
				const spec: ImageSpec = {
					alt              : path,
					raw              : path,
					kind             : 'embed',
					documentPath     : context.filePath,
					loadRemoteImages : context.loadRemoteImages,
					width            : size.width,
					height           : size.height,
				};
				pushImageReplace(entries, ref.from, ref.to, spec);
				return false;
			}
		},
	});

	return entries;
}
