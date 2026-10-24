/**
 * プレビュー上の許可インライン HTML を、隠し装飾、mark、改行ウィジェットへ分ける
 * エディタ状態は持たず、表の中のタグは tableWidget に任せる
 * @file
 */
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

// ----------------------------------------------
// 改行ウィジェット
// ----------------------------------------------

/**
 * `<br>` を視覚的な改行として見せるウィジェット
 * インラインなので、ブロック高さの見積もりは 0 に固定する
 */
class HtmlBreakWidget extends WidgetType {
	/**
	 * 基底の契約と同じ。すべての改行ウィジェットを同一とみなす
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も HtmlBreakWidget なら true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof HtmlBreakWidget;
	}

	/**
	 * 基底の契約と同じ。装飾用の br 要素を返す
	 * @returns 空の br 要素
	 */
	toDOM(): HTMLElement {
		return document.createElement('br');
	}

	/**
	 * ブロック高さの見積もりを 0 にする
	 * インライン改行をブロックウィジェットとして測ると、行の高さがずれる
	 * @returns 常に 0
	 */
	get estimatedHeight(): number {
		return 0;
	}

	/**
	 * 基底の契約と同じ。改行上のイベントはエディタへ渡さない
	 * @returns 常に true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * すべての br で共有する改行ウィジェット
 * 表示が変わらないため、モジュール内で 1 つだけ生成する
 */
const htmlBreakWidget = new HtmlBreakWidget();

// ----------------------------------------------
// 許可タグの装飾
// ----------------------------------------------

/**
 * 文書上で見つかった 1 つの HTML タグ
 * 解釈できない文字列は配列に入れない
 */
type HtmlTagOccurrence = {
	/** タグの開始位置 */
	from: number;
	/** タグの終端 */
	to: number;
	/** その範囲の解釈結果。属性は未サニタイズ */
	parsed: ParsedHtmlTag;
};

/**
 * ノードが Table の中にあるかを判定する
 * 表の中は tableWidget が描くため、本文のインライン装飾から外す
 * @param node - 判定を始める構文ノード。親へたどる
 * @returns 祖先に Table があれば true
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
 * 許可タグの開閉を突き合わせ、本文用の装飾を積む
 * 選択がタグ範囲にかかっているペアはソースのまま残す。不正なネストは、対応する開始までを捨てる
 * @param state - 選択が記法にかかっているかを読むエディタ状態
 * @param entries - 装飾を追加する配列。この関数が push する
 * @param tags - 文書順のタグ。不許可タグは無視する
 */
function pushPairedHtmlDecorations(
	state: EditorState,
	entries: DecorationEntry[],
	tags: HtmlTagOccurrence[],
): void {
	/**
	 * まだ閉じていない開始タグ
	 * 属性は開いた時点でサニタイズし、閉じタグ側の属性は使わない
	 */
	type StackItem = {
		/** 対応待ちの開始タグ */
		tag: HtmlTagOccurrence;
		/** 開始タグのサニタイズ済み属性 */
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
 * プレビュー上の許可インライン HTML を装飾する。`<br>` を含む
 * InlineCode と FencedCode は構文上 HTMLTag にならないため対象外。Table 内は tableWidget が処理する
 * 選択がかかっているタグはソースのまま残す。sourceLineNumbers は旧入口との互換のため受け取るが、行種別の判定には使わない
 * @param state - 構文木と選択を読むエディタ状態。文書は変えない
 * @param _sourceLineNumbers - 旧 API のソース行集合。装飾の有無は選択との交差で決める
 * @returns 隠し装飾、mark、改行ウィジェット。該当が無ければ空
 */
export function collectHtmlDecorationEntries(
	state: EditorState,
	_sourceLineNumbers?: Set<number>,
): DecorationEntry[] {
	const entries: DecorationEntry[] = [];
	const tags: HtmlTagOccurrence[]  = [];

	syntaxTree(state).iterate({
		/**
		 * HTMLTag を出現順に集め、それ以外のノードは子の走査を続ける
		 * @param ref - 構文木のノード。name が HTMLTag のときだけ範囲を読む
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
 * 改行だけの旧入口。実装は collectHtmlDecorationEntries へ委譲する
 * @deprecated collectHtmlDecorationEntries を使用する
 * @param state - 構文木と選択を読むエディタ状態
 * @param sourceLineNumbers - 旧 API のソース行集合。装飾判定には使わない
 * @returns インライン HTML の装飾。該当が無ければ空
 */
export function collectHtmlBreakDecorationEntries(
	state: EditorState,
	sourceLineNumbers?: Set<number>,
): DecorationEntry[] {
	return collectHtmlDecorationEntries(state, sourceLineNumbers);
}
