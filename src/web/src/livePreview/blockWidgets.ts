/**
 * 表、画像、Mermaid、HTML 表を、プレビュー行のウィジェット装飾へ集める
 * エディタ状態は持たず、各ウィジェットの生成は対応するモジュールへ渡す
 * @file
 */
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
import { isHtmlTableBlock } from './htmlTable';
import { pushHtmlTableReplace } from './htmlTableWidget';

// ----------------------------------------------
// 範囲と画像記法の読み取り
// ----------------------------------------------

/**
 * ノード範囲のすべての行がプレビュー行かを判定する
 * 1 行でもソース表示なら、ブロック全体をウィジェットにしない
 * @param state - 行境界を読むエディタ状態
 * @param from - 範囲の開始位置。この位置の行から見る
 * @param to - 範囲の終端。終端ちょうどは手前の行までを見る
 * @param sourceLineNumbers - ソース表示の行番号。1 始まり
 * @returns 範囲内の全行がプレビューなら true
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
 * Image ノードから alt と URL を取り出す
 * 開きと閉じの LinkMark が 2 つ無ければ alt は空。URL ノードが無ければ url は空
 * @param state - ノード範囲の文字列を読むエディタ状態
 * @param imageNode - alt と URL を含む Image ノード
 * @returns alt はサイズ指定を含み得る文面、url はトリム済みの参照
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
 * WikiEmbed から、サイズ指定を含み得るパスを取り出す
 * WikiEmbedPath が無ければ空文字を返す
 * @param state - ノード範囲の文字列を読むエディタ状態
 * @param node - パスを含む WikiEmbed ノード
 * @returns トリム済みのパス。見つからなければ空文字
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

// ----------------------------------------------
// ブロック装飾の収集
// ----------------------------------------------

/**
 * 表、画像、Mermaid、HTML 表のウィジェット装飾を集める
 * 画像のパス解決に必要な文脈は documentContextFacet から読む。状態は変えない
 * @param state - 構文木と文書文脈を読むエディタ状態
 * @param sourceLineNumbers - ソース表示の行番号。省略時は選択から作る
 * @returns ブロックウィジェットの装飾。空の表やソース行の画像は含めない
 */
export function collectBlockDecorationEntries(
	state: EditorState,
	sourceLineNumbers: Set<number> = collectSourceLineNumbers(state),
): DecorationEntry[] {
	const entries: DecorationEntry[] = [];
	const context                    = state.facet(documentContextFacet);

	syntaxTree(state).iterate({
		/**
		 * 表、画像、Mermaid、HTML 表を装飾へ置き、対象にしたノードの子は走査しない
		 * @param ref - 構文木のノード。name で種別、from と to で文書上の範囲を見る
		 * @returns 子を走査しないとき false。対象外は undefined
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

			if (ref.name === 'HTMLBlock') {
				const raw = state.doc.sliceString(ref.from, ref.to);
				if (!isHtmlTableBlock(raw) || !isFullyPreviewRange(state, ref.from, ref.to, sourceLineNumbers)) {
					return false;
				}

				pushHtmlTableReplace(entries, ref.from, ref.to, raw);
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
