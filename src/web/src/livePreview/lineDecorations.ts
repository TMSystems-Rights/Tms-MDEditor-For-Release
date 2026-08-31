import { Decoration } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { isTaskMarkerChecked } from '../editor/checkboxToggle';
import {
	foldDefaultFromMark,
	normalizeCalloutType,
	type CalloutInfo,
} from '../editor/markdownSyntax';
import { calloutFoldField, isCalloutCollapsed } from './calloutFold';
import {
	pushCalloutCollapseReplace,
	pushCalloutFoldWidget,
	pushCalloutTypeLabel,
} from './calloutFoldWidget';
import { collectSourceLineNumbers, isPreviewLineNumber } from './cursorLine';
import { pushCheckboxReplace } from './checkboxWidget';
import { pushHiddenReplace } from './hiddenContent';
import { pushBulletMarkerReplace } from './listMarkers';
import type { DecorationEntry } from './inlineDecorations';
import { isMermaidFencedCode } from './mermaidWidget';

const ATX_HEADING_CLASSES: Record<string, string> = {
	ATXHeading1: 'cm-md-h1',
	ATXHeading2: 'cm-md-h2',
	ATXHeading3: 'cm-md-h3',
	ATXHeading4: 'cm-md-h4',
	ATXHeading5: 'cm-md-h5',
	ATXHeading6: 'cm-md-h6',
};

const SETEXT_HEADING_CLASSES: Record<string, string> = {
	SetextHeading1: 'cm-md-h1',
	SetextHeading2: 'cm-md-h2',
};

/**
 * プレビュー行のみ非表示 replace を追加する
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} from 開始位置
 * @param {number} to 終了位置
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {void}
 */
function pushHiddenMarkIfPreview(
	state: EditorState,
	entries: DecorationEntry[],
	from: number,
	to: number,
	sourceLineNumbers: Set<number>,
): void {
	const lineNumber = state.doc.lineAt(from).number;
	if (from >= to || !isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	pushHiddenReplace(entries, from, to);
}

/**
 * 行 Decoration エントリを追加する（プレビュー行限定）
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {EditorState} state エディタ状態
 * @param {number} lineNumber 行番号
 * @param {string} className CSS クラス
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @param {Record<string, string>} [attributes] 行属性
 * @returns {void}
 */
function pushLineClass(
	entries: DecorationEntry[],
	state: EditorState,
	lineNumber: number,
	className: string,
	sourceLineNumbers: Set<number>,
	attributes?: Record<string, string>,
): void {
	if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	pushLineClassAlways(entries, state, lineNumber, className, attributes);
}

/**
 * 行 Decoration エントリを追加する（アクティブ行も含む）
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {EditorState} state エディタ状態
 * @param {number} lineNumber 行番号
 * @param {string} className CSS クラス
 * @param {Record<string, string>} [attributes] 行属性
 * @returns {void}
 */
function pushLineClassAlways(
	entries: DecorationEntry[],
	state: EditorState,
	lineNumber: number,
	className: string,
	attributes?: Record<string, string>,
): void {
	const line = state.doc.line(lineNumber);
	entries.push({
		from      : line.from,
		to        : line.from,
		decoration: Decoration.line({
			class: className,
			attributes,
		}),
	});
}

/**
 * ATX 見出しの装飾を追加する
 * 行スタイルはアクティブ行でも維持し、`#` + 空白だけプレビュー時に隠す（ソース位置 (a) を不変に保つ）
 * @param {SyntaxNode} node 見出しノード
 * @param {string} className CSS クラス
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {void}
 */
function decorateAtxHeading(
	node: SyntaxNode,
	className: string,
	state: EditorState,
	entries: DecorationEntry[],
	sourceLineNumbers: Set<number>,
): void {
	const lineNumber = state.doc.lineAt(node.from).number;
	pushLineClassAlways(entries, state, lineNumber, className);

	if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	node.cursor().iterate((child) => {
		if (child.name !== 'HeaderMark') {
			return;
		}

		// Obsidian 同様 `#`（群）+ 直後の空白 1 つを隠す
		let hideTo = child.to;
		const next = state.doc.sliceString(child.to, Math.min(child.to + 1, state.doc.line(lineNumber).to));
		if (next === ' ' || next === '\t') {
			hideTo = child.to + 1;
		}

		pushHiddenMarkIfPreview(state, entries, child.from, hideTo, sourceLineNumbers);
	});
}

/**
 * Setext 見出しの装飾を追加する
 * @param {SyntaxNode} node 見出しノード
 * @param {string} className CSS クラス
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {void}
 */
function decorateSetextHeading(
	node: SyntaxNode,
	className: string,
	state: EditorState,
	entries: DecorationEntry[],
	sourceLineNumbers: Set<number>,
): void {
	const startLine = state.doc.lineAt(node.from).number;
	const endLine   = state.doc.lineAt(node.to).number;

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
		const line = state.doc.line(lineNumber);
		if (lineNumber === startLine) {
			pushLineClassAlways(entries, state, lineNumber, className);
			continue;
		}

		if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
			continue;
		}

		pushHiddenMarkIfPreview(state, entries, line.from, line.to, sourceLineNumbers);
	}
}

/**
 * Blockquote 内のコールアウト情報を取得する
 * @param {EditorState} state エディタ状態
 * @param {SyntaxNode} node Blockquote ノード
 * @returns {CalloutInfo | null}
 */
export function findCalloutInfo(state: EditorState, node: SyntaxNode): CalloutInfo | null {
	let found: CalloutInfo | null = null;

	node.cursor().iterate((child) => {
		if (child.name !== 'CalloutMark' || found) {
			return;
		}

		let typeText = '';
		let foldMark: string | undefined;
		child.node.cursor().iterate((inner) => {
			if (inner.name === 'CalloutType') {
				typeText = state.doc.sliceString(inner.from, inner.to);
			}

			if (inner.name === 'CalloutFoldMark') {
				foldMark = state.doc.sliceString(inner.from, inner.to);
			}
		});

		if (!typeText) {
			const raw   = state.doc.sliceString(child.from, child.to);
			const match = /^\[!([A-Za-z][\w-]*)\]([+-])?/.exec(raw);
			typeText    = match?.[1] ?? 'note';
			foldMark    = match?.[2];
		}

		found = {
			type       : normalizeCalloutType(typeText),
			markFrom   : child.from,
			markTo     : child.to,
			foldDefault: foldDefaultFromMark(foldMark),
			calloutFrom: node.from,
		};
		return false;
	});

	return found;
}

/**
 * 指定範囲を本文内に含むコールアウト情報を取得する
 * @param {EditorState} state エディタ状態
 * @param {number} from 範囲開始位置
 * @param {number} to 範囲終了位置
 * @returns {CalloutInfo | null} コールアウト情報
 */
export function findCalloutContainingRange(
	state: EditorState,
	from: number,
	to: number,
): CalloutInfo | null {
	let found: CalloutInfo | null = null;

	let foundLength = Number.MAX_SAFE_INTEGER;

	const position = Math.min(Math.max(from, 0), state.doc.length);

	syntaxTree(state).iterate({
		/**
		 * Blockquote ノードから指定範囲を含むコールアウトを探す
		 * @param {SyntaxNodeRef} ref ノード参照
		 * @returns {void}
		 */
		enter(ref) {
			if (ref.name !== 'Blockquote' || ref.from > position || ref.to < position) {
				return;
			}

			const callout = findCalloutInfo(state, ref.node);
			if (!callout) {
				return;
			}

			const titleLine = state.doc.lineAt(callout.calloutFrom);
			if (to <= titleLine.to) {
				return;
			}

			const length = ref.to - ref.from;
			if (length < foundLength) {
				found       = callout;
				foundLength = length;
			}
		},
	});

	return found;
}

/**
 * 指定範囲を含む折りたたみ中コールアウト情報を取得する
 * @param {EditorState} state エディタ状態
 * @param {number} from 範囲開始位置
 * @param {number} to 範囲終了位置
 * @returns {CalloutInfo | null} 折りたたみ中コールアウト情報
 */
export function findCollapsedCalloutContainingRange(
	state: EditorState,
	from: number,
	to: number,
): CalloutInfo | null {
	const callout = findCalloutContainingRange(state, from, to);
	if (!callout) {
		return null;
	}

	const overrides = state.field(calloutFoldField, false) ?? new Map<number, boolean>();
	return isCalloutCollapsed(overrides, callout.calloutFrom, callout.foldDefault)
		? callout
		: null;
}

/**
 * Fence コードブロックの装飾を追加する
 * 行スタイル（等幅フォント等）はアクティブ行でも維持し、CodeMark / CodeInfo だけプレビュー時に隠す
 * @param {SyntaxNode} node FencedCode ノード
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {void}
 */
function decorateFencedCode(
	node: SyntaxNode,
	state: EditorState,
	entries: DecorationEntry[],
	sourceLineNumbers: Set<number>,
): void {
	// Mermaid は blockWidgets 側の置換ウィジェットで描画する
	if (isMermaidFencedCode(state, node)) {
		return;
	}

	const startLine = state.doc.lineAt(node.from).number;
	const endLine   = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
		pushLineClassAlways(entries, state, lineNumber, 'cm-md-fenced-code');
	}

	node.cursor().iterate((child) => {
		// QuoteMark はコールアウト内コードブロックの行頭 `>`（Obsidian 同様プレビューでは隠す）
		if (child.name === 'CodeMark' || child.name === 'CodeInfo' || child.name === 'QuoteMark') {
			pushHiddenMarkIfPreview(state, entries, child.from, child.to, sourceLineNumbers);
		}
	});
}

/**
 * コールアウトタイトル行の `>` / 空白 / `[!type]` を隠し、ウィジェット挿入位置を返す
 * `>[!success]` のように `>` 直後スペース無しでもトグル位置がずれないようにする
 * @param {SyntaxNode} node Blockquote ノード
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @param {number} titleLineNumber タイトル行番号
 * @param {CalloutInfo} callout コールアウト情報
 * @returns {number}
 */
function hideCalloutTitleMarkup(
	node: SyntaxNode,
	state: EditorState,
	entries: DecorationEntry[],
	sourceLineNumbers: Set<number>,
	titleLineNumber: number,
	callout: CalloutInfo,
): number {
	let quoteMarkEnd: number | null = null;
	node.cursor().iterate((child) => {
		if (child.name !== 'QuoteMark') {
			return;
		}

		if (state.doc.lineAt(child.from).number !== titleLineNumber) {
			return;
		}

		pushHiddenMarkIfPreview(state, entries, child.from, child.to, sourceLineNumbers);
		quoteMarkEnd = Math.max(quoteMarkEnd ?? child.to, child.to);
	});

	// `> [!type]` の空白、および `>[!type]` の隙間を隠す
	if (quoteMarkEnd !== null && quoteMarkEnd < callout.markFrom) {
		const gap = state.doc.sliceString(quoteMarkEnd, callout.markFrom);
		if (/^\s*$/.test(gap)) {
			pushHiddenMarkIfPreview(
				state,
				entries,
				quoteMarkEnd,
				callout.markFrom,
				sourceLineNumbers,
			);
		}
	}

	pushHiddenMarkIfPreview(state, entries, callout.markFrom, callout.markTo, sourceLineNumbers);
	let hideThrough = callout.markTo;
	const after     = state.doc.sliceString(callout.markTo, callout.markTo + 1);
	if (after === ' ' || after === '\t') {
		hideThrough = callout.markTo + 1;
		pushHiddenMarkIfPreview(state, entries, callout.markTo, hideThrough, sourceLineNumbers);
	}

	return hideThrough;
}

/**
 * 引用ブロックの装飾を追加する（コールアウトを含む）
 * @param {SyntaxNode} node Blockquote ノード
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {void}
 */
function decorateBlockquote(
	node: SyntaxNode,
	state: EditorState,
	entries: DecorationEntry[],
	sourceLineNumbers: Set<number>,
): void {
	const startLine = state.doc.lineAt(node.from).number;
	const endLine   = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
	const callout   = findCalloutInfo(state, node);
	const overrides = state.field(calloutFoldField, false) ?? new Map<number, boolean>();
	const collapsed = callout
		? isCalloutCollapsed(overrides, callout.calloutFrom, callout.foldDefault)
		: false;
	const titleLine = state.doc.line(startLine);

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
		if (collapsed && lineNumber > startLine) {
			// 折りたたみ本文は block replace するため行クラスは付けない
			continue;
		}

		if (callout) {
			const classes = [
				'cm-md-callout',
				`cm-md-callout-${callout.type}`,
				lineNumber === startLine ? 'cm-md-callout-title' : 'cm-md-callout-body',
			];
			if (callout.foldDefault !== 'none') {
				classes.push('cm-md-callout-foldable');
			}

			pushLineClass(
				entries,
				state,
				lineNumber,
				classes.join(' '),
				sourceLineNumbers,
			);
		} else {
			pushLineClass(entries, state, lineNumber, 'cm-md-blockquote', sourceLineNumbers);
		}
	}

	if (!callout) {
		node.cursor().iterate((child) => {
			if (child.name === 'QuoteMark') {
				pushHiddenMarkIfPreview(state, entries, child.from, child.to, sourceLineNumbers);
				return;
			}

			if (child.name === 'FencedCode') {
				decorateFencedCode(child.node, state, entries, sourceLineNumbers);
				return false;
			}
		});
		return;
	}

	const hideThrough = hideCalloutTitleMarkup(
		node,
		state,
		entries,
		sourceLineNumbers,
		startLine,
		callout,
	);

	// 折りたたみ時はタイトル行の QuoteMark / マーカーだけ処理し、本文は一括で潰す
	if (collapsed) {
		// タイトル行がアクティブでもトグルを残す（ソース表示中でも開閉できるようにする）
		pushCalloutFoldWidget(entries, hideThrough, true, callout.calloutFrom);
		if (isPreviewLineNumber(startLine, sourceLineNumbers)) {
			pushCalloutTypeLabel(entries, hideThrough, callout.type);
		}

		pushCalloutCollapseReplace(entries, titleLine.to, node.to);
		return;
	}

	node.cursor().iterate((child) => {
		if (child.name === 'QuoteMark') {
			// タイトル行は hideCalloutTitleMarkup 済み。本文行のみ隠す
			if (state.doc.lineAt(child.from).number === startLine) {
				return;
			}

			pushHiddenMarkIfPreview(state, entries, child.from, child.to, sourceLineNumbers);
			return;
		}

		if (child.name === 'FencedCode') {
			decorateFencedCode(child.node, state, entries, sourceLineNumbers);
			return false;
		}
	});

	if (callout.foldDefault !== 'none') {
		pushCalloutFoldWidget(entries, hideThrough, false, callout.calloutFrom);
	}

	if (isPreviewLineNumber(startLine, sourceLineNumbers)) {
		pushCalloutTypeLabel(entries, hideThrough, callout.type);
	}
}

/**
 * 水平線の装飾を追加する
 * @param {SyntaxNode} node HorizontalRule ノード
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {void}
 */
function decorateHorizontalRule(
	node: SyntaxNode,
	state: EditorState,
	entries: DecorationEntry[],
	sourceLineNumbers: Set<number>,
): void {
	const lineNumber = state.doc.lineAt(node.from).number;
	if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	pushLineClass(entries, state, lineNumber, 'cm-md-hr', sourceLineNumbers);
	pushHiddenMarkIfPreview(state, entries, node.from, node.to, sourceLineNumbers);
}

/**
 * リスト項目の装飾を追加する
 * プレビュー行ではマーカー文字のみ置換し、インデント等のレイアウトはソースと同一に保つ
 * タスク項目は ListMark（`•`）を出さず、チェックボックスのみ表示する
 * @param {SyntaxNode} node ListItem ノード
 * @param {EditorState} state エディタ状態
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {Set<number>} sourceLineNumbers ソース行集合
 * @returns {void}
 */
function decorateListItem(
	node: SyntaxNode,
	state: EditorState,
	entries: DecorationEntry[],
	sourceLineNumbers: Set<number>,
): void {
	const lineNumber = state.doc.lineAt(node.from).number;
	if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	const isOrdered                 = node.parent?.name === 'OrderedList';
	let listMarkFrom: number | null = null;
	let listMarkTo: number | null   = null;
	let taskFrom: number | null     = null;
	let taskTo: number | null       = null;
	let taskChecked                 = false;

	node.cursor().iterate((child) => {
		if (child.name === 'TaskMarker' && child.node.parent?.parent === node) {
			const text  = state.doc.sliceString(child.from, child.to);
			taskFrom    = child.from;
			taskTo      = child.to;
			taskChecked = isTaskMarkerChecked(text);
			return;
		}

		if (child.name === 'ListMark' && child.node.parent === node) {
			listMarkFrom = child.from;
			listMarkTo   = child.to;
		}
	});

	// タスク行: `- [ ]` の ListMark〜TaskMarker 直前を隠し、チェックボックスのみ残す
	if (taskFrom !== null && taskTo !== null && listMarkFrom !== null) {
		pushHiddenReplace(entries, listMarkFrom, taskFrom);
		pushCheckboxReplace(entries, taskFrom, taskTo, taskChecked);
		return;
	}

	if (listMarkFrom === null || listMarkTo === null) {
		return;
	}

	if (isOrdered) {
		entries.push({
			from      : listMarkFrom,
			to        : listMarkTo,
			decoration: Decoration.mark({ class: 'cm-md-list-number' }),
		});
		return;
	}

	pushBulletMarkerReplace(entries, listMarkFrom, listMarkTo);
}

/**
 * ライブプレビュー行の行装飾エントリを収集する
 * @param {EditorState} state エディタ状態
 * @param {Set<number>} [sourceLineNumbers] ソース行集合
 * @returns {DecorationEntry[]}
 */
export function collectLineDecorationEntries(
	state: EditorState,
	sourceLineNumbers: Set<number> = collectSourceLineNumbers(state),
): DecorationEntry[] {
	const entries: DecorationEntry[] = [];

	syntaxTree(state).iterate({
		/**
		 * 構文木を走査して行装飾エントリを収集する
		 * @param {{ name: string; node: SyntaxNode }} ref ノード参照
		 * @returns {boolean | void}
		 */
		enter(ref) {
			switch (ref.name) {
				case 'ATXHeading1':
				case 'ATXHeading2':
				case 'ATXHeading3':
				case 'ATXHeading4':
				case 'ATXHeading5':
				case 'ATXHeading6': {
					const className = ATX_HEADING_CLASSES[ref.name];
					if (className) {
						decorateAtxHeading(ref.node, className, state, entries, sourceLineNumbers);
					}

					return false;
				}
				case 'SetextHeading1':
				case 'SetextHeading2': {
					const className = SETEXT_HEADING_CLASSES[ref.name];
					if (className) {
						decorateSetextHeading(ref.node, className, state, entries, sourceLineNumbers);
					}

					return false;
				}
				case 'Blockquote':
					decorateBlockquote(ref.node, state, entries, sourceLineNumbers);
					return false;
				case 'FencedCode':
					decorateFencedCode(ref.node, state, entries, sourceLineNumbers);
					return false;
				case 'HorizontalRule':
					decorateHorizontalRule(ref.node, state, entries, sourceLineNumbers);
					return false;
				case 'ListItem':
					decorateListItem(ref.node, state, entries, sourceLineNumbers);
					return;
				default:
					return;
			}
		},
	});

	return entries;
}
