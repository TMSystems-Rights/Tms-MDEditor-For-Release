/**
 * ライブプレビューの装飾、チェックボックス、外部リンクのクリックとホバーを一つの拡張にまとめる
 * 文書の保存は持たず、各コレクタの結果を DecorationSet にしてエディタへ渡す
 * @file
 */
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import type { ViewMode } from '../types/app';
import { BRIDGE_METHOD, invokeBridge } from '../bridge';
import { buildToggleTaskMarkerTransaction } from '../editor/checkboxToggle';
import { normalizeCaretSelection } from '../editor/caretNormalize';
import { codeLanguageReadyEffect } from '../editor/inlineCodeHighlight';
import { collectBlockDecorationEntries } from './blockWidgets';
import { calloutFoldField, setCalloutFoldEffect } from './calloutFold';
import { filterEntriesOutsideCollapseRanges } from './calloutFoldWidget';
import { collectSourceLineNumbers, isPreviewLineNumber } from './cursorLine';
import { createDocumentContextExtensions, setDocumentContextEffect, type DocumentContext } from './documentContext';
import { collectCustomDecorationEntries, createCustomDecorationsExtensions, setCustomDecorationsEffect, type CompiledCustomDecorationRule } from './customDecorations';
import { collectHtmlDecorationEntries } from './htmlInline';
import { buildDecorationSet, collectInlineDecorationEntries, collectLinkLabelRanges, extractLinkUrl } from './inlineDecorations';
import { collectLineDecorationEntries } from './lineDecorations';
import { collectTagDecorationEntries } from './tagDecorations';
import { tableHistoryFocusExtension } from './tableWidget';

export { setDocumentContextEffect, setCustomDecorationsEffect, type DocumentContext };
export type { CompiledCustomDecorationRule };

// ----------------------------------------------
// 外部リンクのホバー
// ----------------------------------------------
/** 外部リンク上でポインタにする、エディタ根のクラス。実行中は変えない */
const EXTERNAL_LINK_HOVER_CLASS = 'tms-mde-cm-link-hover';

/** ホバー中の外部リンク範囲。ホバーが無ければ null。文書が変わると消す */
type HoveredExternalLinkRange = {
	from: number;
	to: number;
} | null;

/**
 * 表示モードをエディタ状態へ反映する Effect
 */
export const setViewModeEffect = StateEffect.define<ViewMode>();

/** ホバー中の外部リンク範囲を置き換える Effect。null で消す */
const setHoveredExternalLinkRangeEffect = StateEffect.define<HoveredExternalLinkRange>();

/** ホバー中リンクの mark を保持する StateField。文書変更で消える */
const hoveredExternalLinkDecorationsField = StateField.define<DecorationSet>({
	/**
	 * 初期 Decoration を生成する
	 * @returns 初期 Decoration
	 */
	create() {
		return Decoration.none;
	},
	/**
	 * hover範囲変更をDecorationへ反映する
	 * @param value - 現在値
	 * @param transaction - トランザクション
	 * @returns hover範囲変更をDecorationへ反映する
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			// ホバー範囲の Effect だけ mark を組み直す
			if (effect.is(setHoveredExternalLinkRangeEffect)) {
				// ホバー中の範囲。ホバーが無ければ null
				const range = effect.value;
				// 範囲が無い、または空のときは mark を消す。どちらか一方でも none
				if (!range || range.from >= range.to) {
					return Decoration.none;
				}

				return Decoration.set([Decoration.mark({ class: 'cm-md-link cm-md-link-hovered' }).range(range.from, range.to)]);
			}
		}

		// 本文が変わったホバー範囲は、位置がずれるので消す
		if (transaction.docChanged) {
			return Decoration.none;
		}

		return value;
	},
	/**
	 * エディタへ Decoration を提供する
	 * @param field - フィールド
	 * @returns エディタへ Decoration を提供する
	 */
	provide: (field) => EditorView.decorations.from(field)
});

/**
 * エディタ状態に保持する表示モード
 */
export const viewModeField = StateField.define<ViewMode>({
	/**
	 * 初期値を生成する
	 * @returns 初期値
	 */
	create() {
		return 'source';
	},
	/**
	 * Effect に応じて更新する
	 * @param value - 現在値
	 * @param transaction - トランザクション
	 * @returns Effect に応じて更新する
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			// 表示モード Effect があるときだけ、その値へ切り替える
			if (effect.is(setViewModeEffect)) {
				return effect.value;
			}
		}

		return value;
	}
});

/**
 * ライブプレビュー用 Decoration を構築する
 * 行構造に影響する replace を含むため、ViewPlugin ではなく StateField から供給する
 * @param state - エディタ状態
 * @returns ライブプレビュー用 Decoration
 */
function buildLivePreviewDecorations(state: EditorState): DecorationSet {
	// 現在の表示モード。フィールドが無ければソース表示
	const viewMode = state.field(viewModeField, false) ?? 'source';
	// ライブプレビュー以外では行装飾を作らない
	if (viewMode !== 'live-preview') {
		return Decoration.none;
	}

	try {
		// ソース表示のまま残す行。プレビュー行だけ記法を隠す
		const sourceLines = collectSourceLineNumbers(state);
		// 各コレクタの装飾。プレビュー行クラスは後から足す
		const entries     = [...collectInlineDecorationEntries(state), ...collectTagDecorationEntries(state, new Set()), ...collectHtmlDecorationEntries(state), ...collectCustomDecorationEntries(state, sourceLines), ...collectLineDecorationEntries(state, sourceLines), ...collectBlockDecorationEntries(state, sourceLines)];

		for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
			// ソース行にはプレビュー用の行クラスを付けない
			if (!isPreviewLineNumber(lineNumber, sourceLines)) {
				continue;
			}

			// クラスを付ける行。ポイント装飾なので位置は行頭
			const line = state.doc.line(lineNumber);
			// プレビュー行の行クラス
			entries.push({
				// 行頭。ポイント装飾なので to と同じ
				from: line.from,
				// 行頭。ポイント装飾なので from と同じ
				to: line.from,
				// プレビュー行の見た目
				decoration: Decoration.line({ class: 'cm-live-preview-line' })
			});
		}

		return buildDecorationSet(filterEntriesOutsideCollapseRanges(entries));
	} catch {
		// 装飾構築失敗でトランザクション全体を落とさない
		return Decoration.none;
	}
}

/**
 * ライブプレビュー装飾を保持する StateField
 */
const livePreviewDecorationsField = StateField.define<DecorationSet>({
	/**
	 * 初期 Decoration を生成する
	 * @param state - エディタ状態
	 * @returns 初期 Decoration
	 */
	create(state) {
		return buildLivePreviewDecorations(state);
	},
	/**
	 * ドキュメント・選択・モード・折りたたみ変更時に再構築する
	 * @param value - 現在値
	 * @param transaction - トランザクション
	 * @returns ドキュメント・選択・モード・折りたたみ変更時に再構築する
	 */
	update(value, transaction) {
		// 表示モードが切り替わったか
		const viewModeChanged = transaction.effects.some((effect) => effect.is(setViewModeEffect));
		// コールアウトの折りたたみが変わったか
		const foldChanged     = transaction.effects.some((effect) => effect.is(setCalloutFoldEffect));
		// 文書パスや画像読み込みの文脈が変わったか
		const contextChanged  = transaction.effects.some((effect) => effect.is(setDocumentContextEffect));
		// カスタム装飾ルールが変わったか
		const customChanged   = transaction.effects.some((effect) => effect.is(setCustomDecorationsEffect));
		// 本文、選択、モード、折りたたみ、文脈、装飾、言語のどれかが変わったとき再構築する
		if (transaction.docChanged || transaction.selection || viewModeChanged || foldChanged || contextChanged || customChanged || transaction.effects.some((effect) => effect.is(codeLanguageReadyEffect))) {
			return buildLivePreviewDecorations(transaction.state);
		}

		return value;
	},
	/**
	 * エディタへ Decoration を提供する
	 * @param field - フィールド
	 * @returns エディタへ Decoration を提供する
	 */
	provide: (field) => EditorView.decorations.from(field)
});

/**
 * キャレット補正を実行してよい更新か判定する
 * @param docChanged - 本文変更あり
 * @param selectionSet - 選択変更あり
 * @param compositionStarted - IME composition 開始中か
 * @returns 補正可能な場合 true
 */
export function shouldNormalizeCaretAfterUpdate(docChanged: boolean, selectionSet: boolean, compositionStarted: boolean): boolean {
	return !docChanged && selectionSet && !compositionStarted;
}

/**
 * 行末はみ出しキャレットを正規化するリスナー
 */
const caretNormalizeListener = EditorView.updateListener.of((update) => {
	// 文字入力直後は compositionstart より先に docChanged が届く場合がある
	// この時点で selection を再設定すると先頭のローマ字が確定・重複するため、
	// 本文変更を含む更新では補正しない
	if (!shouldNormalizeCaretAfterUpdate(update.docChanged, update.selectionSet, update.view.compositionStarted)) {
		return;
	}

	// 自身の正規化トランザクションでは再入しない
	if (update.transactions.some((transaction) => transaction.isUserEvent('select.normalize'))) {
		return;
	}

	// composition DOM の途中で選択を再設定すると、行頭の最初のローマ字が重複する
	// 行末はみ出しを直した選択。直す必要が無ければ null
	const normalized = normalizeCaretSelection(update.state);
	// 補正が無い更新では選択を再設定しない
	if (!normalized) {
		return;
	}

	// 補正した選択だけを置き換える。本文は変えない
	update.view.dispatch({
		// 行末へ収めた選択
		selection: normalized,
		// この正規化自身では再入しないための印
		userEvent: 'select.normalize'
	});
});

/**
 * イベントターゲットから最寄りの HTMLElement を取得する
 * @param target - イベントターゲット
 * @returns イベントターゲットから最寄りの HTMLElement 。無ければ null
 */
export function getElementFromEventTarget(target: EventTarget | null): HTMLElement | null {
	// 実行環境に HTMLElement があり、かつターゲット自身が要素のときだけそれを返す。どちらか一方では次の判定へ進む
	if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) {
		return target;
	}

	// ノードなら親要素を返す。親が無ければ null
	if (typeof Node !== 'undefined' && target instanceof Node) {
		return target.parentElement;
	}

	// 要素でないターゲットが持つ親。無ければ undefined
	const parentElement = (target as { parentElement?: unknown } | null)?.parentElement;
	// 親があり、かつ HTMLElement が無い環境か親が要素のとき返す。親が無いときは返さない
	if (parentElement && (typeof HTMLElement === 'undefined' || parentElement instanceof HTMLElement)) {
		return parentElement as HTMLElement;
	}

	return null;
}

/**
 * イベントターゲットから標準 Markdown リンク要素を取得する
 * @param target - イベントターゲット
 * @returns イベントターゲットから標準 Markdown リンク要素。無ければ null
 */
export function findMarkdownLinkElement(target: EventTarget | null): HTMLElement | null {
	// イベントから辿った要素。取れなければ以降は null
	const element = getElementFromEventTarget(target);
	// 最寄りの標準リンク要素。closest が無ければ undefined
	const link    = element?.closest?.('.cm-md-link');
	// リンク要素まで辿れなければ null
	if (!link) {
		return null;
	}

	// HTMLElement が無い環境か、リンクが要素ならそれを返す。どちらでもなければ null
	if (typeof HTMLElement === 'undefined' || link instanceof HTMLElement) {
		return link as HTMLElement;
	}

	return null;
}

/**
 * 外部起動対象の URL か判定する
 * @param href - URL
 * @returns 外部起動対象の URL なら true
 */
export function isSupportedExternalLinkUrl(href: string): boolean {
	try {
		// パースできた URL。相対パスや不正な文字列は catch へ落ちる
		const url = new URL(href);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * 文書位置から標準 Markdown リンクの URL を取得する
 * @param state - エディタ状態
 * @param pos - 文書位置
 * @returns 文書位置から標準 Markdown リンクの URL 。無ければ null
 */
export function findMarkdownLinkUrlAtPosition(state: EditorState, pos: number): string | null {
	return findMarkdownLinkAtPosition(state, pos)?.href ?? null;
}

/**
 * 文書位置から標準 Markdown リンク情報を取得する
 * @param state - エディタ状態
 * @param pos - 文書位置
 * @returns 文書位置から標準 Markdown リンク情報。無ければ null
 */
export function findMarkdownLinkAtPosition(state: EditorState, pos: number): { href: string; from: number; to: number } | null {
	// 位置の内側のノード。リンクまで辿れなければ null
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
	while (node) {
		// リンクノードに当たったときだけ URL と表示範囲を返す
		if (node.name === 'Link') {
			// リンク先。URL ノードが無ければ空文字
			const href = extractLinkUrl(state, node);
			// リンク先が空なら、位置がリンクの中でも情報は返さない
			if (!href) {
				return null;
			}

			// 位置を含む表示範囲。無ければ最初のラベル。ラベル自体が無ければ undefined
			const labelRange = collectLinkLabelRanges(node).find((range) => pos >= range.from && pos <= range.to) ?? collectLinkLabelRanges(node)[0];
			// 表示範囲が取れなければリンク情報にしない
			if (!labelRange) {
				return null;
			}

			// 外部起動とホバーに使うリンク
			return {
				// リンク先。空ではここに来ない
				href,
				// 表示ラベルの開始
				from: labelRange.from,
				// 表示ラベルの終端
				to: labelRange.to
			};
		}

		node = node.parent;
	}

	return null;
}

/**
 * マウスイベントから標準 Markdown リンクの URL を取得する
 * @param view - エディタビュー
 * @param event - マウスイベント
 * @returns マウスイベントから標準 Markdown リンクの URL 。無ければ null
 */
export function findMarkdownLinkUrlFromMouseEvent(view: EditorView, event: MouseEvent): string | null {
	// クリック位置のリンク要素。無ければ undefined
	const linkElement = findMarkdownLinkElement(event.target);
	// 要素に data-href があるときは構文木を見ない
	if (linkElement?.dataset.href) {
		return linkElement.dataset.href;
	}

	// 座標から求めた文書位置。座標がエディタ外なら null
	const pos = view.posAtCoords({
		// 画面上の横位置
		x: event.clientX,
		// 画面上の縦位置
		y: event.clientY
	});
	// 文書位置が取れなければ URL も取れない
	if (pos === null) {
		return null;
	}

	return findMarkdownLinkUrlAtPosition(view.state, pos);
}

/**
 * マウスイベントから標準 Markdown リンク情報を取得する
 * @param view - エディタビュー
 * @param event - マウスイベント
 * @returns マウスイベントから標準 Markdown リンク情報。無ければ null
 */
export function findMarkdownLinkFromMouseEvent(view: EditorView, event: MouseEvent): { href: string; from: number; to: number } | null {
	// 座標から求めた文書位置。座標がエディタ外なら null
	const pos = view.posAtCoords({
		// 画面上の横位置
		x: event.clientX,
		// 画面上の縦位置
		y: event.clientY
	});
	// 文書位置が取れなければリンク情報も取れない
	if (pos === null) {
		return null;
	}

	return findMarkdownLinkAtPosition(view.state, pos);
}

/**
 * Ctrl+クリックで外部リンクを開き、CodeMirrorの選択移動より先にイベントを止める
 * @param view - エディタビュー
 * @param event - マウスイベント
 * @returns Ctrl+クリックで外部リンクを開き、CodeMirrorの選択移動より先にイベントを止めるなら true
 */
export function handleExternalLinkMouseDown(view: EditorView, event: MouseEvent): boolean {
	// 左ボタンでない、または Ctrl が無いときは開かない。どちらか一方でも false
	if (event.button !== 0 || !event.ctrlKey) {
		return false;
	}

	// クリック位置のリンク先。リンクでなければ null
	const href = findMarkdownLinkUrlFromMouseEvent(view, event);
	// リンク先が無い、または http(s) でないときは開かない。どちらか一方でも false
	if (!href || !isSupportedExternalLinkUrl(href)) {
		return false;
	}

	event.preventDefault();
	event.stopPropagation();
	void invokeBridge(BRIDGE_METHOD.shellOpenExternal, { url: href });
	return true;
}

/**
 * マウス位置が外部リンク上なら pointer 用クラスを切り替える
 * @param view - エディタビュー
 * @param event - マウスイベント
 * @returns マウス位置が外部リンク上なら pointer 用クラスなら true
 */
export function updateExternalLinkHoverCursor(view: EditorView, event: MouseEvent): boolean {
	// マウス位置のリンク。無ければ null
	const link       = findMarkdownLinkFromMouseEvent(view, event);
	// リンクがあり、かつ http(s) のときだけホバーを付ける。どちらか一方が欠けても false
	const linkActive = link !== null && isSupportedExternalLinkUrl(link.href);
	view.dom.classList.toggle(EXTERNAL_LINK_HOVER_CLASS, linkActive);
	// ホバー範囲を置き換える。外部リンクでなければ null で消す
	view.dispatch({
		// ホバー mark 用の Effect。リンクでなければ範囲を消す
		effects: setHoveredExternalLinkRangeEffect.of(
			linkActive
				? {
					// 表示ラベルの開始
					from: link.from,
					// 表示ラベルの終端
					to: link.to
				}
				: null
		)
	});
	return linkActive;
}

/** 外部リンクの押下、移動、離脱を capture で受ける ViewPlugin */
const externalLinkMouseDownPlugin = ViewPlugin.define((view) => {
	/**
	 * capture段階で外部リンクを処理する
	 * @param event - マウスイベント
	 */
	const onMouseDown = (event: MouseEvent): void => {
		handleExternalLinkMouseDown(view, event);
	};

	/**
	 * 外部リンク上のカーソル形状を切り替える
	 * @param event - マウスイベント
	 */
	const onMouseMove = (event: MouseEvent): void => {
		updateExternalLinkHoverCursor(view, event);
	};

	/**
	 * エディタ外へ出たらカーソル形状を戻す
	 */
	const onMouseLeave = (): void => {
		view.dom.classList.remove(EXTERNAL_LINK_HOVER_CLASS);
		view.dispatch({ effects: setHoveredExternalLinkRangeEffect.of(null) });
	};

	// 左ボタンの Ctrl+クリックで外部リンクを開く。capture なので選択移動より先に止める
	view.dom.addEventListener('mousedown', onMouseDown, true);
	// 移動のたびに、外部リンク上ならポインタ用クラスを切り替える
	view.dom.addEventListener('mousemove', onMouseMove);
	// エディタから出たらホバークラスと範囲を消す
	view.dom.addEventListener('mouseleave', onMouseLeave);

	return {
		/**
		 * capture listener を解除する
		 */
		destroy(): void {
			view.dom.removeEventListener('mousedown', onMouseDown, true);
			view.dom.removeEventListener('mousemove', onMouseMove);
			view.dom.removeEventListener('mouseleave', onMouseLeave);
			view.dom.classList.remove(EXTERNAL_LINK_HOVER_CLASS);
		}
	};
});

// ----------------------------------------------
// 拡張の組み立て
// ----------------------------------------------
/**
 * ライブプレビュー拡張を生成する
 * @param initialViewMode - 初期表示モード
 * @param documentContext - ドキュメント文脈。省略可
 * @param customDecorations - カスタム装飾ルール。省略可
 * @returns ライブプレビュー拡張
 */
export function createLivePreviewExtensions(initialViewMode: ViewMode, documentContext?: DocumentContext, customDecorations: CompiledCustomDecorationRule[] = []): Extension[] {
	return [
		viewModeField.init(() => initialViewMode),
		hoveredExternalLinkDecorationsField,
		...createDocumentContextExtensions(
			documentContext ?? {
				// 文脈が渡されないときのパス。未保存と同じ
				filePath: null,
				// 文脈が渡されないときはリモート画像の読み込みを許可する
				loadRemoteImages: true
			}
		),
		...createCustomDecorationsExtensions(customDecorations),
		calloutFoldField,
		EditorView.editorAttributes.compute([viewModeField], (state): Record<string, string> => {
			// 現在の表示モード。フィールドが無ければソース表示
			const mode = state.field(viewModeField, false) ?? 'source';
			// ライブプレビュー以外ではエディタ根にクラスを付けない
			if (mode !== 'live-preview') {
				return {};
			}

			return { class: 'tms-mde-cm-live-preview' };
		}),
		livePreviewDecorationsField,
		tableHistoryFocusExtension,
		caretNormalizeListener,
		externalLinkMouseDownPlugin,
		EditorView.domEventHandlers({
			/**
			 * チェックボックストグル / コールアウト折りたたみ
			 * @param event - マウスイベント
			 * @param view - エディタビュー
			 * @returns チェックボックストグル / コールアウト折りたたみなら true
			 */
			mousedown(event, view) {
				// 左ボタン以外の押下は、折りたたみもチェックも扱わない
				if (event.button !== 0) {
					return false;
				}

				// 押下位置の要素。取れなければ何もしない
				const target = getElementFromEventTarget(event.target);
				// 要素が無ければエディタの選択へ返す
				if (!target) {
					return false;
				}

				// 最寄りの折りたたみボタン。無ければ null
				const foldButton = target.closest('.cm-md-callout-fold');
				// 折りたたみボタンのときだけ、上書きを反転する
				if (foldButton instanceof HTMLElement) {
					// dataset の開始位置。未設定なら undefined
					const fromText = foldButton.dataset.calloutFrom;
					// 開始位置。文字列が無ければ NaN で、有限チェックに落ちる
					const from     = fromText ? Number(fromText) : Number.NaN;
					// 開始位置が数値でないボタンは折りたたみを変えない
					if (!Number.isFinite(from)) {
						return false;
					}

					// 開始位置から折りたたみ上書き。フィールドが無ければ空
					const overrides = view.state.field(calloutFoldField, false) ?? new Map();
					// この位置の上書き。無ければ undefined で、ボタンの aria を見る
					const current   = overrides.get(from);
					// 次に書く折りたたみ。上書きが無ければ、いま折りたたみ中なら true
					const collapsed = current === undefined ? foldButton.getAttribute('aria-expanded') === 'false' : current;
					event.preventDefault();
					// このコールアウトの折りたたみを反転する
					view.dispatch({
						// 折りたたみ上書き。位置と次の状態
						effects: setCalloutFoldEffect.of({
							// blockquote の開始位置
							from,
							// いまの状態の反転。上書きが無いときは aria の反転
							collapsed: !collapsed
						})
					});
					return true;
				}

				// 最寄りのチェックボックス。無ければ null
				const checkbox = target.closest('.cm-md-checkbox');
				// チェックボックスのときだけタスク記法を反転する
				if (checkbox instanceof HTMLElement) {
					// チェックボックスに対応する文書位置
					const pos  = view.posAtDOM(checkbox);
					// タスク記法を反転する変更。記法が無ければ null
					const spec = buildToggleTaskMarkerTransaction(view.state, pos);
					// 反転する記法が無ければ選択へ返す
					if (!spec) {
						return false;
					}

					event.preventDefault();
					view.dispatch(spec);
					return true;
				}

				return false;
			}
		})
	];
}
