/**
 * 見出し、コード、引用、リスト、水平線、コールアウトの行装飾を集める
 * 折りたたみ状態は calloutFold から読み、このファイルは装飾配列を返すだけである
 * @file
 */
import { Decoration } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { isTaskMarkerChecked } from '../editor/checkboxToggle';
import { foldDefaultFromMark, normalizeCalloutType, type CalloutInfo } from '../editor/markdownSyntax';
import { calloutFoldField, isCalloutCollapsed } from './calloutFold';
import { pushCalloutCollapseReplace, pushCalloutFoldWidget, pushCalloutTypeLabel } from './calloutFoldWidget';
import { collectSourceLineNumbers, isPreviewLineNumber } from './cursorLine';
import { pushCheckboxReplace } from './checkboxWidget';
import { pushHiddenReplace } from './hiddenContent';
import { pushBulletMarkerReplace } from './listMarkers';
import type { DecorationEntry } from './inlineDecorations';
import { isMermaidFencedCode } from './mermaidWidget';

// ----------------------------------------------
// 見出し
// ----------------------------------------------
/** ATX 見出しノード名から行クラスへの対応。実行中は変えない */
const ATX_HEADING_CLASSES: Record<string, string> = {
	// レベル 1 の行クラス
	ATXHeading1: 'cm-md-h1',
	// レベル 2 の行クラス
	ATXHeading2: 'cm-md-h2',
	// レベル 3 の行クラス
	ATXHeading3: 'cm-md-h3',
	// レベル 4 の行クラス
	ATXHeading4: 'cm-md-h4',
	// レベル 5 の行クラス
	ATXHeading5: 'cm-md-h5',
	// レベル 6 の行クラス
	ATXHeading6: 'cm-md-h6'
};

/** Setext 見出しノード名から行クラスへの対応。実行中は変えない */
const SETEXT_HEADING_CLASSES: Record<string, string> = {
	// 下線 `=` の行クラス
	SetextHeading1: 'cm-md-h1',
	// 下線 `-` の行クラス
	SetextHeading2: 'cm-md-h2'
};

/**
 * プレビュー行のみ非表示 replace を追加する
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param from - 開始位置
 * @param to - 終了位置
 * @param sourceLineNumbers - ソース行集合
 */
function pushHiddenMarkIfPreview(state: EditorState, entries: DecorationEntry[], from: number, to: number, sourceLineNumbers: Set<number>): void {
	// 隠す開始が属する行番号。プレビュー行だけ replace する
	const lineNumber = state.doc.lineAt(from).number;
	// 範囲が空、またはソース行のときは隠さない。どちらか一方でも return
	if (from >= to || !isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	pushHiddenReplace(entries, from, to);
}

/**
 * 行 Decoration エントリを追加する（プレビュー行限定）
 * @param entries - エントリ配列
 * @param state - エディタ状態
 * @param lineNumber - 行番号
 * @param className - CSS クラス
 * @param sourceLineNumbers - ソース行集合
 * @param attributes - 行属性。省略可
 */
function pushLineClass(entries: DecorationEntry[], state: EditorState, lineNumber: number, className: string, sourceLineNumbers: Set<number>, attributes?: Record<string, string>): void {
	// ソース行では行クラスを付けない
	if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	pushLineClassAlways(entries, state, lineNumber, className, attributes);
}

/**
 * 行 Decoration エントリを追加する（アクティブ行も含む）
 * @param entries - エントリ配列
 * @param state - エディタ状態
 * @param lineNumber - 行番号
 * @param className - CSS クラス
 * @param attributes - 行属性。省略可
 */
function pushLineClassAlways(entries: DecorationEntry[], state: EditorState, lineNumber: number, className: string, attributes?: Record<string, string>): void {
	// クラスを付ける行。行頭がポイント装飾の位置
	const line = state.doc.line(lineNumber);
	// 行全体のクラス。属性が無いときは attributes は undefined
	entries.push({
		// 行頭。ポイント装飾なので to と同じ
		from: line.from,
		// 行頭。ポイント装飾なので from と同じ
		to: line.from,
		// 行クラス。プレビューでもアクティブ行でも付ける
		decoration: Decoration.line({
			// CSS クラス。見出しやコードなど行の種類
			class: className,
			// 追加の行属性。省略時は undefined
			attributes
		})
	});
}

/**
 * ATX 見出しの装飾を追加する
 * 行スタイルはアクティブ行でも維持し、`#` + 空白だけプレビュー時に隠す（ソース位置 (a) を不変に保つ）
 * @param node - 見出しノード
 * @param className - CSS クラス
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param sourceLineNumbers - ソース行集合
 */
function decorateAtxHeading(node: SyntaxNode, className: string, state: EditorState, entries: DecorationEntry[], sourceLineNumbers: Set<number>): void {
	// 見出しの行番号。行クラスはアクティブ行でも残す
	const lineNumber = state.doc.lineAt(node.from).number;
	pushLineClassAlways(entries, state, lineNumber, className);

	// ソース行では `#` を隠さず、行クラスだけ残す
	if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	node.cursor().iterate((child) => {
		// HeaderMark 以外の子は隠さない
		if (child.name !== 'HeaderMark') {
			return;
		}

		// Obsidian 同様 `#`（群）+ 直後の空白 1 つを隠す
		// 隠す終端。直後が空白なら 1 文字伸ばす
		let hideTo = child.to;
		// マーカー直後の 1 文字。行末なら空文字
		const next = state.doc.sliceString(child.to, Math.min(child.to + 1, state.doc.line(lineNumber).to));
		// 半角空白かタブのときだけ、その 1 文字も隠す
		if (next === ' ' || next === '\t') {
			hideTo = child.to + 1;
		}

		pushHiddenMarkIfPreview(state, entries, child.from, hideTo, sourceLineNumbers);
	});
}

/**
 * Setext 見出しの装飾を追加する
 * @param node - 見出しノード
 * @param className - CSS クラス
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param sourceLineNumbers - ソース行集合
 */
function decorateSetextHeading(node: SyntaxNode, className: string, state: EditorState, entries: DecorationEntry[], sourceLineNumbers: Set<number>): void {
	// 見出し本文の開始行
	const startLine = state.doc.lineAt(node.from).number;
	// 下線がある終了行
	const endLine   = state.doc.lineAt(node.to).number;
	// 下線行。単独ハイフンは見出しにしない
	const underline = state.doc.line(endLine);

	/*
	 * `aaa` の直後へ箇条書き入力を始めた時点の `-` / `- ` は、
	 * Markdown パーサ上は SetextHeading2 と解釈されることがある
	 * ただし編集途中の単独ハイフンを見出しとして装飾すると、前行が h2
	 * へ伸縮し、続く本文入力・Backspace 時にキャレット座標が揺れる
	 * 2 個以上の `-` は通常どおり Setext 見出しとして扱う
	 */
	// 空白だけの単独ハイフンは、編集途中の箇条書きとして見出し装飾を止める
	if (/^\s*-\s*$/.test(underline.text)) {
		pushLineClassAlways(entries, state, startLine, 'cm-md-pending-list-source');
		return;
	}

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
		// いま見ている行。下線行は本文と分けて隠す
		const line = state.doc.line(lineNumber);
		// 本文の開始行だけ見出しクラスを付け、下線は隠す側へ回す
		if (lineNumber === startLine) {
			pushLineClassAlways(entries, state, lineNumber, className);
			continue;
		}

		// ソース行の下線は隠さない
		if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
			continue;
		}

		pushHiddenMarkIfPreview(state, entries, line.from, line.to, sourceLineNumbers);
	}
}

/**
 * Blockquote 内のコールアウト情報を取得する
 * @param state - エディタ状態
 * @param node - Blockquote ノード
 * @returns Blockquote 内のコールアウト情報。無ければ null
 */
export function findCalloutInfo(state: EditorState, node: SyntaxNode): CalloutInfo | null {
	// 最初に見つかったコールアウト。無ければ null のまま
	let found: CalloutInfo | null = null;

	node.cursor().iterate((child) => {
		// CalloutMark でない、または既に見つかっている子は見ない。どちらか一方でも return
		if (child.name !== 'CalloutMark' || found) {
			return;
		}

		// 種別の原文。ノードが無ければ空のまま、後で記法全体から取る
		let typeText = '';
		// 折りたたみ記号。`+` か `-`。無ければ undefined
		let foldMark: string | undefined;
		child.node.cursor().iterate((inner) => {
			// 種別ノードだけ原文を取る
			if (inner.name === 'CalloutType') {
				typeText = state.doc.sliceString(inner.from, inner.to);
			}

			// 折りたたみ記号ノードだけ `+` か `-` を取る
			if (inner.name === 'CalloutFoldMark') {
				foldMark = state.doc.sliceString(inner.from, inner.to);
			}
		});

		// 種別ノードが空のときだけ、記法全体の正規表現で補う
		if (!typeText) {
			// `[!type]` を含むマーカー原文
			const raw   = state.doc.sliceString(child.from, child.to);
			// 種別と任意の折りたたみ記号。合わなければ null
			const match = /^\[!([A-Za-z][\w-]*)\]([+-])?/.exec(raw);
			// 種別。正規表現が外れたときは note
			typeText    = match?.[1] ?? 'note';
			// 折りたたみ記号。無ければ undefined
			foldMark    = match?.[2];
		}

		// この引用のコールアウト。最初の 1 件で走査を止める
		found = {
			// 正規化した種別。空にはしない
			type: normalizeCalloutType(typeText),
			// マーカーの開始
			markFrom: child.from,
			// マーカーの終端
			markTo: child.to,
			// 記法上の初期折りたたみ。記号が無ければ none
			foldDefault: foldDefaultFromMark(foldMark),
			// 引用ブロックの開始。上書きのキー
			calloutFrom: node.from
		};
		return false;
	});

	return found;
}

/**
 * 指定範囲を本文内に含むコールアウト情報を取得する
 * @param state - エディタ状態
 * @param from - 範囲開始位置
 * @param to - 範囲終了位置
 * @returns コールアウト情報
 */
export function findCalloutContainingRange(state: EditorState, from: number, to: number): CalloutInfo | null {
	// いちばん内側のコールアウト。無ければ null
	let found: CalloutInfo | null = null;

	// 採用した引用の長さ。より短い引用で上書きする
	let foundLength = Number.MAX_SAFE_INTEGER;

	// 文書内に収めた検索位置
	const position = Math.min(Math.max(from, 0), state.doc.length);

	syntaxTree(state).iterate({
		/**
		 * Blockquote ノードから指定範囲を含むコールアウトを探す
		 * @param ref - ノード参照
		 */
		enter(ref) {
			// 引用でない、位置より後ろから始まる、または位置より前で終わるノードは見ない
			if (ref.name !== 'Blockquote' || ref.from > position || ref.to < position) {
				return;
			}

			// この引用のコールアウト。無ければ null
			const callout = findCalloutInfo(state, ref.node);
			// コールアウトでない引用は候補にしない
			if (!callout) {
				return;
			}

			// タイトル行。本文がこの行までに収まる範囲は対象外
			const titleLine = state.doc.lineAt(callout.calloutFrom);
			// 範囲がタイトル行で終わるときは、本文を含むコールアウトにしない
			if (to <= titleLine.to) {
				return;
			}

			// 引用の長さ。短い方を内側とみなす
			const length = ref.to - ref.from;
			// これまでより短い引用だけ採用する
			if (length < foundLength) {
				found       = callout;
				foundLength = length;
			}
		}
	});

	return found;
}

/**
 * 指定範囲を含む折りたたみ中コールアウト情報を取得する
 * @param state - エディタ状態
 * @param from - 範囲開始位置
 * @param to - 範囲終了位置
 * @returns 折りたたみ中コールアウト情報
 */
export function findCollapsedCalloutContainingRange(state: EditorState, from: number, to: number): CalloutInfo | null {
	// 範囲を含むコールアウト。無ければ null
	const callout = findCalloutContainingRange(state, from, to);
	// コールアウトが無ければ折りたたみ中にもしない
	if (!callout) {
		return null;
	}

	// 開始位置から折りたたみ上書き。フィールドが無ければ空
	const overrides = state.field(calloutFoldField, false) ?? new Map<number, boolean>();
	return isCalloutCollapsed(overrides, callout.calloutFrom, callout.foldDefault) ? callout : null;
}

/**
 * Fence コードブロックの装飾を追加する
 * 行スタイル（等幅フォント等）はアクティブ行でも維持し、CodeMark / CodeInfo だけプレビュー時に隠す
 * @param node - FencedCode ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param sourceLineNumbers - ソース行集合
 */
function decorateFencedCode(node: SyntaxNode, state: EditorState, entries: DecorationEntry[], sourceLineNumbers: Set<number>): void {
	// Mermaid は blockWidgets 側の置換ウィジェットで描画する
	// Mermaid は別ウィジェットが描くので、コード行クラスもフェンス隠しもしない
	if (isMermaidFencedCode(state, node)) {
		return;
	}

	// 開始フェンスの行番号
	const startLine = state.doc.lineAt(node.from).number;
	// 終了位置の直前が属する行。空ノードは開始行と同じ
	const endLine   = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
		pushLineClassAlways(entries, state, lineNumber, 'cm-md-fenced-code');
	}

	node.cursor().iterate((child) => {
		// QuoteMark はコールアウト内コードブロックの行頭 `>`（Obsidian 同様プレビューでは隠す）
		// フェンス記号、言語名、引用符のどれかだけプレビュー時に隠す
		if (child.name === 'CodeMark' || child.name === 'CodeInfo' || child.name === 'QuoteMark') {
			pushHiddenMarkIfPreview(state, entries, child.from, child.to, sourceLineNumbers);
		}
	});
}

/**
 * コールアウトタイトル行の `>` / 空白 / `[!type]` を隠し、ウィジェット挿入位置を返す
 * `>[!success]` のように `>` 直後スペース無しでもトグル位置がずれないようにする
 * @param node - Blockquote ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param sourceLineNumbers - ソース行集合
 * @param titleLineNumber - タイトル行番号
 * @param callout - コールアウト情報
 * @returns コールアウトタイトル行の `>` / 空白 / `[!type]` を隠し、ウィジェット挿入位置
 */
function hideCalloutTitleMarkup(node: SyntaxNode, state: EditorState, entries: DecorationEntry[], sourceLineNumbers: Set<number>, titleLineNumber: number, callout: CalloutInfo): number {
	// タイトル行の `>` の終端。無ければ null
	let quoteMarkEnd: number | null = null;
	node.cursor().iterate((child) => {
		// 引用符以外はタイトル隠しの対象にしない
		if (child.name !== 'QuoteMark') {
			return;
		}

		// タイトル行以外の引用符は本文側で隠す
		if (state.doc.lineAt(child.from).number !== titleLineNumber) {
			return;
		}

		pushHiddenMarkIfPreview(state, entries, child.from, child.to, sourceLineNumbers);
		quoteMarkEnd = Math.max(quoteMarkEnd ?? child.to, child.to);
	});

	// `> [!type]` の空白、および `>[!type]` の隙間を隠す
	// 引用符の終端があり、かつマーカーより前のときだけ隙間を見る。どちらか一方では見ない
	if (quoteMarkEnd !== null && quoteMarkEnd < callout.markFrom) {
		// 引用符とマーカーの間。空白だけなら隠す
		const gap = state.doc.sliceString(quoteMarkEnd, callout.markFrom);
		// 隙間が空白だけなら、その区間もプレビューで隠す
		if (/^\s*$/.test(gap)) {
			pushHiddenMarkIfPreview(state, entries, quoteMarkEnd, callout.markFrom, sourceLineNumbers);
		}
	}

	pushHiddenMarkIfPreview(state, entries, callout.markFrom, callout.markTo, sourceLineNumbers);
	// 隠す終端。直後が空白なら 1 文字伸ばす
	let hideThrough = callout.markTo;
	// マーカー直後の 1 文字。無ければ空文字
	const after     = state.doc.sliceString(callout.markTo, callout.markTo + 1);
	// 半角空白かタブのときだけ、その 1 文字も隠す
	if (after === ' ' || after === '\t') {
		hideThrough = callout.markTo + 1;
		pushHiddenMarkIfPreview(state, entries, callout.markTo, hideThrough, sourceLineNumbers);
	}

	return hideThrough;
}

/**
 * 引用ブロックの装飾を追加する（コールアウトを含む）
 * @param node - Blockquote ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param sourceLineNumbers - ソース行集合
 */
function decorateBlockquote(node: SyntaxNode, state: EditorState, entries: DecorationEntry[], sourceLineNumbers: Set<number>): void {
	// 引用の開始行
	const startLine = state.doc.lineAt(node.from).number;
	// 引用の終了行。空ノードは開始行と同じ
	const endLine   = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
	// コールアウト情報。通常の引用なら null
	const callout   = findCalloutInfo(state, node);
	// 折りたたみ上書き。フィールドが無ければ空
	const overrides = state.field(calloutFoldField, false) ?? new Map<number, boolean>();
	// いま折りたたみ中か。コールアウトでなければ false
	const collapsed = callout ? isCalloutCollapsed(overrides, callout.calloutFrom, callout.foldDefault) : false;
	// タイトル行。折りたたみ時の本文置換の開始に使う
	const titleLine = state.doc.line(startLine);

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
		// 折りたたみ本文は block replace するため行クラスは付けない
		if (collapsed && lineNumber > startLine) {
			// 折りたたみ本文は block replace するため行クラスは付けない
			continue;
		}

		// コールアウトだけ種別とタイトル／本文のクラスを付ける
		if (callout) {
			// 行クラス。タイトル行と本文行で最後のクラスが変わる
			const classes = ['cm-md-callout', `cm-md-callout-${callout.type}`, lineNumber === startLine ? 'cm-md-callout-title' : 'cm-md-callout-body'];
			// 折りたたみ記号がある種別だけ、開閉できるクラスを足す
			if (callout.foldDefault !== 'none') {
				classes.push('cm-md-callout-foldable');
			}

			pushLineClass(entries, state, lineNumber, classes.join(' '), sourceLineNumbers);
		} else {
			pushLineClass(entries, state, lineNumber, 'cm-md-blockquote', sourceLineNumbers);
		}
	}

	// 通常の引用は引用符と内側のコードだけ処理して戻る
	if (!callout) {
		node.cursor().iterate((child) => {
			// 引用符はプレビュー行だけ隠す
			if (child.name === 'QuoteMark') {
				pushHiddenMarkIfPreview(state, entries, child.from, child.to, sourceLineNumbers);
				return;
			}

			// 内側のコードは引用の外と同じフェンス装飾にする。子の再走査は止める
			if (child.name === 'FencedCode') {
				decorateFencedCode(child.node, state, entries, sourceLineNumbers);
				return false;
			}
		});
		return;
	}

	// タイトル行の記法を隠したあとのウィジェット位置
	const hideThrough = hideCalloutTitleMarkup(node, state, entries, sourceLineNumbers, startLine, callout);

	// 折りたたみ時はタイトル行の QuoteMark / マーカーだけ処理し、本文は一括で潰す
	// 折りたたみ中はトグルと種別だけ残し、本文は 1 区間で隠す
	if (collapsed) {
		// タイトル行がアクティブでもトグルを残す（ソース表示中でも開閉できるようにする）
		pushCalloutFoldWidget(entries, hideThrough, true, callout.calloutFrom);
		// タイトル行がプレビューのときだけ種別ラベルを出す
		if (isPreviewLineNumber(startLine, sourceLineNumbers)) {
			pushCalloutTypeLabel(entries, hideThrough, callout.type);
		}

		pushCalloutCollapseReplace(entries, titleLine.to, node.to);
		return;
	}

	node.cursor().iterate((child) => {
		// タイトル行は hideCalloutTitleMarkup 済み。本文行のみ隠す
		if (child.name === 'QuoteMark') {
			// タイトル行は hideCalloutTitleMarkup 済み。本文行のみ隠す
			if (state.doc.lineAt(child.from).number === startLine) {
				return;
			}

			pushHiddenMarkIfPreview(state, entries, child.from, child.to, sourceLineNumbers);
			return;
		}

		// 内側のコードは引用の外と同じフェンス装飾にする。子の再走査は止める
		if (child.name === 'FencedCode') {
			decorateFencedCode(child.node, state, entries, sourceLineNumbers);
			return false;
		}
	});

	// 折りたたみ記号がある種別だけ、開いた状態のトグルを出す
	if (callout.foldDefault !== 'none') {
		pushCalloutFoldWidget(entries, hideThrough, false, callout.calloutFrom);
	}

	// タイトル行がプレビューのときだけ種別ラベルを出す
	if (isPreviewLineNumber(startLine, sourceLineNumbers)) {
		pushCalloutTypeLabel(entries, hideThrough, callout.type);
	}
}

/**
 * 水平線の装飾を追加する
 * @param node - HorizontalRule ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param sourceLineNumbers - ソース行集合
 */
function decorateHorizontalRule(node: SyntaxNode, state: EditorState, entries: DecorationEntry[], sourceLineNumbers: Set<number>): void {
	// 水平線の行番号
	const lineNumber = state.doc.lineAt(node.from).number;
	// ソース行では水平線のクラスも隠しもしない
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
 * @param node - ListItem ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param sourceLineNumbers - ソース行集合
 */
function decorateListItem(node: SyntaxNode, state: EditorState, entries: DecorationEntry[], sourceLineNumbers: Set<number>): void {
	// 項目の開始行
	const lineNumber = state.doc.lineAt(node.from).number;
	// ソース行ではマーカーもチェックも置き換えない
	if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
		return;
	}

	// 親が番号付きリストなら true。箇条書きは false
	const isOrdered                 = node.parent?.name === 'OrderedList';
	// マーカーの開始。無ければ null
	let listMarkFrom: number | null = null;
	// マーカーの終端。無ければ null
	let listMarkTo: number | null   = null;
	// タスク記法の開始。無ければ null
	let taskFrom: number | null     = null;
	// タスク記法の終端。無ければ null
	let taskTo: number | null       = null;
	// チェック済みなら true。タスクでなければ false のまま
	let taskChecked                 = false;

	node.cursor().iterate((child) => {
		// この項目直下のタスク記法だけ位置と状態を覚える
		if (child.name === 'TaskMarker' && child.node.parent?.parent === node) {
			// タスク記法の原文。チェック判定に使う
			const text  = state.doc.sliceString(child.from, child.to);
			taskFrom    = child.from;
			taskTo      = child.to;
			taskChecked = isTaskMarkerChecked(text);
			return;
		}

		// この項目直下のリスト記号だけ位置を覚える
		if (child.name === 'ListMark' && child.node.parent === node) {
			listMarkFrom = child.from;
			listMarkTo   = child.to;
		}
	});

	// タスク行: `- [ ]` の ListMark〜TaskMarker 直前を隠し、チェックボックスのみ残す
	// タスク記法とリスト記号が揃った行だけ、記号を隠してチェックボックスにする。どれか一つが null でも入らない
	if (taskFrom !== null && taskTo !== null && listMarkFrom !== null) {
		pushHiddenReplace(entries, listMarkFrom, taskFrom);
		pushCheckboxReplace(entries, taskFrom, taskTo, taskChecked);
		return;
	}

	// マーカーの開始か終端が無い項目は置き換えない。どちらか一方でも return
	if (listMarkFrom === null || listMarkTo === null) {
		return;
	}

	// 番号付きだけ数字を mark にし、箇条書きは記号ウィジェットへ渡す
	if (isOrdered) {
		// 番号部分の mark。中身の数字は残す
		entries.push({
			// 番号の開始
			from: listMarkFrom,
			// 番号の終端
			to: listMarkTo,
			// 番号の見た目。箇条書きの記号置換とは分ける
			decoration: Decoration.mark({ class: 'cm-md-list-number' })
		});
		return;
	}

	pushBulletMarkerReplace(entries, listMarkFrom, listMarkTo);
}

// ----------------------------------------------
// 行装飾の収集
// ----------------------------------------------
/**
 * ライブプレビュー行の行装飾エントリを収集する
 * @param state - エディタ状態
 * @param sourceLineNumbers - ソース行集合。省略可
 * @returns 集めたライブプレビュー行の行装飾エントリ。該当が無ければ空
 */
export function collectLineDecorationEntries(state: EditorState, sourceLineNumbers: Set<number> = collectSourceLineNumbers(state)): DecorationEntry[] {
	// 集めた行装飾。該当が無ければ空のまま返す
	const entries: DecorationEntry[] = [];

	syntaxTree(state).iterate({
		/**
		 * 構文木を走査して行装飾エントリを収集する
		 * @param ref - ノード参照
		 * @returns 子の走査を止めるとき false。続けるときは値を返さない
		 */
		enter(ref) {
			switch (ref.name) {
				// ATX 見出し。対応するクラスが無い名前は装飾しない
				case 'ATXHeading1':
				case 'ATXHeading2':
				case 'ATXHeading3':
				case 'ATXHeading4':
				case 'ATXHeading5':
				case 'ATXHeading6': {
					// 見出しレベルの行クラス。表に無ければ undefined
					const className = ATX_HEADING_CLASSES[ref.name];
					// クラスがある見出しだけ `#` 隠しまで進める
					if (className) {
						decorateAtxHeading(ref.node, className, state, entries, sourceLineNumbers);
					}

					return false;
				}
				// Setext 見出し。対応するクラスが無い名前は装飾しない
				case 'SetextHeading1':
				case 'SetextHeading2': {
					// 見出しレベルの行クラス。表に無ければ undefined
					const className = SETEXT_HEADING_CLASSES[ref.name];
					// クラスがある見出しだけ下線の扱いまで進める
					if (className) {
						decorateSetextHeading(ref.node, className, state, entries, sourceLineNumbers);
					}

					return false;
				}
				// 引用とコールアウト。内側は decorateBlockquote が処理するので子は見ない
				case 'Blockquote':
					decorateBlockquote(ref.node, state, entries, sourceLineNumbers);
					return false;
				// フェンスコード。引用の内側は引用側が処理する
				case 'FencedCode':
					decorateFencedCode(ref.node, state, entries, sourceLineNumbers);
					return false;
				// 水平線。プレビュー行だけ隠す
				case 'HorizontalRule':
					decorateHorizontalRule(ref.node, state, entries, sourceLineNumbers);
					return false;
				// リスト項目。子のマーカーは decorateListItem が見る
				case 'ListItem':
					decorateListItem(ref.node, state, entries, sourceLineNumbers);
					return;
				default:
					return;
			}
		}
	});

	return entries;
}
