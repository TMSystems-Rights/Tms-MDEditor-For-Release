import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { indentOnInput } from '@codemirror/language';
import { EditorState, Prec, StateEffect, type Extension, type Transaction } from '@codemirror/state';
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	keymap,
	lineNumbers,
} from '@codemirror/view';
import type { AppSettings, EolKind, ViewMode } from '../types/app';
import {
	createLivePreviewExtensions,
	type CompiledCustomDecorationRule,
} from '../livePreview/livePreviewPlugin';
import { createEolMarkerExtensions } from './eolMarkers';
import { toggleCheckboxCommand } from './checkboxToggle';
import { continueListMarkup } from './listContinuation';
import { dedentListItem, indentListItem } from './listIndent';
import { createInlineCodeHighlightExtensions } from './inlineCodeHighlight';
import { createMarkdownSyntaxHighlighting } from './markdownHighlightStyle';
import { shouldSkipEditorPasteCapture } from './pasteCapture';
import {
	cursorStableLineDown,
	cursorStableLineUp,
	createVerticalMotionExtensions,
	selectStableLineDown,
	selectStableLineUp,
} from './verticalMotion';
import { createCaretBlinkExtension } from './caretBlink';
import { createTmsMarkdownSupport } from './createTmsMarkdown';
import { createOutlineScrollExtension } from '../outline/outline';
import { createSearchExtensions } from '../search/searchPanel';

type CreateEditorOptions = {
	text: string;
	settings: AppSettings;
	viewMode: ViewMode;
	filePath?: string | null;
	lineEols?: Array<EolKind | null>;
	customDecorations?: CompiledCustomDecorationRule[];
	readOnly?: boolean;
	onDocChange: (view: EditorView) => void;
	onSelectionChange: (view: EditorView) => void;
	onPaste?: (event: ClipboardEvent, view: EditorView) => boolean;
};

/**
 * CM6 EditorState を生成する
 * @param {CreateEditorOptions} options 生成オプション
 * @returns {EditorState} エディタ状態
 */
export function createEditorState(options: CreateEditorOptions): EditorState {
	return EditorState.create({
		doc       : options.text,
		extensions: createEditorExtensions(options),
	});
}

/**
 * 設定変更後の拡張構成を既存 EditorState へ反映する。
 * @param {EditorState} state 現在の状態
 * @param {CreateEditorOptions} options 新しい設定を含む生成オプション
 * @returns {EditorState} 再構成後の状態
 */
export function reconfigureEditorState(state: EditorState, options: CreateEditorOptions): EditorState {
	return state.update({
		effects: StateEffect.reconfigure.of(createEditorExtensions(options)),
	}).state;
}

/**
 * ネイティブキャレットを隠し、描画キャレットをテーマ色で前面に出す。
 * 選択レイヤーを行背景より前へ出したあと、CM ライトテーマ既定の黒キャレットが漏れないようにする。
 * @returns {Extension} キャレット表示用テーマ
 */
function createCaretVisibilityExtension(): Extension {
	return Prec.highest(EditorView.theme({
		'.cm-content': {
			caretColor: 'transparent !important',
		},
		'.cm-line': {
			caretColor: 'transparent !important',
		},
		'.cm-content :focus': {
			caretColor: 'var(--tms-mde-color-caret) !important',
		},
		'.cm-cursor, .cm-dropCursor': {
			borderLeft     : '2px solid var(--tms-mde-color-caret) !important',
			borderLeftColor: 'var(--tms-mde-color-caret) !important',
		},
	}));
}

/**
 * 行番号ガターをテーマ変数で固定する。
 * CM ライト基テーマの `&light .cm-gutters` が通常テーマより詳細度で勝つため、!important で上書きする。
 * @returns {Extension} ガター表示用テーマ
 */
function createGutterThemeExtension(): Extension {
	return Prec.highest(EditorView.theme({
		'.cm-gutters': {
			backgroundColor: 'var(--tms-mde-color-surface) !important',
			color          : 'var(--tms-mde-color-text-muted) !important',
			borderRight    : '1px solid var(--tms-mde-color-border) !important',
		},
		'.cm-gutterElement': {
			color: 'var(--tms-mde-color-text-muted) !important',
		},
		'.cm-activeLineGutter': {
			backgroundColor: 'var(--tms-mde-color-active-line) !important',
		},
	}));
}

/**
 * EditorState に組み込む拡張一覧を生成する。
 * @param {CreateEditorOptions} options 生成オプション
 * @returns {Extension[]} 拡張一覧
 */
function createEditorExtensions(options: CreateEditorOptions): Extension[] {
	const extensions: Extension[] = [
		history(),
		drawSelection({ cursorBlinkRate: 0 }),
		createCaretVisibilityExtension(),
		createGutterThemeExtension(),
		createCaretBlinkExtension(),
		highlightActiveLine(),
		indentOnInput(),
		...createMarkdownSyntaxHighlighting(),
		createTmsMarkdownSupport({ addKeymap: false }),
		...createInlineCodeHighlightExtensions(),
		EditorState.tabSize.of(options.settings.tabSize),
		...createVerticalMotionExtensions(),
		...createSearchExtensions(options.settings.search),
		createOutlineScrollExtension(),
		EditorView.theme({
			'&': {
				height                     : '100%',
				fontSize                   : `${options.settings.editorFontSize}px`,
				fontFamily                 : options.settings.editorFontFamily,
				lineHeight                  : '1.4',
				'--tms-mde-editor-font-size': `${options.settings.editorFontSize}px`,
			},
			'.cm-scroller': {
				overflow: 'auto',
				fontFamily: 'inherit',
				lineHeight : '1.4',
			},
			'.cm-content': {
				minHeight : '100%',
				lineHeight: '1.4',
			},
			'.cm-line': {
				lineHeight: '1.4',
			},
			'.cm-gutters': {
				backgroundColor: 'var(--tms-mde-color-surface)',
				color          : 'var(--tms-mde-color-text-muted)',
				borderRight    : '1px solid var(--tms-mde-color-border)',
			},
			'.cm-activeLine': {
				backgroundColor: 'var(--tms-mde-color-active-line)',
			},
			'.cm-activeLineGutter': {
				backgroundColor: 'var(--tms-mde-color-active-line)',
			},
			'.cm-selectionBackground': {
				backgroundColor: 'var(--tms-mde-color-selection-bg)',
			},
			'& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground.cm-selectionBackground': {
				backgroundColor: 'var(--tms-mde-color-selection-bg)',
			},
			'&.cm-focused .cm-selectionBackground': {
				backgroundColor: 'var(--tms-mde-color-selection-bg-focused)',
			},
			'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground.cm-selectionBackground': {
				backgroundColor: 'var(--tms-mde-color-selection-bg-focused)',
			},
			'.cm-content ::selection': {
				backgroundColor: 'var(--tms-mde-color-selection-bg-focused)',
				color          : 'var(--tms-mde-color-text)',
			},
			'.cm-cursor, .cm-dropCursor': {
				borderLeft     : '2px solid var(--tms-mde-color-caret)',
				borderLeftColor: 'var(--tms-mde-color-caret)',
				marginLeft     : '-1px',
			},
		}),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				options.onDocChange(update.view);
			}

			if (update.selectionSet || update.docChanged) {
				options.onSelectionChange(update.view);
			}

			if (update.geometryChanged || update.viewportChanged) {
				update.view.requestMeasure();
			}
		}),
		Prec.high(EditorView.domEventHandlers({
			/**
			 * クリップボード画像貼り付けを C# 側へ委譲する
			 * @param {ClipboardEvent} event 貼り付け
			 * @param {EditorView} view ビュー
			 * @returns {boolean}
			 */
			paste(event, view) {
				if (!options.onPaste) {
					return false;
				}

				if (shouldSkipEditorPasteCapture(event) || view.state.readOnly) {
					return false;
				}

				return options.onPaste(event, view);
			},
		})),
		keymap.of([
			{ key: 'Tab', run: indentListItem, shift: dedentListItem },
			{ key: 'Enter', run: continueListMarkup },
			{ key: options.settings.keybindings.toggleCheckbox.replaceAll('+', '-'), run: toggleCheckboxCommand },
			{ key: 'ArrowUp', run: cursorStableLineUp, shift: selectStableLineUp },
			{ key: 'ArrowDown', run: cursorStableLineDown, shift: selectStableLineDown },
			{ key: 'Ctrl-p', run: cursorStableLineUp, shift: selectStableLineUp, preventDefault: true },
			{ key: 'Ctrl-n', run: cursorStableLineDown, shift: selectStableLineDown, preventDefault: true },
			...markdownKeymap,
			...defaultKeymap,
			...historyKeymap,
		]),
	];

	if (options.settings.showLineNumbers) {
		extensions.push(lineNumbers());
	}

	if (options.settings.showEolMarkers) {
		extensions.push(...createEolMarkerExtensions(options.lineEols ?? []));
	}

	extensions.push(...createLivePreviewExtensions(
		options.viewMode,
		{
			filePath         : options.filePath ?? null,
			loadRemoteImages : options.settings.loadRemoteImages ?? true,
		},
		options.customDecorations ?? [],
	));

	if (options.settings.wordWrap) {
		extensions.push(EditorView.lineWrapping);
	}

	if (options.readOnly) {
		extensions.push(EditorState.readOnly.of(true));
	}

	return extensions;
}

/**
 * EditorView をマウントする
 * @param {HTMLElement} parent 親要素
 * @param {EditorState} state エディタ状態
 * @returns {EditorView} エディタビュー
 */
export function mountEditorView(
	parent: HTMLElement,
	state: EditorState,
	dispatch?: (transaction: Transaction, view: EditorView) => void,
): EditorView {
	return new EditorView({
		state,
		parent,
		dispatch,
	});
}

/**
 * エディタ内容を置き換える
 * @param {EditorView} view エディタビュー
 * @param {string} text 新しいテキスト
 * @returns {void}
 */
export function replaceEditorText(view: EditorView, text: string): void {
	view.dispatch({
		changes: {
			from : 0,
			to   : view.state.doc.length,
			insert: text,
		},
	});
}
