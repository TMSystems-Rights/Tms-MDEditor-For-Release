import { Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { selectionIntersectsRange } from './cursorLine';
import { pushHiddenReplace } from './hiddenContent';
import {
	buildHtmlMarkSpec,
	parseHtmlTag,
	sanitizeHtmlAttributes,
	type ParsedHtmlTag,
} from './htmlSanitizer';
import type { DecorationEntry } from './inlineDecorations';

/**
 * `<br>` を視覚的な改行として見せるウィジェット
 */
class HtmlBreakWidget extends WidgetType {
	/**
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof HtmlBreakWidget;
	}

	/**
	 * @returns {HTMLElement}
	 */
	toDOM(): HTMLElement {
		return document.createElement('br');
	}

	/**
	 * @returns {number}
	 */
	get estimatedHeight(): number {
		return 0;
	}

	/**
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

const htmlBreakWidget = new HtmlBreakWidget();

type HtmlTagOccurrence = {
	from: number;
	to: number;
	parsed: ParsedHtmlTag;
};

/**
 * 位置が Table ノード内か（テーブル widget 側で描画するため本文装飾から除外）
 * @param {SyntaxNode} node ノード
 * @returns {boolean}
 */
function isInsideTable(node: SyntaxNode): boolean {
	for (let current: SyntaxNode | null = node; current; current = current.parent) {
		if (current.name === 'Table') {
			return true;
		}
	}

	return false;
}

/**
 * 許可タグの開閉を突き合わせて本文用 Decoration を積む
 * @param {DecorationEntry[]} entries エントリ
 * @param {HtmlTagOccurrence[]} tags 出現順のタグ
 * @returns {void}
 */
function pushPairedHtmlDecorations(
	state: EditorState,
	entries: DecorationEntry[],
	tags: HtmlTagOccurrence[],
): void {
	type StackItem = {
		tag: HtmlTagOccurrence;
		attributes: ReturnType<typeof sanitizeHtmlAttributes>;
	};

	const stack: StackItem[] = [];

	for (const tag of tags) {
		const { parsed } = tag;

		if (!parsed.allowed) {
			continue;
		}

		if (parsed.kind === 'selfClosing' || (parsed.kind === 'open' && parsed.name === 'br')) {
			if (selectionIntersectsRange(state, tag.from, tag.to)) {
				continue;
			}

			entries.push({
				from      : tag.from,
				to        : tag.to,
				decoration: Decoration.replace({
					widget: htmlBreakWidget,
				}),
			});
			continue;
		}

		if (parsed.kind === 'open') {
			stack.push({
				tag,
				attributes: sanitizeHtmlAttributes(parsed.attributes),
			});
			continue;
		}

		if (parsed.kind !== 'close') {
			continue;
		}

		// 対応する開タグをスタックから探す（不正ネストは途中を破棄）
		let openIndex = -1;
		for (let index = stack.length - 1; index >= 0; index -= 1) {
			if (stack[index]!.tag.parsed.name === parsed.name) {
				openIndex = index;
				break;
			}
		}

		if (openIndex < 0) {
			continue;
		}

		const open   = stack[openIndex]!;
		stack.length = openIndex;
		if (selectionIntersectsRange(state, open.tag.from, tag.to)) {
			continue;
		}

		pushHiddenReplace(entries, open.tag.from, open.tag.to);
		pushHiddenReplace(entries, tag.from, tag.to);

		const contentFrom = open.tag.to;
		const contentTo   = tag.from;
		if (contentFrom < contentTo) {
			const markSpec = buildHtmlMarkSpec(parsed.name, open.attributes);
			entries.push({
				from      : contentFrom,
				to        : contentTo,
				decoration: Decoration.mark(markSpec),
			});
		}
	}
}

/**
 * プレビュー行の許可インライン HTML を装飾する（`<br>` 含む）
 * InlineCode / FencedCode 内は構文上 HTMLTag にならないため対象外
 * Table 内は tableWidget 側で処理する
 * @param {EditorState} state エディタ状態
 * @param {Set<number>} [sourceLineNumbers] ソース行集合
 * @returns {DecorationEntry[]}
 */
export function collectHtmlDecorationEntries(
	state: EditorState,
	_sourceLineNumbers?: Set<number>,
): DecorationEntry[] {
	const entries: DecorationEntry[] = [];
	const tags: HtmlTagOccurrence[]  = [];

	syntaxTree(state).iterate({
		/**
		 * @param {{ name: string; from: number; to: number; node: SyntaxNode }} ref ノード
		 * @returns {boolean | void}
		 */
		enter(ref) {
			if (ref.name !== 'HTMLTag') {
				return;
			}

			if (isInsideTable(ref.node)) {
				return;
			}

			const raw    = state.doc.sliceString(ref.from, ref.to);
			const parsed = parseHtmlTag(raw);
			if (!parsed) {
				return;
			}

			tags.push({
				from: ref.from,
				to  : ref.to,
				parsed,
			});
		},
	});

	pushPairedHtmlDecorations(state, entries, tags);
	return entries;
}

/**
 * @deprecated collectHtmlDecorationEntries を使用する
 * @param {EditorState} state エディタ状態
 * @param {Set<number>} [sourceLineNumbers] ソース行集合
 * @returns {DecorationEntry[]}
 */
export function collectHtmlBreakDecorationEntries(
	state: EditorState,
	sourceLineNumbers?: Set<number>,
): DecorationEntry[] {
	return collectHtmlDecorationEntries(state, sourceLineNumbers);
}
