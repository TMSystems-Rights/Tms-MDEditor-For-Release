import { Decoration, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
	collectInlineCodeContentRanges,
	parseInlineCodeLanguagePrefix,
	resolveCodeLanguage,
} from '../editor/codeLanguage';
import { selectionIntersectsRange } from './cursorLine';
import { pushHiddenReplace } from './hiddenContent';

const MARK_NODE_NAMES = new Set([
	'EmphasisMark',
	'CodeMark',
	'LinkMark',
	'StrikethroughMark',
	'HighlightMark',
	'WikiLinkMark',
]);

const CONTAINER_NODE_NAMES = new Set([
	'Emphasis',
	'StrongEmphasis',
	'Strikethrough',
	'Highlight',
	'Link',
	'WikiLink',
	'InlineCode',
]);

type DecorationEntry = {
	from: number;
	to: number;
	decoration: Decoration;
};

export type { DecorationEntry };

/**
 * Link ノードから URL 文字列を取得する
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} linkNode Link ノード
 * @returns {string}
 */
export function extractLinkUrl(state: EditorState, linkNode: SyntaxNode): string {
	let url = '';
	linkNode.cursor().iterate((child) => {
		if (child.name === 'URL') {
			url = state.doc.sliceString(child.from, child.to);
		}
	});
	return url.trim();
}

/**
 * Link ノードの表示文字範囲を取得する
 * @param {SyntaxNode} linkNode Link ノード
 * @returns {Array<{ from: number; to: number }>}
 */
export function collectLinkLabelRanges(linkNode: SyntaxNode): Array<{ from: number; to: number }> {
	const linkMarks: Array<{ from: number; to: number }> = [];
	linkNode.cursor().iterate((child) => {
		if (child.name === 'LinkMark') {
			linkMarks.push({ from: child.from, to: child.to });
		}
	});

	if (linkMarks.length < 2 || linkMarks[0].to >= linkMarks[1].from) {
		return [];
	}

	return [{ from: linkMarks[0].to, to: linkMarks[1].from }];
}

/**
 * 記法トークン非表示 Decoration エントリを追加する
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} from 開始位置
 * @param {number} to 終了位置
 * @returns {void}
 */
function pushHiddenMark(entries: DecorationEntry[], from: number, to: number): void {
	pushHiddenReplace(entries, from, to);
}

/**
 * 強調系ノードの装飾エントリを追加する
 * @param {SyntaxNode} node 構文ノード
 * @param {string} className 内容用 CSS クラス
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {Set<string>} hideMarks 非表示対象ノード名
 * @returns {void}
 */
function decorateEmphasisLike(
	node: SyntaxNode,
	className: string,
	entries: DecorationEntry[],
	hideMarks: Set<string>,
): void {
	let firstMarkEnd: number | null  = null;
	let lastMarkStart: number | null = null;
	let decoratedChild               = false;

	node.cursor().iterate((child) => {
		if (hideMarks.has(child.name)) {
			pushHiddenMark(entries, child.from, child.to);
			if (child.node.parent === node) {
				if (firstMarkEnd === null) {
					firstMarkEnd = child.to;
				}

				lastMarkStart = child.from;
			}

			return;
		}

		if (CONTAINER_NODE_NAMES.has(child.name) || child.from >= child.to) {
			return;
		}

		decoratedChild = true;
		entries.push({
			from      : child.from,
			to        : child.to,
			decoration: Decoration.mark({ class: className }),
		});
	});

	// プレーンテキストのみの場合はマーク間をまとめて装飾する
	if (
		!decoratedChild
		&& firstMarkEnd !== null
		&& lastMarkStart !== null
		&& firstMarkEnd < lastMarkStart
	) {
		entries.push({
			from      : firstMarkEnd,
			to        : lastMarkStart,
			decoration: Decoration.mark({ class: className }),
		});
	}
}

/**
 * インラインコードの装飾エントリを追加する
 * 既知言語の `{java}` 接頭辞は、キャレットが重ならないときだけ隠す（`}` 直後の空白も含む。スペース自体は不要）。
 * キャレットが内部にあるときはバッククォートと接頭辞を表示し、コード背景は記法を含む範囲へ付ける。
 * @param {SyntaxNode} node InlineCode ノード
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {boolean} hideMarks 記法を隠すなら true
 * @returns {void}
 */
function decorateInlineCode(
	node: SyntaxNode,
	state: EditorState,
	entries: DecorationEntry[],
	hideMarks: boolean,
): void {
	if (hideMarks) {
		node.cursor().iterate(
			/**
			 * CodeMark を隠す
			 * @param {{ name: string; from: number; to: number }} child 子ノード
			 * @returns {void}
			 */
			(child) => {
				if (child.name === 'CodeMark') {
					pushHiddenMark(entries, child.from, child.to);
				}
			},
		);
	} else {
		entries.push({
			from      : node.from,
			to        : node.to,
			decoration: Decoration.mark({ class: 'cm-md-code' }),
		});
	}

	for (const range of collectInlineCodeContentRanges(node)) {
		const content = state.doc.sliceString(range.from, range.to);
		const prefix  = parseInlineCodeLanguagePrefix(content);
		if (hideMarks && prefix && resolveCodeLanguage(prefix.language)) {
			pushHiddenMark(entries, range.from, range.from + prefix.prefixLength);
		}

		if (!hideMarks) {
			continue;
		}

		entries.push({
			from      : range.from,
			to        : range.to,
			decoration: Decoration.mark({ class: 'cm-md-code' }),
		});
	}
}

/**
 * リンクの装飾エントリを追加する
 * @param {SyntaxNode} node Link ノード
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @returns {void}
 */
function decorateLink(
	node: SyntaxNode,
	state: EditorState,
	entries: DecorationEntry[],
): void {
	const url = extractLinkUrl(state, node);

	node.cursor().iterate((child) => {
		if (child.name === 'LinkMark' || child.name === 'URL' || child.name === 'LinkTitle') {
			pushHiddenMark(entries, child.from, child.to);
		}
	});

	for (const range of collectLinkLabelRanges(node)) {
		entries.push({
			from      : range.from,
			to        : range.to,
			decoration: Decoration.mark({
				class     : 'cm-md-link',
				attributes: url ? { 'data-href': url } : undefined,
			}),
		});
	}
}

/**
 * WikiLink の装飾エントリを追加する（遷移なし・見た目のみ）
 * @param {SyntaxNode} node WikiLink ノード
 * @param {DecorationEntry[]} entries エントリ配列
 * @returns {void}
 */
function decorateWikiLink(node: SyntaxNode, entries: DecorationEntry[]): void {
	node.cursor().iterate((child) => {
		if (child.name === 'WikiLinkMark') {
			pushHiddenMark(entries, child.from, child.to);
			return;
		}

		if (child.name !== 'WikiLinkPage' || child.from >= child.to) {
			return;
		}

		entries.push({
			from      : child.from,
			to        : child.to,
			decoration: Decoration.mark({ class: 'cm-md-wikilink' }),
		});
	});
}

/**
 * ライブプレビュー行のインライン装飾エントリを収集する
 * @param {EditorState} state エディタ状態
 * @returns {DecorationEntry[]}
 */
export function collectInlineDecorationEntries(
	state: EditorState,
	_sourceLineNumbers?: Set<number>,
): DecorationEntry[] {
	const entries: DecorationEntry[] = [];
	const hideMarks                  = new Set(MARK_NODE_NAMES);

	syntaxTree(state).iterate({
		/**
		 * 構文木を走査して装飾エントリを収集する
		 * @param {{ name: string; from: number; node: SyntaxNode }} ref ノード参照
		 * @returns {boolean | void}
		 */
		enter(ref) {
			const revealSource = selectionIntersectsRange(state, ref.from, ref.node.to);

			switch (ref.name) {
				case 'Emphasis':
					if (revealSource) {
						return;
					}

					decorateEmphasisLike(ref.node, 'cm-md-em', entries, hideMarks);
					return false;
				case 'StrongEmphasis':
					if (revealSource) {
						return;
					}

					decorateEmphasisLike(ref.node, 'cm-md-strong', entries, hideMarks);
					return false;
				case 'Strikethrough':
					if (revealSource) {
						return;
					}

					decorateEmphasisLike(ref.node, 'cm-md-strike', entries, hideMarks);
					return false;
				case 'Highlight':
					if (revealSource) {
						return;
					}

					decorateEmphasisLike(ref.node, 'cm-md-highlight', entries, hideMarks);
					return false;
				case 'InlineCode':
					// 記法の表示／非表示はキャレット交差に従うが、コード背景は常に維持する
					decorateInlineCode(ref.node, state, entries, !revealSource);
					return false;
				case 'Link':
					if (!revealSource) {
						decorateLink(ref.node, state, entries);
					}

					// Link 表示文字列内の InlineCode なども個別に装飾するため、
					// ここでは子ノードの走査を止めない。
					return;
				case 'WikiLink':
					if (revealSource) {
						return;
					}

					decorateWikiLink(ref.node, entries);
					return false;
				default:
					return;
			}
		},
	});

	return entries;
}

/**
 * Decoration エントリから DecorationSet を構築する
 * @param {DecorationEntry[]} entries エントリ配列
 * @returns {DecorationSet}
 */
export function buildDecorationSet(entries: DecorationEntry[]): DecorationSet {
	if (entries.length === 0) {
		return Decoration.none;
	}

	const sorted = [...entries].sort((left, right) => {
		if (left.from !== right.from) {
			return left.from - right.from;
		}

		return left.to - right.to;
	});

	const builder = new RangeSetBuilder<Decoration>();
	for (const entry of sorted) {
		builder.add(entry.from, entry.to, entry.decoration);
	}

	return builder.finish();
}

/**
 * インライン装飾のみの DecorationSet を構築する（テスト用）
 * @param {EditorState} state エディタ状態
 * @returns {DecorationSet}
 */
export function buildInlineDecorationsForTest(state: EditorState): DecorationSet {
	return buildDecorationSet(collectInlineDecorationEntries(state));
}
