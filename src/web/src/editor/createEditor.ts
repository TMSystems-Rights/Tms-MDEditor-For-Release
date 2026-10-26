/**
 * エディタの Extension を組み立て、EditorState と EditorView を作る
 * 設定と文書の保存は呼び出し側が持ち、本ファイルは渡されたオプションから拡張の並びと初期状態を決める
 * @file
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { indentOnInput } from '@codemirror/language';
import { EditorState, Prec, StateEffect, type Extension, type Transaction } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import type { AppSettings, EolKind, ViewMode } from '../types/app';
import { createLivePreviewExtensions, type CompiledCustomDecorationRule } from '../livePreview/livePreviewPlugin';
import { clampNoteViewOffset } from './noteViewPosition';
import { createEolMarkerExtensions } from './eolMarkers';
import { toggleCheckboxCommand } from './checkboxToggle';
import { continueListMarkup } from './listContinuation';
import { dedentListItem, indentListItem } from './listIndent';
import { createInlineCodeHighlightExtensions } from './inlineCodeHighlight';
import { createMarkdownSyntaxHighlighting } from './markdownHighlightStyle';
import { shouldSkipEditorPasteCapture } from './pasteCapture';
import { cursorStableLineDown, cursorStableLineUp, createVerticalMotionExtensions, selectStableLineDown, selectStableLineUp } from './verticalMotion';
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
	// 初期本文の文字数。選択の復元位置を文書内へ収める上限。空文書は 0
	const docLength = options.text.length;
	// 折りたたみを戻す前の状態。選択は文書長を超えない位置へ収めてから作る
	const state     = EditorState.create({
		// 開く本文。空文字の文書もそのまま渡す
		doc: options.text,
		// 復元する選択。未指定なら CodeMirror の既定。指定時は文書長へ収めた anchor と head
		selection: options.selection
			? {
				// 選択の起点（文字）。文書長を超える保存値は末尾へ収める
				anchor: clampNoteViewOffset(options.selection.anchor, docLength),
				// キャレット位置（文字）。文書長を超える保存値は末尾へ収める
				head: clampNoteViewOffset(options.selection.head, docLength)
			}
			: undefined,
		// 行番号やキーマップを含む拡張。設定が有効なものだけ後段で足す
		extensions: createEditorExtensions(options)
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
		effects: StateEffect.reconfigure.of(createEditorExtensions(options))
	}).state;
}

/**
 * ネイティブキャレットを隠し、描画キャレットをテーマ色で前面に出す
 * 選択レイヤーを行背景より前へ出したあと、CM ライトテーマ既定の黒キャレットが漏れないようにする
 * @returns キャレット表示用テーマ。他のテーマより優先する
 */
function createCaretVisibilityExtension(): Extension {
	return Prec.highest(
		EditorView.theme({
			'.cm-content': {
				caretColor: 'transparent !important'
			},
			'.cm-line': {
				caretColor: 'transparent !important'
			},
			'.cm-content :focus': {
				caretColor: 'var(--tms-mde-color-caret) !important'
			},
			'.cm-cursor, .cm-dropCursor': {
				borderLeft: '2px solid var(--tms-mde-color-caret) !important',
				borderLeftColor: 'var(--tms-mde-color-caret) !important'
			}
		})
	);
}

/**
 * 行番号ガターをテーマ変数で固定する
 * CM ライト基テーマの `&light .cm-gutters` が通常テーマより詳細度で勝つため、!important で上書きする
 * @returns ガター表示用テーマ。他のテーマより優先する
 */
function createGutterThemeExtension(): Extension {
	return Prec.highest(
		EditorView.theme({
			'.cm-gutters': {
				backgroundColor: 'var(--tms-mde-color-surface) !important',
				color: 'var(--tms-mde-color-text-muted) !important',
				borderRight: '1px solid var(--tms-mde-color-border) !important'
			},
			'.cm-gutterElement': {
				color: 'var(--tms-mde-color-text-muted) !important'
			},
			'.cm-activeLineGutter': {
				backgroundColor: 'var(--tms-mde-color-active-line) !important'
			}
		})
	);
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
				height: '100%',
				fontSize: `${options.settings.editorFontSize}px`,
				fontFamily: options.settings.editorFontFamily,
				lineHeight: '1.4',
				'--tms-mde-editor-font-size': `${options.settings.editorFontSize}px`
			},
			'.cm-scroller': {
				overflow: 'auto',
				fontFamily: 'inherit',
				lineHeight: '1.4'
			},
			'.cm-content': {
				minHeight: '100%',
				lineHeight: '1.4'
			},
			'.cm-line': {
				lineHeight: '1.4'
			},
			'.cm-gutters': {
				backgroundColor: 'var(--tms-mde-color-surface)',
				color: 'var(--tms-mde-color-text-muted)',
				borderRight: '1px solid var(--tms-mde-color-border)'
			},
			'.cm-activeLine': {
				backgroundColor: 'var(--tms-mde-color-active-line)'
			},
			'.cm-activeLineGutter': {
				backgroundColor: 'var(--tms-mde-color-active-line)'
			},
			'.cm-selectionBackground': {
				backgroundColor: 'var(--tms-mde-color-selection-bg)'
			},
			'& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground.cm-selectionBackground': {
				backgroundColor: 'var(--tms-mde-color-selection-bg)'
			},
			'&.cm-focused .cm-selectionBackground': {
				backgroundColor: 'var(--tms-mde-color-selection-bg-focused)'
			},
			'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground.cm-selectionBackground': {
				backgroundColor: 'var(--tms-mde-color-selection-bg-focused)'
			},
			'.cm-content ::selection': {
				backgroundColor: 'var(--tms-mde-color-selection-bg-focused)',
				color: 'var(--tms-mde-color-text)'
			},
			'.cm-cursor, .cm-dropCursor': {
				borderLeft: '2px solid var(--tms-mde-color-caret)',
				borderLeftColor: 'var(--tms-mde-color-caret)',
				marginLeft: '-1px'
			}
		}),
		// 文書・選択・寸法の変化を外へ通知し、寸法変化では再計測を頼む。どれも無い更新では何もしない
		EditorView.updateListener.of((update) => {
			// 文書が変わったときだけ本文変更を通知する。選択だけの更新では入らない
			if (update.docChanged) {
				options.onDocChange(update.view);
			}

			// 選択セットか文書変更のどちらかがあるとき通知する。両方無い更新では入らない
			if (update.selectionSet || update.docChanged) {
				options.onSelectionChange(update.view);
			}

			// 行の寸法か表示範囲のどちらかが変わったとき再計測する。両方無いときは頼まない
			if (update.geometryChanged || update.viewportChanged) {
				update.view.requestMeasure();
			}
		}),
		Prec.high(
			EditorView.domEventHandlers({
				/**
				 * クリップボード貼り付けを、呼び出し側の onPaste へ委譲する
				 * onPaste が無い、表や検索欄、読み取り専用のときは既定の貼り付けに任せる
				 * @param event - 貼り付けイベント
				 * @param view - 貼り付け先のエディタ
				 * @returns onPaste が処理したとき、その戻り値。任せたときは false
				 */
				paste(event, view) {
					// onPaste が無いときは本文の横取りをせず、既定の貼り付けへ返す
					if (!options.onPaste) {
						return false;
					}

					// 表や検索欄など本文以外か、読み取り専用なら既定へ返す。どちらか一方でも横取りしない
					if (shouldSkipEditorPasteCapture(event) || view.state.readOnly) {
						return false;
					}

					return options.onPaste(event, view);
				}
			})
		),
		// リスト、文書端、チェックボックス、論理行の上下を、この並びの先にある既定キーより前に割り当てる
		keymap.of([
			// リストの段を変える割り当て。Shift の有無で深くするか浅くするかを分ける
			{
				// Tab。リスト行を 1 段深くする
				key: 'Tab',
				// Shift 無しのとき。リスト以外はコマンド側が既定のインデントへ渡す
				run: indentListItem,
				// Shift+Tab。リスト行を 1 段浅くする
				shift: dedentListItem
			},
			// Enter でリストの次項目を続ける割り当て。リストでなければ後続の改行に渡す
			{
				// Enter。リスト行なら次の項目を続ける
				key: 'Enter',
				// リストでなければ false を返し、後続の改行に任せる
				run: continueListMarkup
			},
			// 文書末尾への移動と選択。ブラウザの既定移動は止める
			{
				// Mod+End。文書末尾へ、表示が安定するまで移動する
				key: 'Mod-End',
				// Shift 無し。末尾へキャレットを移す
				run: cursorStableDocEnd,
				// Shift あり。末尾まで選択を広げる
				shift: selectStableDocEnd,
				// ブラウザの既定の末尾移動を止める。止めないと、安定待ちの前に別の移動が入る
				preventDefault: true
			},
			// 設定キーで、キャレット位置のタスクを切り替える割り当て
			{
				// 設定のチェックボックス切替。`+` は CodeMirror の区切り `-` に直す。空文字ならこのキーは一致しない
				key: options.settings.keybindings.toggleCheckbox.replaceAll('+', '-'),
				// キャレット位置のタスクを切り替える
				run: toggleCheckboxCommand
			},
			// 表示上 1 行上への移動と選択。表の中ではセル移動に渡す
			{
				// 上矢印。表示上の 1 行上へ、表の中ならセル移動に渡す
				key: 'ArrowUp',
				// Shift 無し。キャレットを上へ移す
				run: cursorStableLineUp,
				// Shift あり。選択を上へ広げる
				shift: selectStableLineUp
			},
			// 表示上 1 行下への移動と選択。表の中ではセル移動に渡す
			{
				// 下矢印。表示上の 1 行下へ、表の中ならセル移動に渡す
				key: 'ArrowDown',
				// Shift 無し。キャレットを下へ移す
				run: cursorStableLineDown,
				// Shift あり。選択を下へ広げる
				shift: selectStableLineDown
			},
			// Ctrl+P で 1 行上へ移動または選択する割り当て。印刷は止める
			{
				// Ctrl+P。上矢印と同じ論理行移動。ブラウザの印刷とは別
				key: 'Ctrl-p',
				// Shift 無し。キャレットを上へ移す
				run: cursorStableLineUp,
				// Shift あり。選択を上へ広げる
				shift: selectStableLineUp,
				// ブラウザの印刷を止める。止めないと、キャレット移動と印刷が両方走る
				preventDefault: true
			},
			// Ctrl+N で 1 行下へ移動または選択する割り当て。新規ウィンドウは止める
			{
				// Ctrl+N。下矢印と同じ論理行移動。ブラウザの新規ウィンドウとは別
				key: 'Ctrl-n',
				// Shift 無し。キャレットを下へ移す
				run: cursorStableLineDown,
				// Shift あり。選択を下へ広げる
				shift: selectStableLineDown,
				// ブラウザの新規ウィンドウを止める。止めないと、キャレット移動とウィンドウ作成が両方走る
				preventDefault: true
			},
			// Markdown の既定キー。上で割り当てた Enter や Tab には届かない
			...markdownKeymap,
			// 編集の既定キー。未処理の矢印や削除はここ
			...defaultKeymap,
			// 元に戻す、やり直す
			...historyKeymap
		])
	];

	// 行番号を出す設定のときだけガターを足す。切っているときは番号列を作らない
	if (options.settings.showLineNumbers) {
		extensions.push(lineNumbers());
	}

	// 改行種別を表示する設定のときだけマーカー拡張を足す。種別配列が無いときは空として渡す
	if (options.settings.showEolMarkers) {
		extensions.push(...createEolMarkerExtensions(options.lineEols ?? []));
	}

	extensions.push(
		...createLivePreviewExtensions(
			options.viewMode,
			{
				// 開いているノートのパス。未指定は null で、相対画像を解決しない
				filePath: options.filePath ?? null,
				// リモート画像を読むか。設定が無いときは読む
				loadRemoteImages: options.settings.loadRemoteImages ?? true
			},
			options.customDecorations ?? []
		)
	);

	// 折り返す設定のときだけ行折り返しを足す。切っているときは水平スクロールのまま
	if (options.settings.wordWrap) {
		extensions.push(EditorView.lineWrapping);
	}

	// 読み取り専用が指定されたときだけ編集を禁止する。未指定は編集できる
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
export function mountEditorView(parent: HTMLElement, state: EditorState, dispatch?: (transaction: Transaction, view: EditorView) => void): EditorView {
	// 親要素へマウントするビュー。状態と親は必須で、dispatch は未指定なら undefined のまま既定になる
	return new EditorView({
		// 表示する状態。拡張と本文はここに載っている
		state,
		// ビューをぶら下げる親要素
		parent,
		// トランザクションの適用先。未指定のときは undefined で、CodeMirror の既定 dispatch になる
		dispatch
	});
}

/**
 * エディタの全文を、渡したテキストで置き換える
 * 選択の維持は CodeMirror の置換に任せる
 * @param view - 置き換えるエディタ
 * @param text - 新しい全文。空文字なら文書を空にする
 */
export function replaceEditorText(view: EditorView, text: string): void {
	// 全文を一括で置き換える変更。選択の置き場所は CodeMirror の置換に任せる
	view.dispatch({
		// 文書全体を insert で置き換える範囲
		changes: {
			// 置換の開始（文字）。常に文書先頭
			from: 0,
			// 置換の終了（文字）。現在の文書長で、末尾までを対象にする
			to: view.state.doc.length,
			// 置き換える全文。空文字なら空の文書になる
			insert: text
		}
	});
}
