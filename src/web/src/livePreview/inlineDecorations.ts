/**
 * インライン記法のマークを隠し、強調やリンクの範囲へ mark を付ける
 * エディタ状態は持たず、選択が記法にかかっている範囲はソースのまま残す
 * @file
 */
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
import { splitWikiLinkAlias } from './wikiLink';

// ----------------------------------------------
// 対象にする構文
// ----------------------------------------------
/** 隠す記法トークンのノード名。実行中は変えない */
const MARK_NODE_NAMES = new Set([
	'EmphasisMark',
	'CodeMark',
	'LinkMark',
	'StrikethroughMark',
	'HighlightMark',
	'WikiLinkMark',
]);

/** 中身へ mark を付けるインラインノード名。実行中は変えない */
const CONTAINER_NODE_NAMES = new Set([
	'Emphasis',
	'StrongEmphasis',
	'Strikethrough',
	'Highlight',
	'Link',
	'WikiLink',
	'InlineCode',
]);

/** 文書範囲と、そこへ付ける Decoration。コレクタの共通の戻り */
type DecorationEntry = {
	/** 装飾の開始位置 */
	from: number;
	/** 装飾の終端。点装飾では from と同じ */
	to: number;
	/** その範囲へ付ける CodeMirror の装飾 */
	decoration: Decoration;
};

export type { DecorationEntry };

/**
 * Link ノードから URL 文字列を取得する
 * @param state - エディタ状態
 * @param linkNode - Link ノード
 * @returns Link ノードから URL 文字列
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
 * @param linkNode - Link ノード
 * @returns Link ノードの表示文字範囲
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
 * @param entries - エントリ配列
 * @param from - 開始位置
 * @param to - 終了位置
 */
function pushHiddenMark(entries: DecorationEntry[], from: number, to: number): void {
	pushHiddenReplace(entries, from, to);
}

/**
 * 強調系ノードの装飾エントリを追加する
 * @param node - 構文ノード
 * @param className - 内容用 CSS クラス
 * @param entries - エントリ配列
 * @param hideMarks - 非表示対象ノード名
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
 * 既知言語の `{java}` 接頭辞は、キャレットが重ならないときだけ隠す（`}` 直後の空白も含む。スペース自体は不要）
 * キャレットが内部にあるときはバッククォートと接頭辞を表示し、コード背景は記法を含む範囲へ付ける
 * @param node - InlineCode ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param hideMarks - 記法を隠すなら true
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
			 * @param child - 子ノード
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
 * @param node - Link ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
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
 * `|` または表セル用の `\|` があるときは右側のラベルだけを出す
 * @param node - WikiLink ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 */
function decorateWikiLink(node: SyntaxNode, state: EditorState, entries: DecorationEntry[]): void {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.name === 'WikiLinkMark') {
			pushHiddenMark(entries, child.from, child.to);
			continue;
		}

		if (child.name !== 'WikiLinkPage' || child.from >= child.to) {
			continue;
		}

		const raw         = state.doc.sliceString(child.from, child.to);
		const split       = splitWikiLinkAlias(raw);
		const visibleFrom = split.alias ? child.from + split.hideLength : child.from;
		if (visibleFrom > child.from) {
			pushHiddenMark(entries, child.from, visibleFrom);
		}

		if (visibleFrom < child.to) {
			entries.push({
				from      : visibleFrom,
				to        : child.to,
				decoration: Decoration.mark({ class: 'cm-md-wikilink' }),
			});
		}
	}
}

// ----------------------------------------------
// インライン装飾の収集
// ----------------------------------------------
/**
 * ライブプレビュー行のインライン装飾エントリを収集する
 * @param state - エディタ状態
 * @returns 集めたライブプレビュー行のインライン装飾エントリ。該当が無ければ空
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
		 * @param ref - ノード参照
		 * @returns 子の走査を止めるとき false。続けるときは値を返さない
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
					// ここでは子ノードの走査を止めない
					return;
				case 'WikiLink':
					if (revealSource) {
						return;
					}

					decorateWikiLink(ref.node, state, entries);
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
 * @param entries - エントリ配列
 * @returns Decoration エントリから DecorationSet
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
 * @param state - エディタ状態
 * @returns インライン装飾のみの DecorationSet を構築する（テスト用）
 */
export function buildInlineDecorationsForTest(state: EditorState): DecorationSet {
	return buildDecorationSet(collectInlineDecorationEntries(state));
}
