import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
	type EditorState,
	type Extension,
	StateEffect,
	StateField,
} from '@codemirror/state';
import type { ViewMode } from '../types/app';
import { invokeBridge } from '../bridge';
import { buildToggleTaskMarkerTransaction } from '../editor/checkboxToggle';
import { normalizeCaretSelection } from '../editor/caretNormalize';
import { codeLanguageReadyEffect } from '../editor/inlineCodeHighlight';
import { collectBlockDecorationEntries } from './blockWidgets';
import { calloutFoldField, setCalloutFoldEffect } from './calloutFold';
import { filterEntriesOutsideCollapseRanges } from './calloutFoldWidget';
import { collectSourceLineNumbers, isPreviewLineNumber } from './cursorLine';
import {
	createDocumentContextExtensions,
	setDocumentContextEffect,
	type DocumentContext,
} from './documentContext';
import {
	collectCustomDecorationEntries,
	createCustomDecorationsExtensions,
	setCustomDecorationsEffect,
	type CompiledCustomDecorationRule,
} from './customDecorations';
import { collectHtmlDecorationEntries } from './htmlInline';
import { buildDecorationSet, collectInlineDecorationEntries, collectLinkLabelRanges, extractLinkUrl } from './inlineDecorations';
import { collectLineDecorationEntries } from './lineDecorations';
import { collectTagDecorationEntries } from './tagDecorations';

export { setDocumentContextEffect, setCustomDecorationsEffect, type DocumentContext };
export type { CompiledCustomDecorationRule };

const EXTERNAL_LINK_HOVER_CLASS = 'tms-mde-cm-link-hover';

type HoveredExternalLinkRange = {
	from: number;
	to: number;
} | null;

/**
 * 表示モードをエディタ状態へ反映する Effect
 */
export const setViewModeEffect = StateEffect.define<ViewMode>();

const setHoveredExternalLinkRangeEffect = StateEffect.define<HoveredExternalLinkRange>();

const hoveredExternalLinkDecorationsField = StateField.define<DecorationSet>({
	/**
	 * 初期 Decoration を生成する
	 * @returns {DecorationSet}
	 */
	create() {
		return Decoration.none;
	},
	/**
	 * hover範囲変更をDecorationへ反映する
	 * @param {DecorationSet} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {DecorationSet}
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setHoveredExternalLinkRangeEffect)) {
				const range = effect.value;
				if (!range || range.from >= range.to) {
					return Decoration.none;
				}

				return Decoration.set([
					Decoration.mark({ class: 'cm-md-link cm-md-link-hovered' }).range(range.from, range.to),
				]);
			}
		}

		if (transaction.docChanged) {
			return Decoration.none;
		}

		return value;
	},
	/**
	 * エディタへ Decoration を提供する
	 * @param {StateField<DecorationSet>} field フィールド
	 * @returns {Extension}
	 */
	provide: (field) => EditorView.decorations.from(field),
});

/**
 * エディタ状態に保持する表示モード
 */
export const viewModeField = StateField.define<ViewMode>({
	/**
	 * 初期値を生成する
	 * @returns {ViewMode}
	 */
	create() {
		return 'source';
	},
	/**
	 * Effect に応じて更新する
	 * @param {ViewMode} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {ViewMode}
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setViewModeEffect)) {
				return effect.value;
			}
		}

		return value;
	},
});

/**
 * ライブプレビュー用 Decoration を構築する
 * 行構造に影響する replace を含むため、ViewPlugin ではなく StateField から供給する
 * @param {EditorState} state エディタ状態
 * @returns {DecorationSet}
 */
function buildLivePreviewDecorations(state: EditorState): DecorationSet {
	const viewMode = state.field(viewModeField, false) ?? 'source';
	if (viewMode !== 'live-preview') {
		return Decoration.none;
	}

	try {
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = [
			...collectInlineDecorationEntries(state),
			...collectTagDecorationEntries(state, new Set()),
			...collectHtmlDecorationEntries(state),
			...collectCustomDecorationEntries(state, sourceLines),
			...collectLineDecorationEntries(state, sourceLines),
			...collectBlockDecorationEntries(state, sourceLines),
		];

		for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
			if (!isPreviewLineNumber(lineNumber, sourceLines)) {
				continue;
			}

			const line = state.doc.line(lineNumber);
			entries.push({
				from      : line.from,
				to        : line.from,
				decoration: Decoration.line({ class: 'cm-live-preview-line' }),
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
	 * @param {EditorState} state エディタ状態
	 * @returns {DecorationSet}
	 */
	create(state) {
		return buildLivePreviewDecorations(state);
	},
	/**
	 * ドキュメント・選択・モード・折りたたみ変更時に再構築する
	 * @param {DecorationSet} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {DecorationSet}
	 */
	update(value, transaction) {
		const viewModeChanged = transaction.effects.some((effect) => effect.is(setViewModeEffect));
		const foldChanged     = transaction.effects.some((effect) => effect.is(setCalloutFoldEffect));
		const contextChanged  = transaction.effects.some((effect) => effect.is(setDocumentContextEffect));
		const customChanged   = transaction.effects.some((effect) => effect.is(setCustomDecorationsEffect));
		if (
			transaction.docChanged
			|| transaction.selection
			|| viewModeChanged
			|| foldChanged
			|| contextChanged
			|| customChanged
			|| transaction.effects.some((effect) => effect.is(codeLanguageReadyEffect))
		) {
			return buildLivePreviewDecorations(transaction.state);
		}

		return value;
	},
	/**
	 * エディタへ Decoration を提供する
	 * @param {StateField<DecorationSet>} field フィールド
	 * @returns {Extension}
	 */
	provide: (field) => EditorView.decorations.from(field),
});

/**
 * 行末はみ出しキャレットを正規化するリスナー
 */
const caretNormalizeListener = EditorView.updateListener.of((update) => {
	if (!update.selectionSet && !update.docChanged) {
		return;
	}

	// 自身の正規化トランザクションでは再入しない
	if (update.transactions.some((transaction) => transaction.isUserEvent('select.normalize'))) {
		return;
	}

	const normalized = normalizeCaretSelection(update.state);
	if (!normalized) {
		return;
	}

	update.view.dispatch({
		selection : normalized,
		userEvent: 'select.normalize',
	});
});

/**
 * イベントターゲットから最寄りの HTMLElement を取得する
 * @param {EventTarget | null} target イベントターゲット
 * @returns {HTMLElement | null}
 */
export function getElementFromEventTarget(target: EventTarget | null): HTMLElement | null {
	if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) {
		return target;
	}

	if (typeof Node !== 'undefined' && target instanceof Node) {
		return target.parentElement;
	}

	const parentElement = (target as { parentElement?: unknown } | null)?.parentElement;
	if (parentElement && (typeof HTMLElement === 'undefined' || parentElement instanceof HTMLElement)) {
		return parentElement as HTMLElement;
	}

	return null;
}

/**
 * イベントターゲットから標準 Markdown リンク要素を取得する
 * @param {EventTarget | null} target イベントターゲット
 * @returns {HTMLElement | null}
 */
export function findMarkdownLinkElement(target: EventTarget | null): HTMLElement | null {
	const element = getElementFromEventTarget(target);
	const link    = element?.closest?.('.cm-md-link');
	if (!link) {
		return null;
	}

	if (typeof HTMLElement === 'undefined' || link instanceof HTMLElement) {
		return link as HTMLElement;
	}

	return null;
}

/**
 * 外部起動対象の URL か判定する
 * @param {string} href URL
 * @returns {boolean}
 */
export function isSupportedExternalLinkUrl(href: string): boolean {
	try {
		const url = new URL(href);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * 文書位置から標準 Markdown リンクの URL を取得する
 * @param {EditorState} state エディタ状態
 * @param {number} pos 文書位置
 * @returns {string | null}
 */
export function findMarkdownLinkUrlAtPosition(state: EditorState, pos: number): string | null {
	return findMarkdownLinkAtPosition(state, pos)?.href ?? null;
}

/**
 * 文書位置から標準 Markdown リンク情報を取得する
 * @param {EditorState} state エディタ状態
 * @param {number} pos 文書位置
 * @returns {{ href: string; from: number; to: number } | null}
 */
export function findMarkdownLinkAtPosition(
	state: EditorState,
	pos: number,
): { href: string; from: number; to: number } | null {
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
	while (node) {
		if (node.name === 'Link') {
			const href = extractLinkUrl(state, node);
			if (!href) {
				return null;
			}

			const labelRange = collectLinkLabelRanges(node).find((range) => pos >= range.from && pos <= range.to)
				?? collectLinkLabelRanges(node)[0];
			if (!labelRange) {
				return null;
			}

			return { href, from: labelRange.from, to: labelRange.to };
		}

		node = node.parent;
	}

	return null;
}

/**
 * マウスイベントから標準 Markdown リンクの URL を取得する
 * @param {EditorView} view エディタビュー
 * @param {MouseEvent} event マウスイベント
 * @returns {string | null}
 */
export function findMarkdownLinkUrlFromMouseEvent(view: EditorView, event: MouseEvent): string | null {
	const linkElement = findMarkdownLinkElement(event.target);
	if (linkElement?.dataset.href) {
		return linkElement.dataset.href;
	}

	const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
	if (pos === null) {
		return null;
	}

	return findMarkdownLinkUrlAtPosition(view.state, pos);
}

/**
 * マウスイベントから標準 Markdown リンク情報を取得する
 * @param {EditorView} view エディタビュー
 * @param {MouseEvent} event マウスイベント
 * @returns {{ href: string; from: number; to: number } | null}
 */
export function findMarkdownLinkFromMouseEvent(
	view: EditorView,
	event: MouseEvent,
): { href: string; from: number; to: number } | null {
	const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
	if (pos === null) {
		return null;
	}

	return findMarkdownLinkAtPosition(view.state, pos);
}

/**
 * Ctrl+クリックで外部リンクを開き、CodeMirrorの選択移動より先にイベントを止める
 * @param {EditorView} view エディタビュー
 * @param {MouseEvent} event マウスイベント
 * @returns {boolean}
 */
export function handleExternalLinkMouseDown(view: EditorView, event: MouseEvent): boolean {
	if (event.button !== 0 || !event.ctrlKey) {
		return false;
	}

	const href = findMarkdownLinkUrlFromMouseEvent(view, event);
	if (!href || !isSupportedExternalLinkUrl(href)) {
		return false;
	}

	event.preventDefault();
	event.stopPropagation();
	void invokeBridge('shell:openExternal', { url: href });
	return true;
}

/**
 * マウス位置が外部リンク上なら pointer 用クラスを切り替える
 * @param {EditorView} view エディタビュー
 * @param {MouseEvent} event マウスイベント
 * @returns {boolean}
 */
export function updateExternalLinkHoverCursor(view: EditorView, event: MouseEvent): boolean {
	const link       = findMarkdownLinkFromMouseEvent(view, event);
	const linkActive = link !== null && isSupportedExternalLinkUrl(link.href);
	view.dom.classList.toggle(EXTERNAL_LINK_HOVER_CLASS, linkActive);
	view.dispatch({
		effects: setHoveredExternalLinkRangeEffect.of(linkActive ? { from: link.from, to: link.to } : null),
	});
	return linkActive;
}

const externalLinkMouseDownPlugin = ViewPlugin.define((view) => {
	/**
	 * capture段階で外部リンクを処理する
	 * @param {MouseEvent} event マウスイベント
	 * @returns {void}
	 */
	const onMouseDown = (event: MouseEvent): void => {
		handleExternalLinkMouseDown(view, event);
	};

	/**
	 * 外部リンク上のカーソル形状を切り替える
	 * @param {MouseEvent} event マウスイベント
	 * @returns {void}
	 */
	const onMouseMove = (event: MouseEvent): void => {
		updateExternalLinkHoverCursor(view, event);
	};

	/**
	 * エディタ外へ出たらカーソル形状を戻す
	 * @returns {void}
	 */
	const onMouseLeave = (): void => {
		view.dom.classList.remove(EXTERNAL_LINK_HOVER_CLASS);
		view.dispatch({ effects: setHoveredExternalLinkRangeEffect.of(null) });
	};

	view.dom.addEventListener('mousedown', onMouseDown, true);
	view.dom.addEventListener('mousemove', onMouseMove);
	view.dom.addEventListener('mouseleave', onMouseLeave);

	return {
		/**
		 * capture listener を解除する
		 * @returns {void}
		 */
		destroy(): void {
			view.dom.removeEventListener('mousedown', onMouseDown, true);
			view.dom.removeEventListener('mousemove', onMouseMove);
			view.dom.removeEventListener('mouseleave', onMouseLeave);
			view.dom.classList.remove(EXTERNAL_LINK_HOVER_CLASS);
		},
	};
});

/**
 * ライブプレビュー拡張を生成する
 * @param {ViewMode} initialViewMode 初期表示モード
 * @param {DocumentContext} [documentContext] ドキュメント文脈
 * @param {CompiledCustomDecorationRule[]} [customDecorations] カスタム装飾ルール
 * @returns {Extension[]}
 */
export function createLivePreviewExtensions(
	initialViewMode: ViewMode,
	documentContext?: DocumentContext,
	customDecorations: CompiledCustomDecorationRule[] = [],
): Extension[] {
	return [
		viewModeField.init(() => initialViewMode),
		hoveredExternalLinkDecorationsField,
		...createDocumentContextExtensions(documentContext ?? {
			filePath         : null,
			loadRemoteImages : true,
		}),
		...createCustomDecorationsExtensions(customDecorations),
		calloutFoldField,
		EditorView.editorAttributes.compute([viewModeField], (state): Record<string, string> => {
			const mode = state.field(viewModeField, false) ?? 'source';
			if (mode !== 'live-preview') {
				return {};
			}

			return { class: 'tms-mde-cm-live-preview' };
		}),
		livePreviewDecorationsField,
		caretNormalizeListener,
		externalLinkMouseDownPlugin,
		EditorView.domEventHandlers({
			/**
			 * チェックボックストグル / コールアウト折りたたみ
			 * @param {MouseEvent} event マウスイベント
			 * @param {EditorView} view エディタビュー
			 * @returns {boolean}
			 */
			mousedown(event, view) {
				if (event.button !== 0) {
					return false;
				}

				const target = getElementFromEventTarget(event.target);
				if (!target) {
					return false;
				}

				const foldButton = target.closest('.cm-md-callout-fold');
				if (foldButton instanceof HTMLElement) {
					const fromText = foldButton.dataset.calloutFrom;
					const from     = fromText ? Number(fromText) : Number.NaN;
					if (!Number.isFinite(from)) {
						return false;
					}

					const overrides = view.state.field(calloutFoldField, false) ?? new Map();
					const current   = overrides.get(from);
					const collapsed = current === undefined
						? foldButton.getAttribute('aria-expanded') === 'false'
						: current;
					event.preventDefault();
					view.dispatch({
						effects: setCalloutFoldEffect.of({
							from,
							collapsed: !collapsed,
						}),
					});
					return true;
				}

				const checkbox = target.closest('.cm-md-checkbox');
				if (checkbox instanceof HTMLElement) {
					const pos  = view.posAtDOM(checkbox);
					const spec = buildToggleTaskMarkerTransaction(view.state, pos);
					if (!spec) {
						return false;
					}

					event.preventDefault();
					view.dispatch(spec);
					return true;
				}

				return false;
			},
		}),
	];
}
