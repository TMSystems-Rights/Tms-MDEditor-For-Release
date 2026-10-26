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
import { buildHtmlMarkSpec, parseHtmlTag, sanitizeHtmlAttributes, type ParsedHtmlTag } from './htmlSanitizer';
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
		// 祖先が表なら、本文のインライン装飾から外す
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
function pushPairedHtmlDecorations(state: EditorState, entries: DecorationEntry[], tags: HtmlTagOccurrence[]): void {
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

	// まだ閉じていない開始タグ。対応しない閉じでは、その開始より上だけを捨てる
	const stack: StackItem[] = [];

	for (const tag of tags) {
		// この出現の解釈。不許可なら装飾もスタックも変えない
		const { parsed } = tag;

		// 許可タグでない出現は、開きも閉じも無視する
		if (!parsed.allowed) {
			continue;
		}

		// 自己閉じか、br の開始タグのときだけ改行ウィジェットにする。br 以外の開始はこの条件に入らない
		if (parsed.kind === 'selfClosing' || (parsed.kind === 'open' && parsed.name === 'br')) {
			// 選択がタグにかかっているときはソースのまま残し、改行ウィジェットにしない
			if (selectionIntersectsRange(state, tag.from, tag.to)) {
				continue;
			}

			// タグ文字を視覚的な改行へ置き換える
			entries.push({
				// 置き換えるタグの開始。文書上の文字位置
				from: tag.from,
				// 置き換えるタグの終端。文書上の文字位置
				to: tag.to,
				// 共有の改行ウィジェット。タグ文字はレイアウトに残さない
				decoration: Decoration.replace({
					widget: htmlBreakWidget
				})
			});
			continue;
		}

		// 閉じ待ちの開始タグ。閉じ側の属性は使わず、ここでサニタイズした属性を残す
		if (parsed.kind === 'open') {
			// 未対応の開始。属性は開いた時点のサニタイズ結果
			stack.push({
				// 対応待ちの開始タグ。位置とタグ名を後の閉じと突き合わせる
				tag,
				// 開始タグのサニタイズ済み属性。閉じタグ側の属性では上書きしない
				attributes: sanitizeHtmlAttributes(parsed.attributes)
			});
			continue;
		}

		// 開始でも閉じでもない解釈は捨てる。自己閉じと br は上で処理済み
		if (parsed.kind !== 'close') {
			continue;
		}

		// 対応する開タグをスタックから探す（不正ネストは途中を破棄）
		// 同じ名前の開始位置。見つからなければ -1
		let openIndex = -1;
		for (let index = stack.length - 1; index >= 0; index -= 1) {
			// 同じタグ名の開始が見つかった位置を対応先にする。より内側の別タグは飛ばす
			if (stack[index]!.tag.parsed.name === parsed.name) {
				openIndex = index;
				break;
			}
		}

		// 対応する開始が無い閉じタグは、装飾を足さない
		if (openIndex < 0) {
			continue;
		}

		// 対応する開始。これより上に積んだ不正なネストは、長さを縮めて捨てる
		const open   = stack[openIndex]!;
		stack.length = openIndex;
		// 開始から閉じまでに選択がかかるペアは、ソースのまま残す
		if (selectionIntersectsRange(state, open.tag.from, tag.to)) {
			continue;
		}

		pushHiddenReplace(entries, open.tag.from, open.tag.to);
		pushHiddenReplace(entries, tag.from, tag.to);

		// 開始タグの直後。本文 mark の開始。文字位置
		const contentFrom = open.tag.to;
		// 閉じタグの直前。本文 mark の終端。開始以上なら本文は空
		const contentTo   = tag.from;
		// 開始と閉じのあいだに本文があるときだけ mark を付ける。空なら隠し装飾だけ
		if (contentFrom < contentTo) {
			// タグ名と開始側の属性から作る mark。閉じ側の属性は使わない
			const markSpec = buildHtmlMarkSpec(parsed.name, open.attributes);
			// タグに挟まれた本文の見た目。タグ文字自体は隠したまま
			entries.push({
				// 本文の開始。開始タグの直後
				from: contentFrom,
				// 本文の終端。閉じタグの直前
				to: contentTo,
				// サニタイズ済み属性を反映した mark。本文の文字は残す
				decoration: Decoration.mark(markSpec)
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
export function collectHtmlDecorationEntries(state: EditorState, _sourceLineNumbers?: Set<number>): DecorationEntry[] {
	// 返す装飾。該当が無ければ空配列
	const entries: DecorationEntry[] = [];
	// 文書順の HTML タグ。解釈できない文字列は入れない
	const tags: HtmlTagOccurrence[]  = [];

	syntaxTree(state).iterate({
		/**
		 * HTMLTag を出現順に集め、それ以外のノードは子の走査を続ける
		 * @param ref - 構文木のノード。name が HTMLTag のときだけ範囲を読む
		 */
		enter(ref) {
			// タグ以外は子の走査を続ける。このノード自体は集めない
			if (ref.name !== 'HTMLTag') {
				return;
			}

			// 表の中は tableWidget が描くので、本文の装飾に入れない
			if (isInsideTable(ref.node)) {
				return;
			}

			// タグ範囲の原文。解釈前
			const raw    = state.doc.sliceString(ref.from, ref.to);
			// 原文の解釈。タグとして読めなければ null
			const parsed = parseHtmlTag(raw);
			// 解釈できない文字列は出現リストに入れない
			if (!parsed) {
				return;
			}

			// 文書順に積む1件。属性は未サニタイズのまま後段へ渡す
			tags.push({
				// タグの開始。文書上の文字位置
				from: ref.from,
				// タグの終端。文書上の文字位置
				to: ref.to,
				// 範囲の解釈。不許可タグもここには残し、後段で無視する
				parsed
			});
		}
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
export function collectHtmlBreakDecorationEntries(state: EditorState, sourceLineNumbers?: Set<number>): DecorationEntry[] {
	return collectHtmlDecorationEntries(state, sourceLineNumbers);
}
