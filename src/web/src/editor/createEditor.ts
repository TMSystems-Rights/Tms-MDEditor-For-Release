/**
 * エディタの Extension を組み立て、EditorState と EditorView を作る
 * 設定と文書の保存は呼び出し側が持ち、本ファイルは渡されたオプションから拡張の並びと初期状態を決める
 * @file
 */
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
import { clampNoteViewOffset } from './noteViewPosition';
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
import { cursorStableDocEnd, selectStableDocEnd } from './documentBoundary';
import { createTripleClickSelectionExtension } from './tripleClickSelection';
import { createLineWrapperExtensions } from './lineWrappers';
import { createTableMaxWidthExtension } from './tableMaxWidth';
import { createTableHeaderPinExtension } from '../livePreview/tableHeaderPin';
import { createOutlineScrollExtension } from '../outline/outline';
import { createSearchExtensions } from '../search/searchPanel';
import { createHeadingFoldExtensions, restoreCollapsedHeadings } from './headingFold';

/**
 * エディタ状態を組み立てるときの入力
 * 文書と設定は呼び出し側が持ち、本ファイルは Extension の組み合わせだけを決める
 */
type CreateEditorOptions = {
	/** 初期本文。空文字の文書も許す */
	text: string;
	/** フォント、タブ幅、検索、行番号などのアプリ設定 */
	settings: AppSettings;
	/** ライブプレビューかソースかの表示モード */
	viewMode: ViewMode;
	/** 開いているノートのパス。未指定時は null としてプレビューへ渡す */
	filePath?: string | null;
	/** 行ごとの改行種別。未指定時は改行マーカーを付けない */
	lineEols?: Array<EolKind | null>;
	/** ユーザー定義の装飾規則。未指定時は空 */
	customDecorations?: CompiledCustomDecorationRule[];
	/** true のとき編集不可。未指定時は編集できる */
	readOnly?: boolean;
	/** 初期選択の anchor と head（文書オフセット）。未指定時は CodeMirror の既定。文書長を超える位置は収める */
	selection?: { anchor: number; head: number };
	/** 復元する折りたたみ見出しの先頭オフセット。未指定時は折りたたまない */
	collapsedHeadingFroms?: readonly number[];
	/** 文書が変わったときに呼ぶ */
	onDocChange: (view: EditorView) => void;
	/** 選択または文書が変わったときに呼ぶ */
	onSelectionChange: (view: EditorView) => void;
	/** 見出しの折りたたみが変わったときに呼ぶ。未指定時は通知しない */
	onFoldChange?: (view: EditorView) => void;
	/** 本文への貼り付けを横取りする。未指定時は既定の貼り付け。true を返すと既定処理を止める */
	onPaste?: (event: ClipboardEvent, view: EditorView) => boolean;
};

/**
 * CM6 の EditorState を生成し、保存済みの見出し折りたたみを戻す
 * @param options - 本文、設定、コールバック。collapsedHeadingFroms が未指定のときは折りたたまない
 * @returns 拡張と初期選択を載せた状態。折りたたみの復元後
 */
export function createEditorState(options: CreateEditorOptions): EditorState {
	const docLength = options.text.length;
	const state     = EditorState.create({
		doc       : options.text,
		selection : options.selection
			? {
				anchor: clampNoteViewOffset(options.selection.anchor, docLength),
				head  : clampNoteViewOffset(options.selection.head, docLength),
			}
			: undefined,
		extensions: createEditorExtensions(options),
	});
	return restoreCollapsedHeadings(state, options.collapsedHeadingFroms ?? []);
}

/**
 * 設定変更後の拡張構成を、既存の EditorState へ反映する
 * 文書本文と選択は維持する
 * @param state - 再構成する状態
 * @param options - 新しい設定を含む生成オプション
 * @returns 拡張だけを差し替えた状態
 */
export function reconfigureEditorState(state: EditorState, options: CreateEditorOptions): EditorState {
	return state.update({
		effects: StateEffect.reconfigure.of(createEditorExtensions(options)),
	}).state;
}

/**
 * ネイティブキャレットを隠し、描画キャレットをテーマ色で前面に出す
 * 選択レイヤーを行背景より前へ出したあと、CM ライトテーマ既定の黒キャレットが漏れないようにする
 * @returns キャレット表示用テーマ。他のテーマより優先する
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
 * 行番号ガターをテーマ変数で固定する
 * CM ライト基テーマの `&light .cm-gutters` が通常テーマより詳細度で勝つため、!important で上書きする
 * @returns ガター表示用テーマ。他のテーマより優先する
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
 * EditorState に組み込む拡張一覧を生成する
 * 行番号、改行マーカー、折返し、読み取り専用は設定が有効なときだけ末尾へ足す
 * @param options - 拡張の材料。コールバックはリスナーと貼り付けハンドラが後から呼ぶ
 * @returns この順で合成する Extension
 */
function createEditorExtensions(options: CreateEditorOptions): Extension[] {
	const extensions: Extension[] = [
		history(),
		drawSelection({ cursorBlinkRate: 0 }),
		createTripleClickSelectionExtension(),
		createCaretVisibilityExtension(),
		createGutterThemeExtension(),
		createCaretBlinkExtension(),
		highlightActiveLine(),
		indentOnInput(),
		...createMarkdownSyntaxHighlighting(),
		createTmsMarkdownSupport({ addKeymap: false }),
		...createHeadingFoldExtensions({ onFoldChange: options.onFoldChange }),
		...createInlineCodeHighlightExtensions(),
		EditorState.tabSize.of(options.settings.tabSize),
		...createLineWrapperExtensions(),
		createTableMaxWidthExtension(),
		createTableHeaderPinExtension(),
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
			 * クリップボード貼り付けを、呼び出し側の onPaste へ委譲する
			 * onPaste が無い、表や検索欄、読み取り専用のときは既定の貼り付けに任せる
			 * @param event - 貼り付けイベント
			 * @param view - 貼り付け先のエディタ
			 * @returns onPaste が処理したとき、その戻り値。任せたときは false
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
			{ key: 'Mod-End', run: cursorStableDocEnd, shift: selectStableDocEnd, preventDefault: true },
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
 * EditorView を親要素へマウントする
 * @param parent - ビューをぶら下げる要素
 * @param state - 表示するエディタ状態
 * @param dispatch - トランザクションの適用先。未指定時は CodeMirror の既定
 * @returns マウントしたビュー
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
 * エディタの全文を、渡したテキストで置き換える
 * 選択の維持は CodeMirror の置換に任せる
 * @param view - 置き換えるエディタ
 * @param text - 新しい全文。空文字なら文書を空にする
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
