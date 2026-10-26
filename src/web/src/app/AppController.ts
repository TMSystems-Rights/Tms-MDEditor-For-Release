/**
 * ウィンドウ内のタブ、分割、設定、保存をまとめて動かす
 * ファイルの実読み書きは C# ブリッジへ渡し、このクラスは画面とエディタ状態を持つ
 * @file
 */
import { redo, redoDepth, selectAll, undo, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { BRIDGE_EVENT, BRIDGE_METHOD, invokeBridge, onBridgeEvent, postDroppedFiles, writeLog } from '../bridge';
import { createEditorState, mountEditorView, reconfigureEditorState, replaceEditorText } from '../editor/createEditor';
import { buildToggleTaskMarkerTransaction } from '../editor/checkboxToggle';
import { setLineEolsEffect } from '../editor/eolMarkers';
import { compileCustomDecorationRules, type CompiledCustomDecorationRule } from '../livePreview/customDecorations';
import { findMarkdownLinkUrlFromMouseEvent, isSupportedExternalLinkUrl, setDocumentContextEffect, setViewModeEffect } from '../livePreview/livePreviewPlugin';
import { applyTableAlignSnapshot, applyTableMergeSnapshot, applyTableStructureSnapshot, clearActiveTableMenuTarget, snapshotActiveTableMenu, snapshotTableMergeActionFromEvent, snapshotTableStructureActionFromEvent, TABLE_MENU_STATE_CHANGE_EVENT, type TableMergeMenuSnapshot, type TableStructureMenuSnapshot } from '../livePreview/tableWidget';
import type { TableAlignPatch } from '../livePreview/tableMerge';
import { buildTableInsertionChange, createMarkdownTable, type TableStructureAction } from '../livePreview/tableStructure';
import { showActionToast, showToast, type ToastHandle } from './toast';
import type { AppReadyPayload, AppSettings, ConfigGetResponse, CssSnippetsResponse, CustomDecorationRule, DataDirInfo, DetachedTabDropPayload, DetachedTabPayload, EncodingKind, EolKind, PasteForEditorResult, SaveConfigResponse, TabModel, TextFileInfo, UpdateCheckResponse, UpdateDownloadProgress, UpdateReleaseInfo, ViewMode } from '../types/app';
import { dismissContextMenus, showCloseConfirmDialog, showContextMenuAtPoint, showEncodingMenu, showEolConvertMenu, showEolMixedDialog, showErrorMessage, showInsertTableDialog, showReloadEncodingDialog, showSaveAsOptionsDialog, type ContextMenuEntry } from './dialogs';
import { applyCodeFontFamily, DEFAULT_CODE_FONT_FAMILY } from './codeFont';
import { applyImageBorder, DEFAULT_IMAGE_BORDER } from './imageBorder';
import { applyTheme } from './theme';
import { bindUiZoom, computeZoomedFontSize, formatUiZoomPercent, getUiZoom, handleUiZoomKeydown, resetUiZoom } from './uiZoom';
import { buildTabTitle, buildWindowTitle, formatEncodingLabel, formatEolLabel, isLargeFile, normalizeEol } from '../utils/format';
import { createUniformLineEols, reconstructWithLineEols, splitPreservingEol, syncLineEols, toCm6Text } from '../utils/lineEol';
import { isFileDrag } from '../utils/dragDrop';
import { matchesShortcut } from '../utils/keybindings';
import { shouldSkipEditorPasteCapture } from '../editor/pasteCapture';
import { closeOpenSearchPanel, moveToSearchMatch, openFindPanel, openReplacePanel } from '../search/searchPanel';
import { calculateSplitRatio, createSynchronizedTransaction, type SplitDirection } from '../split/splitView';
import { createPaneLayout, findAdjacentPaneId, listPaneIds, removePane, splitPane, updateSplitRatio, type PaneId, type PaneLayoutNode, type PaneSplit } from '../split/paneLayout';
import { applyTabBarWheelScroll, revealElementInHorizontalScroller } from '../split/tabBarScroll';
import { isPointInHorizontalScrollbar, shouldOpenUntitledTabOnTabBarDoubleClick } from '../split/tabBarEmptyClick';
import { calculatePaneDropPlacement, type PaneDropPlacement } from '../split/tabDrop';
import { createDraggableTabElement } from '../split/tabElement';
import { calculateTabDropIndex, shouldCloseWindowAfterTabRemoval } from '../split/tabTransfer';
import { SettingsModal } from '../settings/SettingsModal';
import { applyCssSnippets, getCssSnippetsReloadStatus } from '../settings/cssSnippets';
import { CONTEXT_MENU_ITEM_LABELS, createDefaultContextMenuSettings, isContextMenuSeparator, normalizeContextMenuSettings } from '../settings/contextMenuSettings';
import { createSessionSnapshot, isEmptySessionSnapshot, normalizeSessionSnapshot, prunePaneLayout, SESSION_SCHEMA_VERSION, type SessionSnapshot } from '../session/sessionState';
import { createCaretRedrawSpec } from '../editor/caretRedraw';
import { captureNoteViewPosition, normalizeNoteViewPositionDocument, NoteViewPositionMemory, restoreNoteViewScroll, selectionFromNoteViewPosition, type NoteViewPosition } from '../editor/noteViewPosition';
import { collapseAllHeadings, expandAllHeadings, expandHeadingAt, getCollapsedHeadingFroms, hasCollapsedHeadings, hasFoldableHeadings } from '../editor/headingFold';
import { buildOutlineTree, collectOutlineAncestorFroms, collectFoldableOutlineFroms, collectOutlineItems, computeOutlineListScrollTop, findActiveOutlineItemIndex, jumpToOutlineItem, preserveEditorFocusOnOutlineMouseDown, type OutlineItem, type OutlineTreeNode } from '../outline/outline';
import { calculateOutlineWidth, clampOutlineWidth, DEFAULT_OUTLINE_WIDTH, OUTLINE_KEYBOARD_RESIZE_STEP } from '../outline/outlineResize';
import { renderExportHtml, type ExportImageRequest, type ExportMermaidResult } from '../export/renderExportHtml';
import { rememberExportMedia, type ExportMediaFile } from '../export/exportMedia';
import { renderMermaidSource } from '../livePreview/mermaidWidget';
import { buildTableMenuEnabledState, isTableMenuAction, type TableMenuAction } from './tableMenu';

/**
 * 画面が保持する 1 タブ
 * 保存比較用の `TabModel` に、まだマウントしていないエディタ状態を足す
 */
type TabRuntime = TabModel & {
	/** このタブの CodeMirror 状態。表示中でなくても本文と選択を持つ */
	editorState: EditorState;
};

/**
 * 1 つの分割ペインが持つタブと表示
 * レイアウト木とは別に、ペイン ID から引く
 */
type PaneRuntime = {
	/** レイアウト上のペイン ID */
	paneId: PaneId;
	/** このペインのタブ ID。左から表示する順 */
	tabIds: string[];
	/** 選択中のタブ。タブが無いときは null */
	activeTabId: string | null;
	/** タブ ID から、非表示中も含むエディタ状態 */
	editorStates: Map<string, EditorState>;
	/** タブ ID から表示モード */
	viewModes: Map<string, ViewMode>;
};

/**
 * C# へ保存を頼んだ結果
 * 失敗時もパスと文字コードは、試みた値を返す
 */
type SaveFileResult = {
	/** ディスクへ書けたか */
	success: boolean;
	/** 書いた、または書こうとしたパス */
	filePath: string;
	/** 保存に使った文字コード */
	encoding: EncodingKind;
	/** 保存後の主要な改行 */
	primaryEol: EolKind;
	/** 保存後も改行が混在しているか */
	eolMixed: boolean;
};

/**
 * 設定を読む前に使う初期値
 * 起動後は `mergeSettingsWithDefaults` で欠落を補い、このオブジェクト自体は変えない
 */
const DEFAULT_SETTINGS: AppSettings = {
	theme: 'system',
	editorFontFamily: '"Consolas", "BIZ UDゴシック", monospace',
	codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
	editorFontSize: 15,
	showLineNumbers: true,
	showEolMarkers: true,
	wordWrap: true,
	defaultViewMode: 'live-preview',
	tabSize: 4,
	largeFileThresholdMb: 2,
	loadRemoteImages: true,
	attachmentFolder: '',
	imageBorder: { ...DEFAULT_IMAGE_BORDER },
	newFileEncoding: 'utf8',
	newFileEol: 'crlf',
	restoreSessionOnStartup: false,
	closeAppWhenLastTabClosed: false,
	externalChangeBehavior: 'auto-reload',
	instanceMode: 'single-instance',
	outline: {
		visible: true,
		side: 'right',
		width: DEFAULT_OUTLINE_WIDTH
	},
	export: {
		style: 'live-preview',
		outline: {
			enabled: true,
			side: 'right'
		}
	},
	externalBrowser: {
		mode: 'default',
		customCommand: ''
	},
	update: {
		checkOnStartup: true,
		skippedVersion: '',
		lastCheckedAt: ''
	},
	cssSnippets: {
		enabled: []
	},
	keybindings: {
		newFile: 'Ctrl+N',
		openFile: 'Ctrl+O',
		save: 'Ctrl+S',
		saveAs: 'Ctrl+Shift+S',
		closeTab: 'Ctrl+W',
		nextTab: 'Ctrl+Tab',
		prevTab: 'Ctrl+Shift+Tab',
		find: 'Ctrl+F',
		replace: 'Ctrl+R',
		findNext: 'F3',
		findPrev: 'Shift+F3',
		toggleViewMode: 'Ctrl+E',
		toggleOutline: 'Ctrl+Shift+O',
		splitHorizontal: 'Ctrl+Shift+-',
		splitVertical: 'Ctrl+Shift+\\',
		unsplit: 'Ctrl+Shift+U',
		toggleCheckbox: 'Ctrl+Enter',
		exportHtml: 'Ctrl+Shift+H',
		exportPdf: 'Ctrl+Shift+P',
		print: 'Ctrl+P',
		pastePlain: 'Ctrl+Shift+V'
	},
	search: {
		restoreCalloutFoldStateOnMove: false
	},
	contextMenu: createDefaultContextMenuSettings()
};

/**
 * ウィンドウ 1 つの編集セッション
 * DOM の取得、ブリッジ購読、タブとペインの状態をコンストラクタで始め、破棄はアプリ終了に任せる
 */
export class AppController {
	/** 最初からあるペインの ID。分割をすべて畳んだときもこの ID に戻す */
	private static readonly INITIAL_PANE_ID = 'pane-initial';

	/** 表示位置の保存をまとめる待ち時間。単位はミリ秒。入力のたびにディスクへ書かない */
	private static readonly NOTE_VIEW_POSITION_SAVE_DELAY_MS = 400;

	/** 適用中の画面設定。起動時は既定値で、準備完了後に読み込んだ設定へ置き換わる */
	private settings: AppSettings = DEFAULT_SETTINGS;

	/** エディタへ渡す、コンパイル済みのカスタム装飾。無効なルールは含めない */
	private customDecorationRules: CompiledCustomDecorationRule[] = [];

	/** 設定画面へ返す、保存形式のカスタム装飾。無効なルールも含む */
	private rawCustomDecorations: CustomDecorationRule[] = [];

	/** データディレクトリの場所。未取得のあいだは空文字 */
	private dataDirInfo: DataDirInfo = {
		dataDir: '',
		defaultDataDir: ''
	};

	/** ポータブル起動か。準備完了の通知で更新する */
	private isPortable = false;

	/** 最後に読んだ CSS スニペット。未取得のあいだは空 */
	private cssSnippets: CssSnippetsResponse = {
		directoryPath: '',
		snippets: []
	};

	/** このウィンドウのタブ。ペインをまたいで 1 つの配列に置く */
	private tabs: TabRuntime[] = [];

	/** アクティブペインで選択中のタブ。タブが無いときは null */
	private activeTabId: string | null = null;

	/** アクティブペインのエディタ。ペインが無い描画前は null */
	private editorView: EditorView | null = null;

	/** 次の貼り付けを書式なしにするか。プレーン貼り付けの直前だけ true */
	private suppressSmartPaste = false;

	/** 更新ダウンロード中の通知。表示していなければ null */
	private updateDownloadToast: ToastHandle | null = null;

	/** ペイン ID から、いま DOM に載っているエディタ */
	private readonly editorViews = new Map<PaneId, EditorView>();

	/** フォーカスしているペイン。初期値は分割前の単一ペイン */
	private activePaneId: PaneId = AppController.INITIAL_PANE_ID;

	/** 分割の木。初期値は単一ペイン */
	private paneLayout: PaneLayoutNode = createPaneLayout(AppController.INITIAL_PANE_ID);

	/** ペイン ID から、そのペインのタブ一覧。初期ペインは空で入れておく */
	private readonly panes = new Map<PaneId, PaneRuntime>([
		[
			AppController.INITIAL_PANE_ID,
			{
				paneId: AppController.INITIAL_PANE_ID,
				tabIds: [],
				activeTabId: null,
				editorStates: new Map(),
				viewModes: new Map()
			}
		]
	]);

	/** 分割先へ本文を写している最中か。true のあいだ再帰的な同期はしない */
	private synchronizingSplitTransaction = false;

	/** ドラッグ中のタブ ID。ドラッグ外は null */
	private tabDragSourceId: string | null = null;

	/** ドラッグを始めたペイン。ドラッグ外は null */
	private tabDragSourcePaneId: PaneId | null = null;

	/** このウィンドウがセッションを保存する側か。準備完了まで false */
	private isSessionOwner = false;

	/** 保存済みノートの表示位置。キーはファイルパス */
	private readonly noteViewPositions = new NoteViewPositionMemory();

	/** 未保存タブの表示位置。キーはタブ ID。ファイルが無いあいだだけ使う */
	private readonly untitledNoteViewPositions = new Map<string, NoteViewPosition>();

	/** 表示位置を読んでよいビュー。マウント直後の空計測を避ける */
	private readonly noteViewCaptureReady = new WeakSet<EditorView>();

	/** 表示位置の記録をすでに予約したビュー。二重予約を防ぐ */
	private readonly noteViewRememberScheduled = new WeakSet<EditorView>();

	/** 表示位置保存の待ちタイマー。未予約は null */
	private noteViewSaveTimer: number | null = null;

	/** 表示位置の保存を直列化する Promise。前の保存が終わってから次を送る */
	private noteViewSaveChain: Promise<void> = Promise.resolve();

	/** 最後に保存した表示位置 JSON。同じ内容の再送を省く */
	private lastNoteViewPositionJson = '';

	/** 最後にネイティブメニューへ伝えた表操作の活性 JSON。同じ内容の再送を省く */
	private lastTableMenuStateJson = '';

	/** エディタペインを置くホスト。コンストラクタで取得し、その後は変えない */
	private readonly editorHostElement: HTMLElement;

	/** アウトラインとエディタを含む作業領域。幅の計算に使う */
	private readonly workspaceElement: HTMLElement;

	/** アウトラインの枠 */
	private readonly outlinePanelElement: HTMLElement;

	/** アウトライン幅を変える境界 */
	private readonly outlineResizerElement: HTMLElement;

	/** 見出し一覧を描く要素 */
	private readonly outlineListElement: HTMLElement;

	/** 見出しが無いときに出す案内 */
	private readonly outlineEmptyElement: HTMLElement;

	/** アウトラインを表示しているか。設定適用前は false */
	private outlineVisible = false;

	/** 幅変更中のポインター ID。ドラッグ外は null */
	private outlineResizePointerId: number | null = null;

	/** ドラッグ開始時のアウトライン幅。単位は CSS ピクセル */
	private outlineResizeStartWidth = DEFAULT_OUTLINE_WIDTH;

	/** 直前に描いた見出し。キャレット移動で現在位置を更新する */
	private outlineItems: OutlineItem[] = [];

	/** 折りたたんでいる見出しの文書位置 */
	private outlineCollapsedFroms = new Set<number>();

	/**
	 * ステータスバーの表示要素
	 * コンストラクタで id から取得し、その後は差し替えない
	 */
	private readonly statusElements: {
		/** キャレットの行と列 */
		cursor: HTMLElement;
		/** 文字数 */
		charCount: HTMLElement;
		/** 文字コード。クリックで変更メニューを開く */
		encoding: HTMLElement;
		/** 改行。クリックで変換メニューを開く */
		eol: HTMLElement;
		/** 表示モード。クリックで切り替える */
		viewMode: HTMLElement;
		/** UI ズーム。100% 以外のクリックで戻す */
		zoom: HTMLElement;
		/** 大ファイルであることの表示 */
		largeFile: HTMLElement;
		/** アプリの版 */
		version: HTMLElement;
	};

	// ----------------------------------------------
	// 起動と更新確認
	// ----------------------------------------------

	/**
	 * DOM を取得し、メニュー、ドロップ、ブリッジの購読を始める
	 * ファイルを開くのは準備完了の通知を受けてから
	 */
	public constructor() {
		this.editorHostElement     = document.getElementById('tmsMdeEditorHost') as HTMLElement;
		this.workspaceElement      = document.getElementById('tmsMdeWorkspace') as HTMLElement;
		this.outlinePanelElement   = document.getElementById('tmsMdeOutlinePanel') as HTMLElement;
		this.outlineResizerElement = document.getElementById('tmsMdeOutlineResizer') as HTMLElement;
		this.outlineListElement    = document.getElementById('tmsMdeOutlineList') as HTMLElement;
		this.outlineEmptyElement   = document.getElementById('tmsMdeOutlineEmpty') as HTMLElement;
		// 起動時に一度だけ取るステータスバーの要素。以後は差し替えない
		this.statusElements        = {
			// 選択が変わるたびに「行 n, 列 m」を書く
			cursor: document.getElementById('tmsMdeStatusCursor') as HTMLElement,
			// 本文の文字数を書く
			charCount: document.getElementById('tmsMdeStatusCharCount') as HTMLElement,
			// クリックで、保存に使う文字コードのメニューを開く
			encoding: document.getElementById('tmsMdeStatusEncoding') as HTMLElement,
			// クリックで、文書全体の改行を一種類に揃えるメニューを開く
			eol: document.getElementById('tmsMdeStatusEol') as HTMLElement,
			// クリックでライブプレビューとソースを切り替える。大ファイルは切り替えない
			viewMode: document.getElementById('tmsMdeStatusViewMode') as HTMLElement,
			// 100% 以外のクリックで表示倍率を戻す
			zoom: document.getElementById('tmsMdeStatusZoom') as HTMLElement,
			// 大ファイルのときだけ見せる印
			largeFile: document.getElementById('tmsMdeStatusLargeFile') as HTMLElement,
			// 準備完了の通知で版を書く。届くまで空のまま
			version: document.getElementById('tmsMdeStatusVersion') as HTMLElement
		};

		for (const element of Object.values(this.statusElements)) {
			element.tabIndex = -1;
		}

		// 閉じるボタンでアウトラインを隠し、エディタへフォーカスを戻す
		document.getElementById('tmsMdeOutlineClose')?.addEventListener('click', () => {
			this.setOutlineVisible(false);
			this.editorView?.focus();
		});
		// 展開ボタンを押してもエディタのフォーカスを奪わない
		document.getElementById('tmsMdeOutlineExpandAll')?.addEventListener('mousedown', preserveEditorFocusOnOutlineMouseDown);
		// 展開ボタンで、折りたたんだ見出しをすべて開く
		document.getElementById('tmsMdeOutlineExpandAll')?.addEventListener('click', () => {
			this.expandAllOutline();
		});
		// 折りたたみボタンを押してもエディタのフォーカスを奪わない
		document.getElementById('tmsMdeOutlineCollapseAll')?.addEventListener('mousedown', preserveEditorFocusOnOutlineMouseDown);
		// 折りたたみボタンで、子を持つ見出しをすべて閉じる
		document.getElementById('tmsMdeOutlineCollapseAll')?.addEventListener('click', () => {
			this.collapseAllOutline();
		});
		// 境界を左ボタンで押したとき、幅のドラッグを始める。ドラッグ中の再押下は無視する
		this.outlineResizerElement.addEventListener('pointerdown', (event) => this.startOutlineResize(event));
		// ドラッグ中の移動で、アウトライン幅をポインター位置へ合わせる
		this.outlineResizerElement.addEventListener('pointermove', (event) => this.resizeOutline(event));
		// ボタンを離したら幅を確定し、設定へ保存する
		this.outlineResizerElement.addEventListener('pointerup', (event) => this.finishOutlineResize(event, true));
		// ポインターが取り消されたら、ドラッグ開始時の幅へ戻して保存しない
		this.outlineResizerElement.addEventListener('pointercancel', (event) => this.finishOutlineResize(event, false));
		// 左右キーでアウトライン幅を一段ずつ変える。それ以外のキーは無視する
		this.outlineResizerElement.addEventListener('keydown', (event) => this.resizeOutlineWithKeyboard(event));

		// 文字コード表示のクリックで、保存に使う文字コードを選ばせる
		this.statusElements.encoding.addEventListener('click', () => {
			this.handleEncodingMenuClick();
		});

		// 改行表示のクリックで、文書全体の改行を一種類に揃える
		this.statusElements.eol.addEventListener('click', () => {
			this.handleEolMenuClick();
		});

		// 表示モードのクリックで、ライブプレビューとソースを切り替える
		this.statusElements.viewMode.addEventListener('click', () => {
			this.toggleActiveTabViewMode();
		});

		// エディタ面を右クリックしたときだけ、そのペインをアクティブにして編集メニューを開く。面の外はブラウザのメニューのまま
		this.editorHostElement.addEventListener('contextmenu', (event) => {
			// 右クリック位置の編集面。タブバーや分割境界の上では null
			const surface = (event.target as HTMLElement | null)?.closest<HTMLElement>('.tms-mde-pane-editor-surface');
			// 編集面の外はブラウザのメニューに任せる
			if (!surface) {
				return;
			}

			event.preventDefault();
			// 編集面を含むペイン。構造が壊れていれば null
			const pane   = surface.closest<HTMLElement>('.tms-mde-editor-pane');
			// ペイン ID。data 属性が無いときは undefined
			const paneId = pane?.dataset.paneId as PaneId | undefined;
			// ID が取れたときだけそのペインを前面にする。取れないときはメニューだけ開く
			if (paneId) {
				this.activatePane(paneId);
			}
			this.showEditorContextMenu(event);
		});

		// 表ウィジェットの対象が変わったとき、ネイティブの表メニューの活性を合わせる
		this.editorHostElement.addEventListener(TABLE_MENU_STATE_CHANGE_EVENT, () => {
			this.syncNativeTableMenuState();
		});
		// 表の外を押したとき、表メニューの対象を消す。表の中は選択を維持する
		this.editorHostElement.addEventListener(
			'mousedown',
			(event) => {
				// 押した要素。テキストノードのときは null
				const target = event.target as HTMLElement | null;
				// 表の中を押したときは対象を残す
				if (target?.closest('.cm-md-table-wrap')) return;
				// 押した位置のペイン ID。ペインの外は undefined
				const paneId = target?.closest<HTMLElement>('.tms-mde-editor-pane')?.dataset.paneId as PaneId | undefined;
				// そのペインのエディタ。ペイン外か未マウントのときは null
				const view   = paneId ? this.editorViews.get(paneId) : null;
				// マウント済みのエディタがあるときだけ、表メニューの対象を外す
				if (view) clearActiveTableMenuTarget(view);
			},
			true
		);

		// 100% 以外のクリックで表示倍率を既定へ戻す。100% のクリックは何もしない
		this.statusElements.zoom.addEventListener('click', () => {
			// 既に 100% なら戻す操作は不要
			if (getUiZoom() === 1) {
				return;
			}

			resetUiZoom();
		});

		// 倍率を変えるたびに、ステータス表示とエディタの文字サイズを合わせる
		bindUiZoom((zoom) => {
			this.updateUiZoomStatus(zoom);
			this.applyEditorZoom();
		});

		// Escape で開いているメニューを閉じ、続けてショートカットを判定する
		window.addEventListener(
			'keydown',
			(event) => {
				// Escape は Web 側のメニューを閉じる。ショートカット判定は続ける
				if (event.key === 'Escape') {
					this.dismissAllMenus();
				}

				void this.handleGlobalKeydown(event);
			},
			true
		);

		// ファイルのドラッグ中だけ、ドロップを受け付けるカーソルにする。ファイル以外はブラウザに任せる
		window.addEventListener(
			'dragover',
			(event) => {
				// ファイルでなければ、ブラウザのドラッグのままにする
				if (!isFileDrag(event.dataTransfer)) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				// dataTransfer が無いドラッグでは、コピー効果を書けない
				if (event.dataTransfer) {
					event.dataTransfer.dropEffect = 'copy';
				}
			},
			true
		);

		// ファイルをドロップしたとき、メニューを閉じてそのファイルを開く。ファイル以外はブラウザに任せる
		window.addEventListener(
			'drop',
			(event) => {
				// ファイルでなければ開かない
				if (!isFileDrag(event.dataTransfer)) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				this.dismissAllMenus();

				// ドロップされたファイル一覧。dataTransfer が無いときは undefined
				const files = event.dataTransfer?.files;
				// ファイルが 1 件も無いドロップは無視する
				if (!files || files.length === 0) {
					return;
				}

				// WebView2 では File.path が取れないため、C# 側へ AdditionalObjects として渡す
				postDroppedFiles(files);
			},
			true
		);

		// メニューの外を押したとき、開いているメニューを閉じる。メニュー内は項目選択のため残す
		document.addEventListener(
			'mousedown',
			(event) => {
				// 押した要素。テキストノードのときは null
				const target = event.target as HTMLElement | null;
				// メニュー上の押下は、項目を選ぶ操作なので閉じない
				if (target?.closest('.tms-mde-context-menu')) {
					return;
				}

				this.dismissAllMenus();
			},
			true
		);

		// エディタへフォーカスが移ったら、開いているメニューを閉じる
		this.editorHostElement.addEventListener('focusin', () => {
			this.dismissAllMenus();
		});

		// シェルの準備完了で、版・設定・セッション・起動ファイルを画面へ載せる
		onBridgeEvent(BRIDGE_EVENT.appReady, (payload) => {
			void this.handleAppReady(payload as AppReadyPayload);
		});

		// シェルが渡したパスを順に開く。一覧が空なら何も開かない
		onBridgeEvent(BRIDGE_EVENT.appOpenFiles, (payload) => {
			// 開くパス。通知に files が無いときは空で、1 件も開かない
			const files = (payload as { files?: string[] }).files ?? [];
			void this.openFilePaths(files);
		});

		// 終了確認を始め、未保存のタブがあれば保存か破棄を尋ねる
		onBridgeEvent(BRIDGE_EVENT.appQueryClose, () => {
			void this.handleQueryClose();
		});

		// シェルの都合で、Web 側のコンテキストメニューだけ閉じる
		onBridgeEvent(BRIDGE_EVENT.uiDismissContextMenus, () => {
			dismissContextMenus();
		});

		// メニューの新規から、空のタブを作る
		onBridgeEvent(BRIDGE_EVENT.menuNewFile, () => {
			void this.createNewTab();
		});

		// メニューの開くから、ファイル選択ダイアログを出す
		onBridgeEvent(BRIDGE_EVENT.menuOpenFile, () => {
			void this.openFileDialog();
		});

		// メニューの保存で、アクティブタブをディスクへ書く
		onBridgeEvent(BRIDGE_EVENT.menuSave, () => {
			void this.saveActiveTab();
		});

		// メニューの名前を付けて保存を始める
		onBridgeEvent(BRIDGE_EVENT.menuSaveAs, () => {
			void this.saveAsActiveTab();
		});

		// メニューから、アクティブタブを HTML ファイルへ書き出す
		onBridgeEvent(BRIDGE_EVENT.menuExportHtml, () => {
			void this.exportActiveTab('html');
		});

		// メニューから、アクティブタブを PDF へ書き出す
		onBridgeEvent(BRIDGE_EVENT.menuExportPdf, () => {
			void this.exportActiveTab('pdf');
		});

		// メニューから、アクティブタブの印刷 UI を出す
		onBridgeEvent(BRIDGE_EVENT.menuPrint, () => {
			void this.printActiveTab();
		});

		// ネイティブの表メニューから、右クリックと同じ表操作を実行する
		onBridgeEvent(BRIDGE_EVENT.menuTableAction, (payload) => {
			// メニューが渡した操作名。未設定なら undefined で、下で無視する
			const action = (payload as { action?: unknown }).action;
			// 知っている表操作のときだけ実行する。未知の名前は無視する
			if (isTableMenuAction(action)) void this.handleNativeTableMenuAction(action);
		});

		// メニューから、ライブプレビューとソースを切り替える
		onBridgeEvent(BRIDGE_EVENT.menuToggleViewMode, () => {
			this.toggleActiveTabViewMode();
		});

		// メニューから、アウトラインの表示を切り替える
		onBridgeEvent(BRIDGE_EVENT.menuToggleOutline, () => {
			this.toggleOutline();
		});

		// メニューから、折りたためる見出しをすべて閉じる。エディタが無いときは何もしない
		onBridgeEvent(BRIDGE_EVENT.menuCollapseAllHeadings, () => {
			// マウント済みのエディタがあるときだけ折りたたむ
			if (this.editorView) collapseAllHeadings(this.editorView);
		});

		// メニューから、閉じた見出しをすべて開く。エディタが無いときは何もしない
		onBridgeEvent(BRIDGE_EVENT.menuExpandAllHeadings, () => {
			// マウント済みのエディタがあるときだけ展開する
			if (this.editorView) expandAllHeadings(this.editorView);
		});

		// ディスク上の変更・削除・リネームを、開いているタブへ知らせる
		onBridgeEvent(BRIDGE_EVENT.appExternalFileChanged, (payload) => {
			// 外部変更の通知。パスが無いものは無視し、種別が無いときは内容変更として扱う
			const externalChange = payload as { filePath?: string; kind?: 'changed' | 'deleted' | 'renamed' };
			// パスがあるときだけタブへ反映する
			if (externalChange.filePath) void this.handleExternalFileChanged(externalChange.filePath, externalChange.kind ?? 'changed');
		});
		// メニューから、指定した文字コードでアクティブファイルを読み直す
		onBridgeEvent(BRIDGE_EVENT.menuReloadWithEncoding, () => {
			void this.reloadActiveFileWithEncoding();
		});

		// メニューから、アクティブな表示を上下に分割する
		onBridgeEvent(BRIDGE_EVENT.menuSplitHorizontal, () => {
			this.splitActiveView('horizontal');
		});

		// メニューから、アクティブな表示を左右に分割する
		onBridgeEvent(BRIDGE_EVENT.menuSplitVertical, () => {
			this.splitActiveView('vertical');
		});

		// メニューから、アクティブペインの分割を畳む
		onBridgeEvent(BRIDGE_EVENT.menuUnsplit, () => {
			this.unsplitActiveView();
		});

		// メニューから、検索パネルを開く
		onBridgeEvent(BRIDGE_EVENT.menuFind, () => {
			this.openActiveSearchPanel('find');
		});

		// メニューから、置換パネルを開く
		onBridgeEvent(BRIDGE_EVENT.menuReplace, () => {
			this.openActiveSearchPanel('replace');
		});

		// メニューから、次の検索一致へ移る。エディタが無いときは何もしない
		onBridgeEvent(BRIDGE_EVENT.menuFindNext, () => {
			// 検索できるエディタがあるときだけ次の一致へ移る
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'next');
			}
		});

		// メニューから、前の検索一致へ移る。エディタが無いときは何もしない
		onBridgeEvent(BRIDGE_EVENT.menuFindPrevious, () => {
			// 検索できるエディタがあるときだけ前の一致へ移る
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'previous');
			}
		});

		// メニューから、設定画面を開く
		onBridgeEvent(BRIDGE_EVENT.menuOpenSettings, () => {
			void this.openSettings();
		});

		// メニューから CSS スニペットを読み直し、完了を通知する
		onBridgeEvent(BRIDGE_EVENT.menuReloadCssSnippets, () => {
			void this.refreshCssSnippets(true);
		});

		// メニューから、スニペットフォルダをエクスプローラーで開く
		onBridgeEvent(BRIDGE_EVENT.menuOpenSnippetsFolder, () => {
			void this.openSnippetsFolder();
		});

		// 別ウィンドウから落とされたタブを、ドロップ位置のペインへ入れる
		onBridgeEvent(BRIDGE_EVENT.appReceiveDetachedTab, (payload) => {
			this.receiveDetachedTab(payload as DetachedTabDropPayload);
		});

		// メニューから、更新があるかを今すぐ確認する
		onBridgeEvent(BRIDGE_EVENT.menuCheckForUpdates, () => {
			void this.checkForUpdates();
		});

		// 起動時チェックで新しい版が見つかったとき、操作付きの通知を出す
		onBridgeEvent(BRIDGE_EVENT.updateAvailable, (payload) => {
			// 検出したリリースと配布形態。release が無い通知は出さない
			const typed = payload as { release?: UpdateReleaseInfo; mode?: 'installer' | 'portable' };
			// リリース詳細があるときだけ通知する。mode が無いときはインストーラ向けの案内になる
			if (typed.release) this.showUpdateAvailableToast(typed.release, typed.mode);
		});

		// ダウンロードの進捗を Toast の文面へ出す。まだ無ければキャンセル付きで作る
		onBridgeEvent(BRIDGE_EVENT.updateDownloadProgress, (payload) => {
			// 受信バイトの進捗。percent の単位は百分率
			const progress = payload as UpdateDownloadProgress;
			// Toast に出す進捗文。percent は 0 から 100
			const message  = `更新をダウンロード中です: ${progress.percent}%`;
			// 進捗 Toast がまだ無いときだけ、キャンセル付きで新しく出す
			if (!this.updateDownloadToast) {
				this.updateDownloadToast = showActionToast(message, [
					{
						// 取得を中断する操作
						label: 'キャンセル',
						/** ネイティブ側で共有しているダウンロード用キャンセルトークンを停止する */
						onClick: () => void invokeBridge(BRIDGE_METHOD.updateCancelDownload)
					}
				]);
			} else {
				this.updateDownloadToast.updateMessage(message);
			}
		});

		// ダウンロード完了で進捗を閉じ、今すぐ更新するか後にするかを選ばせる
		onBridgeEvent(BRIDGE_EVENT.updateDownloadCompleted, (payload) => {
			this.dismissUpdateDownloadToast();
			// 入れた版の番号。通知に無いときは空文字で、文面の版だけが空になる
			const version = (payload as { version?: string }).version ?? '';
			showActionToast(`バージョン ${version} の更新をダウンロードしました。`, [
				// 検証済みインストーラーで更新を始める操作。onClick は閉じたあと起動する
				{
					label: '今すぐ更新' /** アプリを閉じた後に検証済みインストーラーを起動する */,
					// 閉じたあと、検証済みインストーラーを起動する
					/**
					 *
					 */
					onClick: () => void invokeBridge(BRIDGE_METHOD.updateApplyNow)
				},
				// 今回はインストールしない操作。onClick は通知だけ閉じる
				{
					label: '後で' /** インストーラーを起動せず通知だけ閉じる */,
					// インストーラーは起動せず、通知だけ閉じる
					/**
					 *
					 */
					onClick: () => undefined
				}
			]);
		});

		// 更新の失敗で進捗を閉じ、理由を Toast に出す。理由が無いときは固定文
		onBridgeEvent(BRIDGE_EVENT.updateError, (payload) => {
			this.dismissUpdateDownloadToast();
			showToast((payload as { message?: string }).message ?? '更新処理に失敗しました。');
		});
	}

	/**
	 * 手動で更新を確認する
	 */
	private async checkForUpdates(): Promise<void> {
		try {
			// 更新確認の応答。release は新しい版があるときだけ入る
			const result = await invokeBridge<UpdateCheckResponse>(BRIDGE_METHOD.updateCheck);
			// 新しい版があり、かつリリース詳細があるときだけ操作付き通知にする。どちらか一方が欠けても通常の Toast にする
			if (result.status === 'available' && result.release) {
				this.showUpdateAvailableToast(result.release, result.mode);
				return;
			}
			showToast(result.status === 'not-available' ? '現在のバージョンは最新です。' : (result.message ?? '更新を確認できませんでした。'));
		} catch (error) {
			showToast(`更新を確認できませんでした: ${this.formatError(error)}`);
		}
	}

	/**
	 * 更新検出を操作付き Toast で通知する
	 * @param release - 更新情報
	 * @param mode - 配布形態
	 */
	private showUpdateAvailableToast(release: UpdateReleaseInfo, mode?: 'installer' | 'portable'): void {
		// ポータブル配布か、このウィンドウがポータブル起動なら、自動更新ではなく公式ページへ案内する
		if (mode === 'portable' || this.isPortable) {
			showActionToast(`新しいバージョン v${release.version} があります。公式ページからポータブル ZIP 版をダウンロードしてください。`, [
				// 手動取得へ案内する操作
				{
					// ボタンに出す文言
					label: '公式ダウンロードページを開く',
					/** ポータブル版は自動更新できないため、手動取得先へ案内する */
					onClick: () => void invokeBridge(BRIDGE_METHOD.updateOpenOfficialPage)
				},
				// 今回の通知だけ閉じる操作。次回の確認は残す
				{
					label: '後で' /** 今回の通知だけを閉じ、次回以降の確認は維持する */,
					// 今回の通知だけを閉じ、次回の確認は残す
					/**
					 *
					 */
					onClick: () => undefined
				},
				// 同じリリースを以後の起動時チェックから外す操作
				{
					// ボタンに出す文言
					label: 'このバージョンをスキップ',
					/** 同じリリースを次回の起動時チェックで再通知しない */
					onClick: () => void invokeBridge(BRIDGE_METHOD.updateSkipVersion, { version: release.version })
				}
			]);
			return;
		}

		showActionToast(`新しいバージョン v${release.version} があります。`, [
			// 進捗通知付きで取得を始める操作
			{
				label: 'ダウンロード' /** UIを塞がず、進捗通知付きで取得を開始する */,
				// 進捗通知付きで取得を始める
				/**
				 *
				 */
				onClick: () => void this.downloadUpdate()
			},
			// 同じリリースを以後の自動確認から外す操作
			{
				label: 'このバージョンをスキップ' /** 同じリリースを以後の自動確認から除外する */,
				// 同じリリースを以後の自動確認から外す
				/**
				 *
				 */
				onClick: () => void invokeBridge(BRIDGE_METHOD.updateSkipVersion, { version: release.version })
			}
		]);
	}

	/**
	 * 検出済み更新をダウンロードする
	 */
	private async downloadUpdate(): Promise<void> {
		try {
			// ダウンロードの完了状態。cancelled は利用者が止めたとき true
			const result = await invokeBridge<{ success: boolean; cancelled: boolean; message?: string }>(BRIDGE_METHOD.updateDownload);
			// 利用者が止めたときは進捗を閉じて中止を知らせる
			if (result.cancelled) {
				this.dismissUpdateDownloadToast();
				showToast(result.message ?? '更新のダウンロードをキャンセルしました。');
				return;
			}
			// 失敗し、中止でもなく、理由があるときだけその文を出す。どれか一つが欠けても出さない
			if (!result.success && !result.cancelled && result.message) showToast(result.message);
		} catch (error) {
			this.dismissUpdateDownloadToast();
			showToast(`更新のダウンロードに失敗しました: ${this.formatError(error)}`);
		}
	}

	/**
	 * 更新ダウンロード中 Toast を閉じる
	 */
	private dismissUpdateDownloadToast(): void {
		this.updateDownloadToast?.dismiss();
		this.updateDownloadToast = null;
	}

	/**
	 * アプリ起動イベントを処理する
	 * @param payload - 起動情報
	 */
	private async handleAppReady(payload: AppReadyPayload): Promise<void> {
		this.statusElements.version.textContent = `v${payload.version ?? 'unknown'}`;
		this.isSessionOwner                     = payload.isSessionOwner === true;
		this.isPortable                         = payload.isPortable === true || payload.config?.isPortable === true;

		// 保存済み設定があるときだけ既定値で穴を埋めて差し替える
		if (payload.config?.settings) {
			this.settings = this.mergeSettingsWithDefaults(payload.config.settings);
		}

		this.setOutlineVisible(this.settings.outline.visible);
		this.applyOutlineLayout();

		// データディレクトリの場所。未設定の項目は空文字
		this.dataDirInfo = {
			// 実際に使っている場所。未設定は空文字
			dataDir: payload.config?.dataDir ?? '',
			// インストール既定の場所。未設定は空文字
			defaultDataDir: payload.config?.defaultDataDir ?? ''
		};

		// コンパイル結果。無効なルール名は rules に含めない
		const compiled             = compileCustomDecorationRules(payload.config?.customDecorations);
		this.rawCustomDecorations  = payload.config?.customDecorations ?? [];
		this.customDecorationRules = compiled.rules;
		// 無効な装飾が 1 件でもあるとき、名前を通知する
		if (compiled.invalidNames.length > 0) {
			// 無効にしたルール名。通知文に並べる
			const names = compiled.invalidNames.join(', ');
			showToast(`カスタム装飾ルールを無効化しました: ${names}`);
		}

		applyTheme(payload.config?.theme ?? this.settings.theme);
		applyCodeFontFamily(this.settings.codeFontFamily);
		applyImageBorder(this.settings.imageBorder);
		this.loadNoteViewPositions(payload.noteViewPositions);
		await this.refreshCssSnippets(false);

		// 設定の読み込みに警告があるときだけ出す
		if (payload.config?.loadMessage) {
			showToast(payload.config.loadMessage);
		}
		// セッションの読み込みに警告があるときだけ出す
		if (payload.sessionLoadMessage) {
			showToast(payload.sessionLoadMessage);
		}

		// 起動時に開くパス。無ければ空で、後続では何も開かない
		const startupFiles = payload.files ?? [];
		// 別ウィンドウ用の起動なら、そのタブだけ開いてセッションは復元しない
		if (payload.detachedTab) {
			this.openDetachedTab(payload.detachedTab);
			await writeLog('INFO', 'Detached tab window initialized.');
			return;
		}

		// セッションからタブを開けたか。開く前と、復元しないときは false
		let restored = false;
		// 保存する側のウィンドウであり、かつ前回のセッションがあるときだけ復元する。どちらか一方が欠けても新規起動のまま
		if (this.isSessionOwner && payload.session) {
			restored = await this.restoreSession(payload.session);
			// 復元に失敗し、かつ空ではないセッションだったときだけ失敗を通知する。どちらか一方が欠けても出さない
			if (!restored && !isEmptySessionSnapshot(payload.session)) showToast('前回のセッションを復元できなかったため、新しいタブで起動します。');
		}
		// 起動引数にファイルがあるとき、復元のあとにそれらのタブを開く
		if (startupFiles.length > 0) {
			await this.openFilePaths(startupFiles);
		}

		// 復元できておらず、かつタブが 1 つも無いときだけ空タブを作る。どちらか一方が欠けても作らない
		if (!restored && this.tabs.length === 0) await this.createNewTab();
		await writeLog('INFO', 'Editor shell initialized.');
	}

	/**
	 * 別ウィンドウから引き渡されたタブ状態を復元する
	 * @param payload - 別ウィンドウから渡されたタブの本文と表示状態
	 */
	private openDetachedTab(payload: DetachedTabPayload): void {
		// 別ウィンドウから渡された状態のタブ。未保存なら filePath は null
		const tab = this.createDetachedTabRuntime(payload);
		this.tabs.push(tab);
		this.addTabToPane(tab, this.activePaneId);
		this.activateTab(tab.tabId, this.activePaneId);
	}

	/**
	 * 引き渡しペイロードからタブ実行状態を生成する
	 * @param payload - 復元するタブの本文、パス、表示モード
	 * @returns 実行中のタブ。文書は渡された本文で作る
	 */
	private createDetachedTabRuntime(payload: DetachedTabPayload): TabRuntime {
		// 渡された本文と表示状態から作るタブ。未保存なら filePath は null
		const tab     = this.createTabRuntime({
			// 保存先。未保存は null
			filePath: payload.filePath,
			// エディタへ載せる本文。改行は LF
			text: payload.text,
			// 保存に使う文字コード
			encoding: payload.encoding,
			// 主要な改行
			eol: payload.eol,
			// 行ごとに改行が混ざっているか
			eolMixed: payload.eolMixed,
			// 閾値を超えるファイルか
			largeFile: payload.largeFile,
			// このタブの表示モード
			viewMode: payload.viewMode,
			// 行ごとの改行。引き渡されたマップをそのまま使う
			lineEols: payload.lineEols
		});
		tab.title     = payload.title;
		tab.savedText = payload.savedText;
		tab.dirty     = payload.dirty;
		return tab;
	}

	/**
	 * 既存ウィンドウへ渡されたタブをドロップ位置へ配置する
	 * @param payload - ドロップ先の画面座標と、移すタブの状態
	 */
	private receiveDetachedTab(payload: DetachedTabDropPayload): void {
		// 落としたタブ。未保存なら filePath は null
		const tab         = this.createDetachedTabRuntime(payload.tab);
		// ドロップ座標の要素。画面外なら null
		const target      = document.elementFromPoint(payload.clientX, payload.clientY);
		// HTML 要素でないときは null。テキストノードはタブバー判定に使わない
		const element     = target instanceof HTMLElement ? target : null;
		// 座標がタブバー上ならその要素。外なら null
		const tabBar      = element?.closest<HTMLElement>('.tms-mde-pane-tab-bar');
		// 座標を含むペイン。ペイン外なら null
		const paneElement = element?.closest<HTMLElement>('.tms-mde-editor-pane');
		// 挿入先のペイン ID。タブバーもペインも無ければ undefined
		const paneId      = (tabBar?.dataset.paneId ?? paneElement?.dataset.paneId) as PaneId | undefined;

		this.tabs.push(tab);
		// 知っているペインならそこへ、無ければアクティブペインへ入れる
		const targetPaneId = paneId && this.panes.has(paneId) ? paneId : this.activePaneId;
		// タブバー上ならマウス位置の挿入位置。バーが無いときは末尾。単位はタブの件数
		const targetIndex  = tabBar ? this.calculateTabBarDropIndex(tabBar, payload.clientX) : (this.panes.get(targetPaneId)?.tabIds.length ?? 0);
		this.addTabToPane(tab, targetPaneId);
		// 挿入先ペイン。直前に選んだ ID が無いときは undefined
		const pane = this.panes.get(targetPaneId);
		// ペインがあるときだけ、末尾に足したタブをドロップ位置へ移す
		if (pane) {
			pane.tabIds = pane.tabIds.filter((tabId) => tabId !== tab.tabId);
			pane.tabIds.splice(Math.min(targetIndex, pane.tabIds.length), 0, tab.tabId);
		}
		this.activateTab(tab.tabId, targetPaneId);
	}

	// ----------------------------------------------
	// 設定と外観
	// ----------------------------------------------

	/**
	 * 設定モーダルを開く
	 */
	private async openSettings(): Promise<void> {
		// 設定画面が既に開いているときは、二重に出さない
		if (document.querySelector('.tms-mde-settings-backdrop')) {
			return;
		}

		try {
			// ディスク上の設定一式。失敗したときは下の catch でダイアログにする
			const config     = await invokeBridge<ConfigGetResponse>(BRIDGE_METHOD.configGet);
			this.dataDirInfo = config.dataDirInfo;
			this.isPortable  = config.isPortable === true || config.dataDirInfo.isPortable === true;
			this.cssSnippets = await invokeBridge<CssSnippetsResponse>(BRIDGE_METHOD.cssSnippetsList);
			// 設定画面へ渡す現在値と、保存直後の反映先
			const modal      = new SettingsModal({
				// 保存済みの画面設定
				settings: config.config.settings,
				// 無効なルールも含む装飾。画面側で編集する
				customDecorations: config.config.customDecorations,
				// データディレクトリの場所
				dataDirInfo: config.dataDirInfo,
				// ポータブル起動か
				isPortable: this.isPortable,
				// 読み込んだ CSS スニペット。未取得のままなら空
				cssSnippets: this.cssSnippets,
				// 添付フォルダの既定。未設定は空文字
				defaultAttachmentFolder: config.defaultAttachmentFolder ?? '',
				/** 保存済み設定を実行中のテーマ・エディタ構成へ即時反映する */
				onSettingsApplied: (settings) => this.applySettings(settings),
				/** 正規表現ルールを再コンパイルし、開いている全ペインへ配布する */
				onCustomDecorationsApplied: (rules) => this.applyCustomDecorations(rules),
				/** CSS差し替え後に計測を要求し、装飾による高さ変更を再計算させる */
				onCssSnippetsApplied: (response) => {
					this.cssSnippets = response;
					applyCssSnippets(response);
					this.requestEditorMeasure();
				}
			});
			modal.open();
		} catch (error) {
			showErrorMessage(this.formatError(error));
		}
	}

	/**
	 * 保存済み設定を既存タブ・全ペインへ反映する
	 * @param settings - 保存済み設定
	 */
	private applySettings(settings: AppSettings): void {
		this.persistActiveEditorState();

		this.settings = this.mergeSettingsWithDefaults(settings);
		applyTheme(this.settings.theme);
		applyCodeFontFamily(this.settings.codeFontFamily);
		applyImageBorder(this.settings.imageBorder);

		this.tabs.forEach((tab) => {
			tab.editorState = this.reconfigurePaneEditorState(tab, tab.editorState, tab.viewMode);
			this.panes.forEach((pane) => {
				// そのペインが持つ、このタブの状態。ペインに無ければ undefined
				const state = pane.editorStates.get(tab.tabId);
				// ペインに状態があるときだけ、新しい設定で組み直す
				if (state) pane.editorStates.set(tab.tabId, this.reconfigurePaneEditorState(tab, state, pane.viewModes.get(tab.tabId) ?? tab.viewMode));
			});
		});

		// 表示中のタブがあるときだけ、エディタをマウントし直す
		if (this.getActiveTab()) {
			this.mountActiveEditor();
		}

		this.applyOutlineLayout();
		this.refreshStatusBar();
	}

	/**
	 * アウトラインパネルの左右配置と幅を設定へ反映する
	 */
	private applyOutlineLayout(): void {
		// 作業領域が無い描画前は、左右と幅を当てられない
		if (!this.workspaceElement) {
			return;
		}

		this.workspaceElement.classList.toggle('is-outline-left', this.settings.outline?.side === 'left');
		this.applyOutlineWidth(this.settings.outline.width);
	}

	/**
	 * アウトライン境界のドラッグを開始する
	 * @param event - ポインターイベント
	 */
	private startOutlineResize(event: PointerEvent): void {
		// 左ボタンであり、かつドラッグ中でないときだけ始める。どちらか一方が欠けても始めない
		if (event.button !== 0 || this.outlineResizePointerId !== null) return;

		event.preventDefault();
		this.outlineResizePointerId  = event.pointerId;
		this.outlineResizeStartWidth = this.outlinePanelElement.getBoundingClientRect().width;
		this.outlineResizerElement.setPointerCapture(event.pointerId);
		document.body.classList.add('is-outline-resizing');
	}

	/**
	 * ドラッグ位置をアウトライン幅へ反映する
	 * @param event - ポインターイベント
	 */
	private resizeOutline(event: PointerEvent): void {
		// 開始したポインター以外の移動では幅を変えない
		if (event.pointerId !== this.outlineResizePointerId) return;

		// 作業領域の矩形。幅の割合を出す基準
		const rect  = this.workspaceElement.getBoundingClientRect();
		// ポインター位置から求めた幅。単位は CSS ピクセル
		const width = calculateOutlineWidth(event.clientX, rect.left, rect.width, this.settings.outline.side);
		this.applyOutlineWidth(width);
	}

	/**
	 * アウトライン境界のドラッグを終了する
	 * @param event - ポインターイベント
	 * @param save - 最終幅を保存するか
	 */
	private finishOutlineResize(event: PointerEvent, save: boolean): void {
		// 開始したポインター以外の終了では、ドラッグを片付けない
		if (event.pointerId !== this.outlineResizePointerId) return;

		// キャプチャを持っているときだけ解放する。未取得の終了では何もしない
		if (this.outlineResizerElement.hasPointerCapture(event.pointerId)) {
			this.outlineResizerElement.releasePointerCapture(event.pointerId);
		}
		this.outlineResizePointerId = null;
		document.body.classList.remove('is-outline-resizing');

		// キャンセル終了のときは、ドラッグ開始時の幅へ戻して保存しない
		if (!save) {
			this.applyOutlineWidth(this.outlineResizeStartWidth);
			return;
		}

		void this.persistOutlineWidth(this.outlinePanelElement.getBoundingClientRect().width);
	}

	/**
	 * キーボードでアウトライン幅を調整する
	 * @param event - キーボードイベント
	 */
	private resizeOutlineWithKeyboard(event: KeyboardEvent): void {
		// 左右以外のキーでは幅を変えない
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

		event.preventDefault();
		// 右が正。左は負。単位は方向だけで、ピクセルではない
		const direction  = event.key === 'ArrowRight' ? 1 : -1;
		// アウトラインが左にあるときは右キーで広げる。右にあるときは符号を反転する
		const sideFactor = this.settings.outline.side === 'left' ? 1 : -1;
		// いまの幅。単位は CSS ピクセル
		const current    = this.outlinePanelElement.getBoundingClientRect().width;
		// 一段動かしたあとの幅。単位は CSS ピクセル
		const width      = current + direction * sideFactor * OUTLINE_KEYBOARD_RESIZE_STEP;
		this.applyOutlineWidth(width);
		void this.persistOutlineWidth(this.outlinePanelElement.getBoundingClientRect().width);
	}

	/**
	 * アウトライン幅を画面へ反映する
	 * @param width - 幅（px）
	 */
	private applyOutlineWidth(width: number): void {
		// 作業領域に収まるようクランプした幅。単位は CSS ピクセル
		const normalized = clampOutlineWidth(width, this.workspaceElement.getBoundingClientRect().width);
		this.workspaceElement.style.setProperty('--tms-mde-outline-width', `${normalized}px`);
		this.outlineResizerElement.setAttribute('aria-valuenow', String(normalized));
	}

	/**
	 * 調整後のアウトライン幅を設定へ保存する
	 * @param width - 幅（px）
	 */
	private async persistOutlineWidth(width: number): Promise<void> {
		// 保存する幅。単位は CSS ピクセル。作業領域を超える値はクランプする
		const normalized = clampOutlineWidth(width, this.workspaceElement.getBoundingClientRect().width);
		try {
			// 幅だけを部分保存した応答。失敗時は config が無い
			const result = await invokeBridge<SaveConfigResponse>(BRIDGE_METHOD.configUpdate, {
				settings: { outline: { width: normalized } }
			});
			// 保存できていない、または戻りの設定が無いときは画面を更新しない
			if (!result.success || !result.config) throw new Error(result.message ?? 'アウトライン幅を保存できませんでした。');

			this.settings = this.mergeSettingsWithDefaults(result.config.settings);
			this.applyOutlineWidth(this.settings.outline.width);
		} catch (error) {
			showToast(this.formatError(error));
		}
	}

	/**
	 * 保存済みカスタム装飾ルールを既存タブ・全ペインへ反映する
	 * @param rules - 保存済みルール
	 */
	private applyCustomDecorations(rules: CustomDecorationRule[]): void {
		// コンパイル結果。無効なルール名は rules に含めない
		const compiled             = compileCustomDecorationRules(rules);
		this.rawCustomDecorations  = rules;
		this.customDecorationRules = compiled.rules;
		this.applySettings(this.settings);
		// 無効な装飾が 1 件でもあるとき、名前を通知する
		if (compiled.invalidNames.length > 0) {
			showToast(`カスタム装飾ルールを無効化しました: ${compiled.invalidNames.join(', ')}`);
		}
	}

	/**
	 * CSSスニペットを再読込し、Web UIへ適用する
	 * @param notify - 完了通知を表示するか
	 */
	private async refreshCssSnippets(notify: boolean): Promise<void> {
		try {
			this.cssSnippets = await invokeBridge<CssSnippetsResponse>(BRIDGE_METHOD.cssSnippetsList);
			applyCssSnippets(this.cssSnippets);
			this.requestEditorMeasure();
			// 呼び出し元が完了通知を求めたときだけ、結果を出す
			if (notify) {
				// 再読込の成否。エラー文と通常文を分ける
				const status = getCssSnippetsReloadStatus(this.cssSnippets);
				// スニペット自体のエラーはダイアログにする
				if (status.isError) {
					showErrorMessage(status.message);
				} else {
					showToast(status.message);
				}
			}
		} catch (error) {
			// 読み込み失敗を通知するのは、利用者が再読込を頼んだときだけ
			if (notify) {
				showErrorMessage(this.formatError(error));
			}
		}
	}

	/**
	 * CSS変更後、全ペインのCodeMirror高さ情報を次フレームで再計測する
	 */
	private requestEditorMeasure(): void {
		window.requestAnimationFrame(() => {
			this.editorViews.forEach((view) => view.requestMeasure());
		});
	}

	/**
	 * CSSスニペットフォルダを開く
	 */
	private async openSnippetsFolder(): Promise<void> {
		try {
			await invokeBridge(BRIDGE_METHOD.cssSnippetsOpenFolder);
		} catch (error) {
			showErrorMessage(this.formatError(error));
		}
	}

	/**
	 * 欠落したネスト設定を既定値で補完する
	 * @param settings - 設定
	 * @returns 補完後設定
	 */
	private mergeSettingsWithDefaults(settings: AppSettings): AppSettings {
		// 欠落した入れ子を既定で埋めた設定。引数のオブジェクトは変えない
		return {
			// 既定値を下地にする
			...DEFAULT_SETTINGS,
			// 渡された値で上書きする。入れ子の穴は下の個別補完まで既定のまま
			...settings,
			// 未設定なら行末記号を出す
			showEolMarkers: settings.showEolMarkers ?? true,
			// 空白だけのフォント名は既定のコード用フォントに戻す
			codeFontFamily: settings.codeFontFamily?.trim() || DEFAULT_CODE_FONT_FAMILY,
			// 更新確認の入れ子。片側にしか無い項目は他方で補う
			update: {
				// 既定の確認とスキップ
				...DEFAULT_SETTINGS.update,
				// 保存済みの上書き。無い項目は既定のまま
				...settings.update
			},
			// 有効な CSS スニペット名。未設定は空
			cssSnippets: {
				...DEFAULT_SETTINGS.cssSnippets,
				...settings.cssSnippets
			},
			// アウトラインの表示と幅。幅が無いときは既定幅
			outline: {
				...DEFAULT_SETTINGS.outline,
				...settings.outline
			},
			// 書き出しの体裁。入れ子の outline は別途補う
			export: {
				...DEFAULT_SETTINGS.export,
				...settings.export,
				// 書き出し側のアウトライン。export 自体が無いときは既定だけ
				outline: {
					...DEFAULT_SETTINGS.export.outline,
					...settings.export?.outline
				}
			},
			// 外部ブラウザ。未設定の項目は既定のまま
			externalBrowser: {
				...DEFAULT_SETTINGS.externalBrowser,
				...settings.externalBrowser
			},
			// ショートカット。保存に無いキーは既定の割り当て
			keybindings: {
				...DEFAULT_SETTINGS.keybindings,
				...settings.keybindings
			},
			// 検索の挙動。未設定の項目は既定のまま
			search: {
				...DEFAULT_SETTINGS.search,
				...settings.search
			},
			// 画像の枠。未設定の項目は既定のまま
			imageBorder: {
				...DEFAULT_SETTINGS.imageBorder,
				...settings.imageBorder
			},
			// コンテキストメニュー。壊れた保存値は正規化して欠落を埋める
			contextMenu: normalizeContextMenuSettings(settings.contextMenu)
		};
	}

	// ----------------------------------------------
	// タブとファイル
	// ----------------------------------------------

	/**
	 * 新規タブを作成する
	 */
	public async createNewTab(): Promise<void> {
		// 新規タブの改行。設定が lf 以外なら crlf
		const defaultEol = this.parseDefaultEol(this.settings.newFileEol);
		// 空本文の行と改行。空文字なので行は 1 つ
		const split      = splitPreservingEol('');
		// CodeMirror に渡す LF 本文
		const cm6Text    = toCm6Text(split.lines, split.eols);
		// まだパスの無い空タブ
		const tab        = this.createTabRuntime({
			// 未保存なのでパスは null
			filePath: null,
			// 空の本文
			text: cm6Text,
			// 設定の既定文字コード
			encoding: this.parseDefaultEncoding(this.settings.newFileEncoding),
			// 設定の既定改行
			eol: defaultEol,
			// 空タブは改行が混ざらない
			eolMixed: false,
			// 空タブは大ファイルにしない
			largeFile: false,
			// 設定の既定表示モード
			viewMode: this.settings.defaultViewMode,
			// 空本文を既定改行で揃えた行末
			lineEols: createUniformLineEols(cm6Text, defaultEol)
		});

		this.tabs.push(tab);
		this.addTabToPane(tab, this.activePaneId);
		this.activateTab(tab.tabId, this.activePaneId);
	}

	/**
	 * ファイル選択ダイアログで開く
	 */
	public async openFileDialog(): Promise<void> {
		try {
			// ダイアログの結果。キャンセル時は file が無い
			const result = await invokeBridge<{ canceled: boolean; file?: TextFileInfo }>(BRIDGE_METHOD.fileOpenDialog);
			// キャンセルか、ファイルが選ばれなかったときはタブを増やさない
			if (result.canceled || !result.file) {
				return;
			}

			await this.openTextFileInfo(result.file);
		} catch (error) {
			showErrorMessage(this.formatError(error));
		}
	}

	/**
	 * パス指定でファイルを開く
	 * @param filePaths - ファイルパス一覧
	 */
	public async openFilePaths(filePaths: string[]): Promise<void> {
		for (const filePath of filePaths) {
			try {
				// 読んだファイル。開けないパスは catch で最近使った一覧から外す
				const file = await invokeBridge<TextFileInfo>(BRIDGE_METHOD.fileOpen, { filePath });
				await this.openTextFileInfo(file);
			} catch (error) {
				showErrorMessage(this.formatError(error));
				await invokeBridge(BRIDGE_METHOD.recentRemove, { filePath });
			}
		}
	}

	/**
	 * 読み込み済みファイル情報からタブを開く
	 * 既に開いているタブでも、開く操作なら recentFiles の先頭へ書き出す
	 * @param file - ファイル情報
	 */
	private async openTextFileInfo(file: TextFileInfo): Promise<void> {
		// 同じパスで既に開いているタブ。大文字小文字は区別しない。無ければ undefined
		const existing = this.tabs.find((tab) => tab.filePath && tab.filePath.toLowerCase() === file.filePath.toLowerCase());

		// 既に開いていれば新しいタブは作らず、そのペインを前面にする
		if (existing) {
			// そのタブがあるペイン。見つからなければアクティブペイン
			const paneId = this.findPaneContainingTab(existing.tabId) ?? this.activePaneId;
			this.activateTab(existing.tabId, paneId);
		} else {
			// 読込結果から作った新しいタブ
			const tab = this.createTabRuntimeFromTextFile(file);

			this.tabs.push(tab);
			this.addTabToPane(tab, this.activePaneId);
			this.activateTab(tab.tabId, this.activePaneId);
		}

		await invokeBridge(BRIDGE_METHOD.recentAdd, { filePath: file.filePath });
	}

	/**
	 * 保存済みセッションをディスク上の最新ファイル内容で復元する
	 * @param value - session.json から読んだ未検証の値
	 * @returns タブを 1 件以上開けたとき true。形式が壊れている、または全部開けないときは false
	 */
	private async restoreSession(value: unknown): Promise<boolean> {
		// 検証済みセッション。形式が壊れていれば null
		const session = normalizeSessionSnapshot(value);
		// 壊れたセッションは復元しない
		if (!session) return false;

		// ディスクから開けたタブ。同じパスは 1 件にまとめる
		const restoredTabs: TabRuntime[] = [];
		// セッション上のタブ ID から、開いた実行時タブ
		const runtimeBySessionTabId      = new Map<string, TabRuntime>();
		// パスの小文字から、先に開いた実行時タブ。同じファイルの重複を畳む
		const runtimeByPath              = new Map<string, TabRuntime>();
		// 開けなかったタブの件数。0 は全部開けた
		let skippedCount                 = 0;

		for (const savedTab of session.tabs) {
			try {
				// パス比較用のキー。大文字小文字は区別しない
				const pathKey = savedTab.filePath.toLowerCase();
				// 同じパスを既に開いていればそのタブ。無ければ undefined
				let tab       = runtimeByPath.get(pathKey);
				// まだ開いていないパスのときだけディスクから読む
				if (!tab) {
					// ディスク上の最新内容
					const file              = await invokeBridge<TextFileInfo>(BRIDGE_METHOD.fileOpen, { filePath: savedTab.filePath });
					// セッションが覚えていた表示モード。無ければ設定の既定
					const preferredViewMode = this.findSessionViewMode(session, savedTab.tabId);
					tab                     = this.createTabRuntimeFromTextFile(file, preferredViewMode);
					restoredTabs.push(tab);
					runtimeByPath.set(pathKey, tab);
				}
				runtimeBySessionTabId.set(savedTab.tabId, tab);
			} catch (error) {
				skippedCount++;
				void writeLog('WARN', `Session tab skipped: ${savedTab.filePath}: ${this.formatError(error)}`);
			}
		}

		// 開けたタブだけで組み直したペイン
		const restoredPanes = new Map<PaneId, PaneRuntime>();
		for (const savedPane of session.panes) {
			// このペインに残すタブ ID。開けなかったものと重複は除く
			const tabIds: string[] = [];
			// タブ ID から、このペイン用のエディタ状態
			const editorStates     = new Map<string, EditorState>();
			// タブ ID から、このペインの表示モード
			const viewModes        = new Map<string, ViewMode>();
			for (const savedTabId of savedPane.tabIds) {
				// セッション ID に対応する実行時タブ。開けていなければ undefined
				const tab = runtimeBySessionTabId.get(savedTabId);
				// タブが無い、またはこのペインに既にあるときは飛ばす。どちらか一方でも飛ばす
				if (!tab || tabIds.includes(tab.tabId)) continue;
				// 大ファイルはソース固定。それ以外はセッションのモード、無ければタブのモード
				const viewMode = tab.largeFile ? 'source' : (savedPane.viewModes[savedTabId] ?? tab.viewMode);
				tabIds.push(tab.tabId);
				viewModes.set(tab.tabId, viewMode);
				editorStates.set(tab.tabId, this.createPaneEditorState(tab, tab.editorState.doc.toString(), viewMode));
			}
			// 1 件も残らないペインは作らない
			if (tabIds.length === 0) continue;
			// セッションが選んでいたタブ。開けていなければ undefined
			const activeTab = runtimeBySessionTabId.get(savedPane.activeTabId);
			// 復元したペイン。選択タブが残っていなければ先頭
			restoredPanes.set(savedPane.paneId, {
				// セッションが付けていたペイン ID
				paneId: savedPane.paneId,
				// 残ったタブの並び
				tabIds,
				// 選択タブ。残っていなければ先頭
				activeTabId: activeTab && tabIds.includes(activeTab.tabId) ? activeTab.tabId : tabIds[0],
				// ペインごとのエディタ状態
				editorStates,
				// ペインごとの表示モード
				viewModes
			});
		}

		// 空になったペインを除いた分割木。残るペインが無ければ null
		const paneLayout = prunePaneLayout(session.paneLayout, new Set(restoredPanes.keys()));
		// 木が作れない、またはペインが 0 のときは復元しない。どちらか一方でも中止する
		if (!paneLayout || restoredPanes.size === 0) return false;

		this.editorViews.forEach((view) => view.destroy());
		this.editorViews.clear();
		this.panes.clear();
		restoredPanes.forEach((pane, paneId) => this.panes.set(paneId, pane));
		// いずれかのペインに載ったタブ ID。載らないタブは捨てる
		const usedTabIds  = new Set([...restoredPanes.values()].flatMap((pane) => pane.tabIds));
		this.tabs         = restoredTabs.filter((tab) => usedTabIds.has(tab.tabId));
		this.paneLayout   = paneLayout;
		this.activePaneId = restoredPanes.has(session.activePaneId) ? session.activePaneId : restoredPanes.keys().next().value!;
		this.activeTabId  = restoredPanes.get(this.activePaneId)?.activeTabId ?? this.tabs[0]?.tabId ?? null;
		this.mountActiveEditor();
		this.refreshStatusBar();
		void this.updateWindowTitle();

		// 開けなかったタブが 1 件でもあるときだけ、件数を通知する
		if (skippedCount > 0) showToast(`前回のタブ ${skippedCount} 件を復元できませんでした。ファイルが移動または削除されていないか確認してください。`);
		await writeLog('INFO', `Session restored: ${this.tabs.length} tabs, ${this.panes.size} panes.`);
		return this.tabs.length > 0;
	}

	/**
	 * セッション内で最初に指定された表示モードを返す
	 * @param session - 復元中のセッション
	 * @param tabId - 表示モードを探すタブ ID
	 * @returns そのタブを含む最初のペインに記録された表示モード。無ければ設定の既定
	 */
	private findSessionViewMode(session: SessionSnapshot, tabId: string): ViewMode {
		for (const pane of session.panes) {
			// そのタブを含む最初のペインの表示モード。記録が無ければ設定の既定
			if (pane.tabIds.includes(tabId)) return pane.viewModes[tabId] ?? this.settings.defaultViewMode;
		}
		return this.settings.defaultViewMode;
	}

	/**
	 * ファイル読込結果をタブランタイムへ変換する
	 * @param file - C# が読んだファイル
	 * @param preferredViewMode - セッションが覚えていた表示モード。省略時は設定の既定
	 * @returns 読込結果から作ったタブ
	 */
	private createTabRuntimeFromTextFile(file: TextFileInfo, preferredViewMode: ViewMode = this.settings.defaultViewMode): TabRuntime {
		// ファイルサイズ。通知に無ければ本文の UTF-8 バイト数。単位はバイト
		const sizeBytes      = file.fileSizeBytes ?? new TextEncoder().encode(file.text).length;
		// 大ファイル判定の閾値。設定は MiB、ここではバイト
		const thresholdBytes = this.settings.largeFileThresholdMb * 1024 * 1024;
		// 閾値以上なら true。ライブプレビューを使わない
		const largeFile      = isLargeFile(sizeBytes, thresholdBytes);
		// 大ファイルはソース固定。それ以外は希望の表示モード
		const viewMode       = largeFile ? 'source' : preferredViewMode;
		// 行と、行ごとの改行
		const split          = splitPreservingEol(file.text);
		// CodeMirror に渡す LF 本文
		const cm6Text        = toCm6Text(split.lines, split.eols);
		// 読込結果から作るタブ
		return this.createTabRuntime({
			// 開いたパス
			filePath: file.filePath,
			// LF に揃えた本文
			text: cm6Text,
			// 読込に使った文字コード
			encoding: file.encoding,
			// 主要な改行
			eol: file.primaryEol,
			// 行ごとに改行が混ざっているか
			eolMixed: file.eolMixed,
			// 大ファイルか
			largeFile,
			// このタブの表示モード
			viewMode,
			// 行ごとの改行
			lineEols: split.eols
		});
	}

	/**
	 * タブをアクティブ化する
	 * @param tabId - タブ ID
	 * @param paneId - ペイン ID
	 * @param options - ユーザ操作なら recentFiles を更新する
	 */
	public activateTab(tabId: string, paneId: PaneId = this.activePaneId, options: { recordRecent?: boolean } = {}): void {
		// 切り替えるタブ。ID が無ければ undefined
		const nextTab = this.tabs.find((tab) => tab.tabId === tabId);
		// 切り替え先ペイン。ID が無ければ undefined
		const pane    = this.panes.get(paneId);
		// タブとペインの両方が揃わないと切り替えない。どちらか一方が欠けても切り替えない
		if (!nextTab || !pane) {
			return;
		}

		// すでにそのペインでそのタブが前面か。recentFiles の再書き込みを省く
		const alreadyActive = pane.activeTabId === tabId && this.activePaneId === paneId;

		// タブを離れる操作は、復元追従中でも現在画面の実測位置を残す意思表示になる
		this.persistActiveEditorState(true);
		void this.flushNoteViewPositions();
		// そのペインにまだ無いタブは、先に登録する
		if (!pane.tabIds.includes(tabId)) this.addTabToPane(nextTab, paneId);
		pane.activeTabId  = tabId;
		this.activePaneId = paneId;
		this.activeTabId  = tabId;
		this.renderTabBar();
		this.mountActiveEditor();
		this.refreshStatusBar();
		void this.updateWindowTitle();

		// ユーザー操作であり、パスがあり、かつ別のタブから移ったときだけ最近使ったファイルを更新する。どれか一つが欠けても更新しない
		if (options.recordRecent && nextTab.filePath && !alreadyActive) {
			void invokeBridge(BRIDGE_METHOD.recentAdd, { filePath: nextTab.filePath });
		}
	}

	/**
	 * タブを閉じる
	 * @param tabId - タブ ID
	 * @param paneId - ペイン ID
	 * @param skipConfirm - 未保存確認を省略する場合true
	 * @param transferred - 別ウィンドウへの転送完了後に閉じる場合true
	 * @returns 閉じた場合 true
	 */
	public async closeTab(tabId: string, paneId: PaneId = this.activePaneId, skipConfirm = false, transferred = false): Promise<boolean> {
		// 閉じるタブ。ID が無ければ undefined
		const tab  = this.tabs.find((entry) => entry.tabId === tabId);
		// 閉じるペイン。ID が無ければ undefined
		const pane = this.panes.get(paneId);
		// タブとペインがあり、かつそのペインがそのタブを持つときだけ閉じる。どれか一つが欠けても閉じない
		if (!tab || !pane || !pane.tabIds.includes(tabId)) {
			return false;
		}

		// このタブを表示しているペインの数。1 のときだけタブ自体を捨てる
		const occurrenceCount = [...this.panes.values()].filter((entry) => entry.tabIds.includes(tabId)).length;
		// 確認を省略せず、最後の 1 枚であり、かつ未保存のときだけ保存を尋ねる。どれか一つが欠けても尋ねない
		if (!skipConfirm && occurrenceCount === 1 && tab.dirty) {
			// 保存、破棄、キャンセルのいずれか
			const choice = await showCloseConfirmDialog(tab.title);
			// キャンセルはタブを残す
			if (choice === 'cancel') {
				return false;
			}

			// 保存を選んだときだけディスクへ書く。失敗したら閉じない
			if (choice === 'save') {
				// 保存できたか。false ならタブを残す
				const saved = await this.saveTab(tabId);
				// 保存できなければ閉じない
				if (!saved) {
					return false;
				}
			}
		}

		pane.tabIds = pane.tabIds.filter((entry) => entry !== tabId);
		pane.editorStates.delete(tabId);
		pane.viewModes.delete(tabId);
		// 最後のペインから外れたときだけ、タブ本体と未保存の表示位置を捨てる
		if (occurrenceCount === 1) {
			this.tabs = this.tabs.filter((entry) => entry.tabId !== tabId);
			this.untitledNoteViewPositions.delete(tabId);
		}

		// タブが 0 になったときは、ウィンドウを閉じるか空タブを作る
		if (this.tabs.length === 0) {
			// 最後のタブを閉じたらアプリも閉じる設定であり、かつ別ウィンドウへの移動ではないときだけ終了を許す
			if (shouldCloseWindowAfterTabRemoval(this.tabs.length, this.settings.closeAppWhenLastTabClosed, transferred)) {
				await this.persistSession();
				await this.flushNoteViewPositions();
				await invokeBridge(BRIDGE_METHOD.appReportCloseReady, { allowClose: true });
				return true;
			}

			this.resetPaneLayout();
			await this.createNewTab();
			return true;
		}

		// ペインが空になり、かつ他のペインが残っているときだけ、そのペインを畳む。どちらか一方が欠けても畳まない
		if (pane.tabIds.length === 0 && this.panes.size > 1) {
			// 畳んだあとに前面にする隣のペイン。無ければ undefined
			const adjacentPaneId = findAdjacentPaneId(this.paneLayout, paneId);
			this.paneLayout      = removePane(this.paneLayout, paneId) ?? createPaneLayout(adjacentPaneId ?? AppController.INITIAL_PANE_ID);
			this.panes.delete(paneId);
			this.activePaneId = adjacentPaneId ?? listPaneIds(this.paneLayout)[0];
			// 閉じたタブが選択中だったときは、残った先頭を選ぶ。タブが残っていなければ null
		} else if (pane.activeTabId === tabId) {
			pane.activeTabId = pane.tabIds[0] ?? null;
		}

		// 前面ペイン。畳んだ直後に ID が無いときは undefined
		const activePane = this.panes.get(this.activePaneId);
		this.activeTabId = activePane?.activeTabId ?? this.tabs[0].tabId;
		this.mountActiveEditor();
		this.refreshStatusBar();
		void this.updateWindowTitle();

		return true;
	}

	/**
	 * アクティブタブを保存する
	 * @returns 保存成功時 true
	 */
	public async saveActiveTab(): Promise<boolean> {
		// 選択中のタブが無いときは保存しない
		if (!this.activeTabId) {
			return false;
		}

		return this.saveTab(this.activeTabId);
	}

	/**
	 * 名前を付けて保存する
	 * @returns 保存成功時 true
	 */
	public async saveAsActiveTab(): Promise<boolean> {
		// 保存するタブ。無ければ null
		const tab = this.getActiveTab();
		// タブが無いときはダイアログを出さない
		if (!tab) {
			return false;
		}

		this.persistActiveEditorState();

		try {
			// 保存ダイアログの結果。キャンセル時は filePath が無い
			const dialogResult = await invokeBridge<{ canceled: boolean; filePath?: string }>(BRIDGE_METHOD.fileSaveAsDialog, {
				// 既定の保存先。未保存タブはパスを渡さない
				filePath: tab.filePath ?? undefined
			});

			// パスを選ばなかったときは書かない
			if (dialogResult.canceled || !dialogResult.filePath) {
				return false;
			}

			// 文字コードと改行の選択。閉じたときは null
			const options = await showSaveAsOptionsDialog({
				// ダイアログの初期文字コード
				defaultEncoding: tab.encoding,
				// ダイアログの初期改行
				defaultEol: tab.eol
			});

			// 文字コードか改行を選ばなかったときは書かない
			if (!options) {
				return false;
			}

			// エディタ上の LF 本文
			const text     = tab.editorState.doc.toString();
			// 選んだ改行へ戻した、ディスクへ書く本文
			const diskText = normalizeEol(text, options.eol);
			return this.writeTab(tab.tabId, dialogResult.filePath, diskText, options.encoding, options.eol, createUniformLineEols(text, options.eol));
		} catch (error) {
			showErrorMessage(this.formatError(error));
			return false;
		}
	}

	/**
	 * アクティブタブを HTML または PDF へエクスポートする
	 * @param kind - 出力種別
	 */
	private async exportActiveTab(kind: 'html' | 'pdf'): Promise<void> {
		// 書き出すタブ。無ければ null
		const tab = this.getActiveTab();
		// タブが無いときはダイアログを出さない
		if (!tab) {
			showToast('エクスポートするタブがありません。');
			return;
		}

		// 準備中の通知。0 は自動で消さない。finally で閉じる
		const preparing = showToast('エクスポートを準備しています', 0);
		try {
			// HTML と、PDF のときにコピーする画像。タブが途中で消えたときは null
			const prepared = await this.buildActiveExportHtml(kind === 'html' ? 'inline' : 'file');
			// HTML を作れなかったときは保存ダイアログを出さない
			if (!prepared) {
				return;
			}

			// 保存先ダイアログの結果。キャンセル時は filePath が無い
			const dialogResult = await invokeBridge<{ canceled: boolean; filePath?: string }>(BRIDGE_METHOD.fileExportDialog, {
				// html か pdf
				kind,
				// 拡張子を付けた提案名。使えない文字はアンダースコア
				suggestedName: suggestedExportFileName(tab, kind),
				// 既定ディレクトリの手がかり。未保存は渡さない
				filePath: tab.filePath ?? undefined
			});
			// 保存先を選ばなかったときはファイルを書かない
			if (dialogResult.canceled || !dialogResult.filePath) {
				return;
			}

			// HTML は UTF-8 ファイルとして書く。PDF は印刷経路へ回す
			if (kind === 'html') {
				// 書き込み結果。失敗時は message がある
				const saved = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.fileWriteUtf8, {
					// ダイアログで選んだパス
					filePath: dialogResult.filePath,
					// 画像を Data URL にした HTML
					text: prepared.html
				});
				// 書けなかったときは理由を例外にして catch で出す。理由が無ければ固定文
				if (!saved.success) {
					throw new Error(saved.message ?? 'HTML の保存に失敗しました。');
				}

				showToast('HTML を保存しました。');
				return;
			}

			// PDF 化の結果。失敗時は message がある
			const printed = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.exportPrintToPdf, {
				// 画像を相対パスにした HTML
				html: prepared.html,
				// ダイアログで選んだ PDF のパス
				filePath: dialogResult.filePath,
				// 一時フォルダへコピーする画像。無ければ空配列
				media: prepared.media
			});
			// PDF を書けなかったときは理由を例外にする。理由が無ければ固定文
			if (!printed.success) {
				throw new Error(printed.message ?? 'PDF の出力に失敗しました。');
			}

			showToast('PDF を保存しました。');
		} catch (error) {
			showErrorMessage(this.formatError(error));
		} finally {
			preparing.dismiss();
		}
	}

	/**
	 * アクティブタブを印刷する
	 */
	private async printActiveTab(): Promise<void> {
		// 印刷するタブが無いときは準備を始めない
		if (!this.getActiveTab()) {
			showToast('印刷するタブがありません。');
			return;
		}

		// 準備中の通知。0 は自動で消さない。finally で閉じる
		const preparing = showToast('印刷を準備しています', 0);
		try {
			// 印刷用 HTML と画像。タブが途中で消えたときは null
			const prepared = await this.buildActiveExportHtml('file');
			// HTML を作れなかったときは印刷 UI を出さない
			if (!prepared) {
				return;
			}

			// 印刷 UI を出せたか。失敗時は message がある
			const printed = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.exportShowPrintUi, {
				// 画像を相対パスにした HTML
				html: prepared.html,
				// 一時フォルダへコピーする画像。無ければ空配列
				media: prepared.media
			});
			// 印刷 UI を出せなかったときは理由を例外にする。理由が無ければ固定文
			if (!printed.success) {
				throw new Error(printed.message ?? '印刷ダイアログを表示できませんでした。');
			}
		} catch (error) {
			showErrorMessage(this.formatError(error));
		} finally {
			preparing.dismiss();
		}
	}

	/**
	 * アクティブタブ本文から書き出し HTML を生成する
	 * HTML ファイルは画像を Data URL にし、PDF と印刷は一時フォルダの相対パスにする
	 * @param imageMode - inline は Data URL、file は media 相対パス
	 * @returns HTML と、file のときにコピーする画像。対象タブが無いときは null
	 */
	private async buildActiveExportHtml(imageMode: 'inline' | 'file'): Promise<{ html: string; media: ExportMediaFile[] } | null> {
		this.persistActiveEditorState();
		// 書き出すタブ。無ければ null を返す
		const tab = this.getActiveTab();
		// タブが無いときは HTML を作らない
		if (!tab) {
			return null;
		}

		// 有効で、エラーがなく、本文があるスニペットの CSS
		const snippets = this.cssSnippets.snippets.filter((snippet) => snippet.enabled && !snippet.error && snippet.cssText).map((snippet) => snippet.cssText);
		// file モードで増やす画像。inline のときは空のまま
		const media    = [] as ExportMediaFile[];

		// 書き出す HTML。画像の解決方法は imageMode で分ける
		const html = await renderExportHtml({
			// エディタ上の本文
			markdown: tab.editorState.doc.toString(),
			// 文書タイトル。空なら無題
			title: tab.title || '無題',
			// 画像解決の基準パス。未保存は null
			filePath: tab.filePath,
			// 明暗の確定値。system は OS の配色
			theme: resolveExportTheme(this.settings.theme),
			// 本文フォント
			editorFontFamily: this.settings.editorFontFamily,
			// 本文フォントサイズ。単位は CSS ピクセル
			editorFontSize: this.settings.editorFontSize,
			// コード用フォント
			codeFontFamily: this.settings.codeFontFamily,
			// 画像の枠
			imageBorder: this.settings.imageBorder,
			// 有効なスニペット CSS。無ければ空配列
			snippetsCss: snippets,
			// 無効なルールも含む装飾
			customDecorations: this.rawCustomDecorations,
			// リモート画像を読むか
			loadRemoteImages: this.settings.loadRemoteImages,
			// 書き出し側のアウトライン
			outline: this.settings.export.outline,
			// file のときは印刷用の画像解決、inline のときは Data URL 解決
			resolveImage: imageMode === 'file' ? (request) => this.resolvePrintImage(request, media) : (request) => this.resolveExportImage(request),
			// Mermaid を書き出し用に描く
			renderMermaid: this.renderExportMermaid.bind(this)
		});
		// 書き出した HTML と、file のときにコピーする画像。inline では media は空
		return { html, media };
	}

	/**
	 * エクスポート用に画像を Data URL へ解決する
	 * @param request - 画像要求
	 * @returns 画像の Data URL。未解決のときは null
	 */
	private async resolveExportImage(request: ExportImageRequest): Promise<string | null> {
		// リモート URL は、読み込みを許すか data URL のときだけそのまま使う。それ以外は未解決
		if (request.kind === 'url') {
			return this.settings.loadRemoteImages || request.raw.startsWith('data:') ? request.raw : null;
		}

		try {
			// Data URL 化の結果。失敗時は dataUrl が無い
			const result = await invokeBridge<{ ok: boolean; dataUrl?: string }>(BRIDGE_METHOD.fileReadImageAsDataUrl, {
				// ファイルパス。埋め込みのときは渡さない
				path: request.embed ? undefined : request.raw,
				// 埋め込み画像。パス参照のときは渡さない
				embed: request.embed ? request.raw : undefined,
				// 解決の基準になる文書パス。無ければ渡さない
				documentPath: request.documentPath ?? undefined
			});
			return result.ok && result.dataUrl ? result.dataUrl : null;
		} catch {
			return null;
		}
	}

	/**
	 * PDF と印刷用に画像の絶対パスを解決し、一時フォルダの相対パスを返す
	 * バイトは読まない。同じパスは 1 枚にまとめる
	 * @param request - 画像要求
	 * @param media - ここまでに解決した画像。新しい画像はここへ加える
	 * @returns `media/1.png` の形。未解決のときは null
	 */
	private async resolvePrintImage(request: ExportImageRequest, media: ExportMediaFile[]): Promise<string | null> {
		// リモート URL は、読み込みを許すか data URL のときだけそのまま使う。それ以外は未解決
		if (request.kind === 'url') {
			return this.settings.loadRemoteImages || request.raw.startsWith('data:') ? request.raw : null;
		}

		try {
			// 絶対パスへ解決した結果。失敗時は resolvedPath が無い
			const result = await invokeBridge<{ ok: boolean; resolvedPath?: string }>(BRIDGE_METHOD.fileResolveLocalImage, {
				// ファイルパス。埋め込みのときは渡さない
				path: request.embed ? undefined : request.raw,
				// 埋め込み画像。パス参照のときは渡さない
				embed: request.embed ? request.raw : undefined,
				// 解決の基準になる文書パス。無ければ渡さない
				documentPath: request.documentPath ?? undefined
			});
			// 解決できない、またはパスが空のときは画像を足さない。どちらか一方でも未解決
			if (!result.ok || !result.resolvedPath) {
				return null;
			}

			return rememberExportMedia(media, result.resolvedPath);
		} catch {
			return null;
		}
	}

	/**
	 * エクスポート用に Mermaid を SVG 化する
	 * @param source - ソース
	 * @param theme - テーマ
	 * @returns 成功時は SVG、失敗時は理由を含む結果
	 */
	private async renderExportMermaid(source: string, theme: 'default' | 'dark'): Promise<ExportMermaidResult> {
		// SVG 化の結果。失敗時は ok が false で error がある
		const result = await renderMermaidSource(source, theme);
		return result.ok ? { ok: true, svg: result.svg } : { ok: false, error: result.error };
	}

	/**
	 * 指定タブを保存する
	 * @param tabId - タブ ID
	 * @returns 保存成功時 true
	 */
	private async saveTab(tabId: string): Promise<boolean> {
		// 保存するタブ。ID が無ければ undefined
		const tab = this.tabs.find((entry) => entry.tabId === tabId);
		// タブが無いときは書かない
		if (!tab) {
			return false;
		}

		// 前面のタブは、画面の最新本文を先にタブへ戻す
		if (this.activeTabId === tabId) {
			this.persistActiveEditorState();
		}

		// パスが無い未保存タブは、名前を付けて保存へ回す
		if (!tab.filePath) {
			return this.saveAsActiveTab();
		}

		// エディタ上の LF 本文
		const cm6Text = tab.editorState.doc.toString();
		// ディスクへ書く本文。改行の扱いが決まるまで未代入
		let diskText: string;
		// 保存後にタブへ残す行末。混在を維持するときは今のマップ
		let nextLineEols = tab.lineEols;
		// 保存後の主要な改行。統一したときだけ選んだ種別に変わる
		let nextEol      = tab.eol;
		// 保存後も改行が混在するか。統一したら false
		let nextMixed    = tab.eolMixed;

		// 改行が混在しているときだけ、統一するか維持するかを尋ねる
		if (tab.eolMixed) {
			// 統一する改行か、そのままか、キャンセル
			const choice = await showEolMixedDialog();
			// キャンセルはディスクへ書かない
			if (choice === 'cancel') {
				return false;
			}

			// crlf か lf を選んだときだけ、文書全体をその改行へ揃える
			if (choice === 'crlf' || choice === 'lf') {
				diskText     = normalizeEol(cm6Text, choice);
				nextLineEols = createUniformLineEols(cm6Text, choice);
				nextEol      = choice;
				nextMixed    = false;
			} else {
				// そのまま保存: 行ごとの元改行を復元する
				diskText = reconstructWithLineEols(cm6Text, tab.lineEols, tab.eol);
			}
		} else {
			// 非混在: CM6 の LF をドキュメントの改行種別に復元
			diskText     = normalizeEol(cm6Text, tab.eol);
			nextLineEols = createUniformLineEols(cm6Text, tab.eol);
		}

		return this.writeTab(tabId, tab.filePath, diskText, tab.encoding, nextEol, nextLineEols, nextMixed);
	}

	/**
	 * ファイル書き込みを実行する
	 * @param tabId - タブ ID
	 * @param filePath - 保存先
	 * @param diskText - ディスクへ書くテキスト（改行済み）
	 * @param encoding - 文字コード
	 * @param eol - 主要改行
	 * @param lineEols - 行末マップ
	 * @param eolMixed - 混在フラグ
	 * @returns 成功時 true
	 */
	private async writeTab(tabId: string, filePath: string, diskText: string, encoding: EncodingKind, eol: EolKind, lineEols: Array<EolKind | null>, eolMixed?: boolean): Promise<boolean> {
		// 書き込むタブ。閉じられた直後は undefined
		const tab = this.tabs.find((entry) => entry.tabId === tabId);
		// タブが無いときはディスクへ書かない
		if (!tab) {
			return false;
		}

		try {
			// 改行は diskText に既に反映済み。C# 側で再統一しない
			const result = await invokeBridge<SaveFileResult>(BRIDGE_METHOD.fileSave, {
				// 書き込み先
				filePath,
				// 改行を戻した本文
				text: diskText,
				// 保存に使う文字コード
				encoding
			});

			// ディスクへ書けなかったときはタブの保存状態を変えない
			if (!result.success) {
				return false;
			}

			// 書いた本文の行と改行
			const split   = splitPreservingEol(diskText);
			// エディタへ戻す LF 本文
			const cm6Text = toCm6Text(split.lines, split.eols);
			tab.filePath  = result.filePath;
			tab.title     = buildTabTitle(result.filePath);
			tab.encoding  = result.encoding;
			tab.eol       = eolMixed === undefined ? result.primaryEol : eol;
			tab.eolMixed  = eolMixed === undefined ? result.eolMixed : eolMixed;
			tab.lineEols  = lineEols.length > 0 ? lineEols : split.eols;
			tab.savedText = cm6Text;
			tab.dirty     = false;

			this.editorViews.forEach((view, paneId) => {
				// このタブを前面にしていないペインは本文を差し替えない
				if (this.panes.get(paneId)?.activeTabId !== tabId) return;
				// 画面の本文が保存結果と違うときだけ置き換える。同じなら選択を崩さない
				if (view.state.doc.toString() !== cm6Text) replaceEditorText(view, cm6Text);
				this.applyDocumentContextToEditor(view, result.filePath);
			});
			this.persistActiveEditorState();

			this.renderTabBar();
			this.refreshStatusBar();
			void this.updateWindowTitle();
			await invokeBridge(BRIDGE_METHOD.recentAdd, { filePath: result.filePath });
			return true;
		} catch (error) {
			this.refreshStatusBar();
			showErrorMessage(this.formatError(error));
			return false;
		}
	}

	// ----------------------------------------------
	// セッションと終了
	// ----------------------------------------------

	/**
	 * ウィンドウクローズ確認を処理する
	 */
	private async handleQueryClose(): Promise<void> {
		this.persistActiveEditorState();

		// 未保存のタブ。0 件なら確認せず閉じる
		const dirtyTabs = this.tabs.filter((tab) => tab.dirty);

		for (const tab of dirtyTabs) {
			// 保存、破棄、キャンセルのいずれか
			const choice = await showCloseConfirmDialog(tab.title);
			// キャンセルはウィンドウを閉じない
			if (choice === 'cancel') {
				await invokeBridge(BRIDGE_METHOD.appReportCloseReady, { allowClose: false });
				return;
			}

			// 保存を選んだときだけディスクへ書く。失敗したら閉じない
			if (choice === 'save') {
				// 保存できたか。false なら終了を止める
				const saved = await this.saveTab(tab.tabId);
				// 保存できなければウィンドウを閉じない
				if (!saved) {
					await invokeBridge(BRIDGE_METHOD.appReportCloseReady, { allowClose: false });
					return;
				}
			}
		}

		await this.persistSession();
		await this.flushNoteViewPositions();
		await invokeBridge(BRIDGE_METHOD.appReportCloseReady, { allowClose: true });
	}

	/** 主ウィンドウの保存可能なタブ・ペイン状態を session.json へ保存する */
	private async persistSession(): Promise<void> {
		// セッションを保存する側でなければ、他ウィンドウの session.json を上書きしない
		if (!this.isSessionOwner) return;
		this.persistActiveEditorState();
		// 保存するセッション。スナップショットを作れないときは空のセッション
		const snapshot = createSessionSnapshot({
			// パスを持つタブだけ。未保存の filePath は null
			tabs: this.tabs.map((tab) => ({ tabId: tab.tabId, filePath: tab.filePath })),
			// ペインごとのタブ並びと表示モード
			panes: [...this.panes.values()].map((pane) => ({
				// レイアウト上のペイン ID
				paneId: pane.paneId,
				// 左から並べたタブ ID
				tabIds: pane.tabIds,
				// 選択中のタブ。タブが無いときは null
				activeTabId: pane.activeTabId,
				// タブ ID から表示モード。未記録はタブか設定の既定
				viewModes: Object.fromEntries(pane.tabIds.map((tabId) => [tabId, pane.viewModes.get(tabId) ?? this.tabs.find((tab) => tab.tabId === tabId)?.viewMode ?? this.settings.defaultViewMode]))
			})),
			// 分割の木
			paneLayout: this.paneLayout,
			// 前面のペイン
			activePaneId: this.activePaneId
		}) ?? {
			// 空セッションの形式番号
			schemaVersion: SESSION_SCHEMA_VERSION,
			// タブは持たない
			tabs: [],
			// ペインは持たない
			panes: [],
			// 初期の単一ペイン
			paneLayout: createPaneLayout(AppController.INITIAL_PANE_ID),
			// 初期ペインを前面にする
			activePaneId: AppController.INITIAL_PANE_ID
		};

		try {
			// 保存結果。失敗時は message がある
			const result = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.sessionSave, snapshot as unknown as Record<string, unknown>);
			// 保存できなくても終了は止めず、警告だけ残す
			if (!result.success) void writeLog('WARN', result.message ?? 'Session save failed.');
		} catch (error) {
			void writeLog('WARN', `Session save failed: ${this.formatError(error)}`);
		}
	}

	// ----------------------------------------------
	// キーボードと外部変更
	// ----------------------------------------------

	/**
	 * グローバルキーダウンを処理する
	 * @param event - キーイベント
	 */
	private async handleGlobalKeydown(event: KeyboardEvent): Promise<void> {
		// ダイアログ表示中はショートカットを奪わない
		if (document.querySelector('.tms-mde-dialog-backdrop')) {
			return;
		}

		// Escape であり、エディタがあり、かつ開いている検索パネルを閉じられたときだけキーを消費する。どれか一つが欠けても次のショートカットへ進む
		if (event.key === 'Escape' && this.editorView && closeOpenSearchPanel(this.editorView)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		// 設定のショートカット。未設定のキーは各分岐の既定へ落とす
		const keybindings = this.settings.keybindings;
		// 上下分割のショートカット
		if (matchesShortcut(event, keybindings?.splitHorizontal ?? 'Ctrl+Shift+-')) {
			event.preventDefault();
			this.splitActiveView('horizontal');
			return;
		}

		// 左右分割のショートカット
		if (matchesShortcut(event, keybindings?.splitVertical ?? 'Ctrl+Shift+\\')) {
			event.preventDefault();
			this.splitActiveView('vertical');
			return;
		}

		// 分割を畳むショートカット
		if (matchesShortcut(event, keybindings?.unsplit ?? 'Ctrl+Shift+U')) {
			event.preventDefault();
			this.unsplitActiveView();
			return;
		}

		// 表示倍率のキーは、ここで処理済みなら他のショートカットへ渡さない
		if (handleUiZoomKeydown(event)) {
			return;
		}

		// 保存のショートカット
		if (matchesShortcut(event, keybindings.save)) {
			event.preventDefault();
			await this.saveActiveTab();
			return;
		}

		// 名前を付けて保存のショートカット
		if (matchesShortcut(event, keybindings.saveAs)) {
			event.preventDefault();
			await this.saveAsActiveTab();
			return;
		}

		// HTML 書き出しのショートカット
		if (matchesShortcut(event, keybindings.exportHtml ?? 'Ctrl+Shift+H')) {
			event.preventDefault();
			await this.exportActiveTab('html');
			return;
		}

		// PDF 書き出しのショートカット
		if (matchesShortcut(event, keybindings.exportPdf ?? 'Ctrl+Shift+P')) {
			event.preventDefault();
			await this.exportActiveTab('pdf');
			return;
		}

		// 印刷のショートカット
		if (matchesShortcut(event, keybindings.print ?? 'Ctrl+P')) {
			event.preventDefault();
			await this.printActiveTab();
			return;
		}

		// 書式なし貼り付けのショートカット
		if (matchesShortcut(event, keybindings.pastePlain ?? 'Ctrl+Shift+V')) {
			// キーの送り先。テキストノードのときは Element ではない
			const target = event.target;
			// 表、検索、ダイアログ、設定のどれかの中では、エディタの書式なし貼り付けに奪わない
			if (target instanceof Element && (target.closest('.cm-md-table') || target.closest('.cm-search') || target.closest('.tms-mde-dialog-backdrop') || target.closest('.tms-mde-settings-backdrop'))) {
				return;
			}

			event.preventDefault();
			this.suppressSmartPaste = true;
			// 編集できるエディタがあるときだけ本文へ貼る。読み取り専用か未マウントでは貼らない
			if (this.editorView && !this.editorView.state.readOnly) {
				await this.pasteIntoEditor(this.editorView, 'plain');
			}

			window.setTimeout(() => {
				this.suppressSmartPaste = false;
			}, 0);
			return;
		}

		// ファイルを開くショートカット
		if (matchesShortcut(event, keybindings.openFile)) {
			event.preventDefault();
			await this.openFileDialog();
			return;
		}

		// 新規タブのショートカット
		if (matchesShortcut(event, keybindings.newFile)) {
			event.preventDefault();
			await this.createNewTab();
			return;
		}

		// タブを閉じるショートカット
		if (matchesShortcut(event, keybindings.closeTab)) {
			event.preventDefault();
			// 選択中のタブがあるときだけ閉じる
			if (this.activeTabId) {
				await this.closeTab(this.activeTabId);
			}
			return;
		}

		// 次のタブへ移るショートカット
		if (matchesShortcut(event, keybindings.nextTab)) {
			event.preventDefault();
			this.switchTab(1);
			return;
		}

		// 前のタブへ移るショートカット
		if (matchesShortcut(event, keybindings.prevTab)) {
			event.preventDefault();
			this.switchTab(-1);
			return;
		}

		// 検索パネルを開くショートカット
		if (matchesShortcut(event, keybindings.find)) {
			event.preventDefault();
			event.stopPropagation();
			this.openActiveSearchPanel('find');
			return;
		}

		// 置換パネルを開くショートカット
		if (matchesShortcut(event, keybindings.replace)) {
			event.preventDefault();
			event.stopPropagation();
			this.openActiveSearchPanel('replace');
			return;
		}

		// 前の検索一致へ移るショートカット
		if (matchesShortcut(event, keybindings.findPrev)) {
			event.preventDefault();
			event.stopPropagation();
			// 検索できるエディタがあるときだけ前へ移る
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'previous');
			}
			return;
		}

		// 次の検索一致へ移るショートカット
		if (matchesShortcut(event, keybindings.findNext)) {
			event.preventDefault();
			event.stopPropagation();
			// 検索できるエディタがあるときだけ次へ移る
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'next');
			}
			return;
		}

		// 表示モード切替の割り当て。未設定なら一致しない
		const toggleViewModeShortcut = this.settings.keybindings.toggleViewMode;
		// ライブプレビューとソースを切り替えるショートカット
		if (matchesShortcut(event, toggleViewModeShortcut)) {
			event.preventDefault();
			this.toggleActiveTabViewMode();
			return;
		}

		// アウトライン表示を切り替えるショートカット
		if (matchesShortcut(event, keybindings.toggleOutline ?? 'Ctrl+Shift+O')) {
			event.preventDefault();
			this.toggleOutline();
			return;
		}
	}

	/**
	 * 外部変更された保存済みファイルを通知または再読込する
	 * @param filePath - 変更されたファイルパス
	 */
	private async handleExternalFileChanged(filePath: string, kind: 'changed' | 'deleted' | 'renamed'): Promise<void> {
		// 同じパスを開いているタブ。大文字小文字は区別しない。無ければ undefined
		const tab = this.tabs.find((entry) => entry.filePath?.toLowerCase() === filePath.toLowerCase());
		// このウィンドウで開いていないファイルの通知は捨てる
		if (!tab) return;
		// 削除とリネームは本文を取り込めないので、未保存にして確認だけ出す
		if (kind !== 'changed') {
			tab.dirty = true;
			this.renderTabBar();
			this.refreshStatusBar();
			// トーストに出す操作名。削除以外のこの分岐はリネーム
			const action = kind === 'deleted' ? '削除' : 'リネーム';
			// 無視だけを出す通知。再読込はできない
			showActionToast(`外部で${action}されました: ${tab.title}`, [
				{
					// 通知を閉じ、バッファは未保存のまま残す
					label: '無視',
					/** ディスク側が消えても、現在のバッファは未保存のまま保持する */
					onClick: () => showToast(`現在の編集内容を保持します: ${tab.title}`)
				}
			]);
			return;
		}
		// 未保存か、外部変更が確認のときだけ再読込を選ばせる。保存済みで自動取り込みならこの分岐に入らない
		if (tab.dirty || this.settings.externalChangeBehavior === 'confirm') {
			showActionToast(`外部で変更されました: ${tab.title}`, [
				// ディスクの内容でバッファを置き換える項目
				{
					// 再読込を選ぶラベル
					label: '再読込（編集を破棄）',
					/** ユーザーの明示操作時だけ、未保存バッファをディスク内容で置き換える */
					onClick: () => void this.reloadExternalFile(tab)
				},
				// 外部変更を取り込まない項目
				{
					// 編集を続けるラベル
					label: '無視',
					/** 外部変更を取り込まず、編集を継続できる状態を残す */
					onClick: () => showToast(`現在の編集内容を保持します: ${tab.title}`)
				}
			]);
			return;
		}
		await this.reloadExternalFile(tab);
	}

	/**
	 * 外部変更されたファイルを読み直してタブへ反映する
	 * @param tab - 再読込対象タブ
	 */
	private async reloadExternalFile(tab: TabRuntime): Promise<void> {
		try {
			// パスの無いタブはディスクから読めない
			if (!tab.filePath) return;
			// ディスク上の本文と文字コード。失敗時は catch へ落ちる
			const file    = await invokeBridge<TextFileInfo>(BRIDGE_METHOD.fileOpen, { filePath: tab.filePath });
			// 行本文と行末を分けた結果。空ファイルは行が空
			const split   = splitPreservingEol(file.text);
			// エディタへ渡す本文。改行の種類は lineEols 側に残す
			const text    = toCm6Text(split.lines, split.eols);
			tab.encoding  = file.encoding;
			tab.eol       = file.primaryEol;
			tab.eolMixed  = file.eolMixed;
			tab.lineEols  = split.eols;
			tab.savedText = text;
			tab.dirty     = false;
			this.replaceTabText(tab, text);
			this.renderTabBar();
			this.refreshStatusBar();
			showToast(`外部変更を再読込しました: ${tab.title}`);
		} catch (error) {
			showToast(`外部変更の再読込に失敗しました: ${this.formatError(error)}`);
		}
	}

	/**
	 * アクティブエディタの検索・置換パネルを開く
	 * @param mode - パネルモード
	 */
	private openActiveSearchPanel(mode: 'find' | 'replace'): void {
		// エディタが無いときは検索パネルを開けない
		if (!this.editorView) {
			return;
		}

		(mode === 'replace' ? openReplacePanel : openFindPanel)(this.editorView);
	}

	/**
	 * タブを切り替える
	 * @param offset - 移動量
	 */
	private switchTab(offset: number): void {
		// 前面ペイン。レイアウトとずれていれば undefined
		const pane = this.panes.get(this.activePaneId);
		// 選択中タブが無いか、タブが1枚以下なら循環先が無い。どちらか一方でも切り替えない
		if (!pane?.activeTabId || pane.tabIds.length <= 1) {
			return;
		}

		// 選択中タブの位置。見つからなければ -1
		const currentIndex = pane.tabIds.indexOf(pane.activeTabId);
		// 循環させた移動先。単位は tabIds の添字
		const nextIndex    = (currentIndex + offset + pane.tabIds.length) % pane.tabIds.length;
		this.activateTab(pane.tabIds[nextIndex], pane.paneId, { recordRecent: true });
	}

	/**
	 * 文字コードメニューを処理する
	 */
	private handleEncodingMenuClick(): void {
		// 文字コードを変えるタブ。無ければメニューを出さない
		const tab = this.getActiveTab();
		// タブが無いときは文字コードを選べない
		if (!tab) {
			return;
		}

		showEncodingMenu(this.statusElements.encoding, (encoding) => {
			tab.encoding = encoding;
			tab.dirty    = tab.editorState.doc.toString() !== tab.savedText || tab.dirty;
			this.refreshStatusBar();
			this.renderTabBar();
		});
	}

	/**
	 * 改行コード変換メニューを処理する
	 */
	private handleEolMenuClick(): void {
		// 改行を揃えるタブ。無ければメニューを出さない
		const tab = this.getActiveTab();
		// タブかエディタのどちらかが欠けても、改行は揃えられない
		if (!tab || !this.editorView) {
			return;
		}

		showEolConvertMenu(this.statusElements.eol, (targetEol) => {
			// エディタ上の本文。改行の種類は行末マップ側で揃える
			const current = this.editorView!.state.doc.toString();
			tab.eol       = targetEol;
			tab.eolMixed  = false;
			tab.lineEols  = createUniformLineEols(current, targetEol);
			tab.dirty     = true;
			this.applyLineEolsToEditor(tab.lineEols);
			this.persistActiveEditorState();
			this.renderTabBar();
			this.refreshStatusBar();
			void this.updateWindowTitle();
		});
	}

	/**
	 * 改行マーカー表示を行単位 EOL マップへ同期する
	 * @param lineEols - 行末マップ
	 */
	private applyLineEolsToEditor(lineEols: Array<EolKind | null>): void {
		// 改行マーカーを出さない設定では、行末マップをエディタへ渡さない
		if (!this.settings.showEolMarkers) {
			return;
		}

		// 同期するタブ。未選択なら null
		const tabId = this.activeTabId;
		this.editorViews.forEach((view, paneId) => {
			// そのペインの前面が別タブなら、このマップは渡さない
			if (this.panes.get(paneId)?.activeTabId !== tabId) return;
			view.dispatch({
				effects: setLineEolsEffect.of(lineEols)
			});
		});
	}

	/** 指定文字コードでアクティブファイルを再読込する */
	private async reloadActiveFileWithEncoding(): Promise<void> {
		// 読み直すタブ。無ければ案内だけ出す
		const tab = this.getActiveTab();
		// 保存済みパスが無いタブは、文字コードを指定して読めない
		if (!tab?.filePath) {
			showToast('保存済みファイルを選択してください。');
			return;
		}
		// 未保存の本文をディスクで上書きしない
		if (tab.dirty) {
			showToast('未保存の変更があるため再読込できません。');
			return;
		}
		// 選ばれた文字コード。キャンセルなら null
		const encoding = await showReloadEncodingDialog(tab.encoding);
		// キャンセルされたら読み直さない
		if (!encoding) return;
		try {
			// 指定文字コードで読んだ本文。失敗時は catch へ落ちる
			const file    = await invokeBridge<TextFileInfo>(BRIDGE_METHOD.fileOpenWithEncoding, { filePath: tab.filePath, encoding });
			// 行本文と行末を分けた結果。空ファイルは行が空
			const split   = splitPreservingEol(file.text);
			// エディタへ渡す本文。改行の種類は lineEols 側に残す
			const text    = toCm6Text(split.lines, split.eols);
			tab.encoding  = file.encoding;
			tab.eol       = file.primaryEol;
			tab.eolMixed  = file.eolMixed;
			tab.lineEols  = split.eols;
			tab.savedText = text;
			tab.dirty     = false;
			this.replaceTabText(tab, text);
			this.renderTabBar();
			this.refreshStatusBar();
			showToast(`指定の文字コードで再読込しました: ${formatEncodingLabel(encoding)}`);
		} catch (error) {
			showErrorMessage(this.formatError(error));
		}
	}

	// ----------------------------------------------
	// 表示モードと分割
	// ----------------------------------------------

	/**
	 * アクティブタブの表示モードを切り替える
	 */
	private toggleActiveTabViewMode(): void {
		// 表示を切り替えるタブ。無ければ何もしない
		const tab  = this.getActiveTab();
		// 前面ペイン。無ければ何もしない
		const pane = this.panes.get(this.activePaneId);
		// タブかペインが無いか、大きいファイルでは表示モードを切り替えない。どれか一つでも欠ければ戻る
		if (!tab || !pane || tab.largeFile) {
			return;
		}

		// このペインの表示。ペイン側が無ければタブの値
		const currentMode = pane.viewModes.get(tab.tabId) ?? tab.viewMode;
		// ライブプレビューとソースのもう一方
		const nextMode    = currentMode === 'live-preview' ? 'source' : 'live-preview';
		pane.viewModes.set(tab.tabId, nextMode);
		tab.viewMode = nextMode;
		this.applyViewModeToEditor(nextMode);
		this.persistActiveEditorState();
		this.refreshStatusBar();
		this.syncNativeTableMenuState();
	}

	/**
	 * 表示モードをエディタへ反映する
	 * @param viewMode - 表示モード
	 */
	private applyViewModeToEditor(viewMode: ViewMode): void {
		// マウント済みエディタが無いときは表示を変えられない
		if (!this.editorView) {
			return;
		}

		this.editorView.dispatch({
			effects: setViewModeEffect.of(viewMode)
		});
	}

	/**
	 * アクティブなドキュメントを2ペインに分割する
	 * @param direction - 分割方向
	 */
	private splitActiveView(direction: SplitDirection): void {
		// 分割するタブ。無ければ分割しない
		const tab        = this.getActiveTab();
		// 分割元のペイン。無ければ分割しない
		const sourcePane = this.panes.get(this.activePaneId);
		// タブかペインのどちらかが欠けても分割しない
		if (!tab || !sourcePane) {
			return;
		}

		this.persistActiveEditorState();
		// 新しいペインの ID
		const paneId  = `pane-${crypto.randomUUID()}`;
		// 分割ノードの ID
		const splitId = `split-${crypto.randomUUID()}`;
		// 新しいペインへ渡す本文。表示モードは分割元のペイン側を優先する
		const state   = this.createPaneEditorState(tab, tab.editorState.doc.toString(), sourcePane.viewModes.get(tab.tabId) ?? tab.viewMode);
		// 分割先の実行時ペイン。同じタブの本文と表示を持つ
		this.panes.set(paneId, {
			// 新しいペイン ID
			paneId,
			// 同じタブだけを載せる
			tabIds: [tab.tabId],
			// そのタブを選択状態にする
			activeTabId: tab.tabId,
			// 分割先のエディタ状態
			editorStates: new Map([[tab.tabId, state]]),
			// 分割先の表示モード。ペイン側が無ければタブの値
			viewModes: new Map([[tab.tabId, sourcePane.viewModes.get(tab.tabId) ?? tab.viewMode]])
		});
		this.paneLayout   = splitPane(this.paneLayout, sourcePane.paneId, paneId, splitId, direction);
		this.activePaneId = paneId;
		this.activeTabId  = tab.tabId;
		this.mountActiveEditor();
	}

	/**
	 * アクティブなドキュメントの分割を解除する
	 */
	private unsplitActiveView(): void {
		// 畳むペイン。無ければ何もしない
		const sourcePane = this.panes.get(this.activePaneId);
		// 前面ペインが無いか、ペインが1枚なら畳む先が無い。どちらか一方でも戻る
		if (!sourcePane || this.panes.size <= 1) {
			return;
		}

		this.persistActiveEditorState();
		// 隣のペイン ID。レイアウト上無ければ null
		const targetPaneId = findAdjacentPaneId(this.paneLayout, sourcePane.paneId);
		// 隣の実行時ペイン。ID が無ければ null
		const targetPane   = targetPaneId ? this.panes.get(targetPaneId) : null;
		// 隣が無いときは畳まない
		if (!targetPane) return;

		for (const tabId of sourcePane.tabIds) {
			// 隣に同じタブが無いときだけ追加する
			if (!targetPane.tabIds.includes(tabId)) targetPane.tabIds.push(tabId);
			// 分割元に残っているエディタ状態。無ければ undefined
			const state = sourcePane.editorStates.get(tabId);
			// 状態があるときだけ隣へ写す
			if (state) targetPane.editorStates.set(tabId, state);
			// 分割元の表示モード。無ければ undefined
			const viewMode = sourcePane.viewModes.get(tabId);
			// 表示モードがあるときだけ隣へ写す
			if (viewMode) targetPane.viewModes.set(tabId, viewMode);
		}

		targetPane.activeTabId = sourcePane.activeTabId ?? targetPane.activeTabId;
		this.paneLayout        = removePane(this.paneLayout, sourcePane.paneId) ?? createPaneLayout(targetPane.paneId);
		this.panes.delete(sourcePane.paneId);
		this.activePaneId = targetPane.paneId;
		this.activeTabId  = targetPane.activeTabId;
		this.mountActiveEditor();
		this.refreshStatusBar();
	}

	// ----------------------------------------------
	// タブバーとメニュー
	// ----------------------------------------------

	/**
	 * タブバーを描画する
	 */
	private renderTabBar(): void {
		this.panes.forEach((pane) => {
			// このペインのタブバー。DOM が無いペインは描き直さない
			const tabBar = this.editorHostElement.querySelector<HTMLElement>(`.tms-mde-pane-tab-bar[data-pane-id="${pane.paneId}"]`);
			// タブバー要素が無いペインは描画を飛ばす
			if (!tabBar) return;
			// 描き直す前の横スクロール位置。単位は px。描画後に戻す
			const scrollLeft = tabBar.scrollLeft;
			tabBar.innerHTML = '';
			pane.tabIds.forEach((tabId) => {
				// 並び順に対応するタブ。閉じ済みなら undefined
				const tab = this.tabs.find((entry) => entry.tabId === tabId);
				// タブが残っているときだけ要素を足す
				if (tab) this.renderPaneTab(tabBar, pane, tab);
			});
			tabBar.scrollLeft = scrollLeft;
			// 選択中タブの要素。選択が無ければ null
			const activeTab   = tabBar.querySelector<HTMLElement>('.tms-mde-tab.is-active');
			// 選択中タブがあるときだけ、バー内へ収まる位置まで横スクロールする
			if (activeTab) revealElementInHorizontalScroller(tabBar, activeTab);
		});
	}

	/**
	 * ペインのタブを1件描画する
	 * @param tabBar - タブを足すバー
	 * @param pane - そのタブが属するペイン
	 * @param tab - 描画するタブ
	 */
	private renderPaneTab(tabBar: HTMLElement, pane: PaneRuntime, tab: TabRuntime): void {
		// このペインで選択中のタブか
		const active     = tab.tabId === pane.activeTabId;
		// ドラッグできるタブ要素。選択中なら active クラスの初期値を渡す
		const tabElement = createDraggableTabElement(document, active);

		tabElement.className      = `tms-mde-tab${active ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}`;
		tabElement.dataset.tabId  = tab.tabId;
		tabElement.dataset.paneId = pane.paneId;
		tabElement.title          = tab.filePath ?? tab.title;

		// タブに出す題名
		const title       = document.createElement('span');
		title.className   = 'tms-mde-tab-title';
		title.textContent = tab.title;
		tabElement.appendChild(title);

		// 未保存のときだけ丸印を足す
		if (tab.dirty) {
			// 未保存を示す丸印
			const dot       = document.createElement('span');
			dot.className   = 'tms-mde-tab-dot';
			dot.textContent = '●';
			tabElement.appendChild(dot);
		}

		// 閉じる印。クリックと中クリックでタブを閉じる
		const close     = document.createElement('span');
		close.className = 'tms-mde-tab-close';
		close.setAttribute('aria-label', '閉じる');
		close.textContent = '×';
		tabElement.appendChild(close);

		// タブのクリックで、閉じる印なら閉じ、それ以外ならそのペインで開く
		tabElement.addEventListener('click', (event) => {
			// クリックした要素
			const target = event.target as HTMLElement;
			// 閉じる印のときはタブを切り替えず、そのペインから閉じる
			if (target.classList.contains('tms-mde-tab-close')) {
				void this.closeTab(tab.tabId, pane.paneId);
				return;
			}

			this.activateTab(tab.tabId, pane.paneId, { recordRecent: true });
		});

		// 中クリックで、そのペインのタブを閉じる。他のボタンは何もしない
		tabElement.addEventListener('auxclick', (event) => {
			// 中ボタンのときだけ閉じる
			if (event.button === 1) {
				event.preventDefault();
				void this.closeTab(tab.tabId, pane.paneId);
			}
		});

		// タブを右クリックしたとき、そのペインを前面にしてタブメニューを開く。ブラウザのメニューは出さない
		tabElement.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.activePaneId = pane.paneId;
			this.activeTabId  = tab.tabId;
			this.showTabContextMenu(tab.tabId, event.clientX, event.clientY);
		});

		// ドラッグ開始で、移動元のタブとペインを覚え、移動カーソルにする
		tabElement.addEventListener('dragstart', (event) => {
			this.tabDragSourceId     = tab.tabId;
			this.tabDragSourcePaneId = pane.paneId;
			// dataTransfer があるときだけ、移動とタブ ID を載せる
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('application/x-tms-mde-tab', tab.tabId);
			}
		});
		// ドロップ先が無ければ別ウィンドウへ切り離し、表示とドラッグ状態は必ず消す
		tabElement.addEventListener('dragend', (event) => {
			// どこにも落ちなかったときだけ、新しいウィンドウへ渡す
			if (event.dataTransfer?.dropEffect === 'none') void this.detachTabToNewWindow(tab.tabId, pane.paneId, event.screenX, event.screenY);
			this.clearTabDropIndicators();
			this.tabDragSourceId     = null;
			this.tabDragSourcePaneId = null;
		});

		tabBar.appendChild(tabElement);
	}

	/**
	 * タブバー空白のダブルクリックで無題タブを開く
	 * @param event - ダブルクリック
	 * @param paneId - 対象ペイン
	 * @param tabBar - タブバー
	 */
	private handleTabBarEmptyDoubleClick(event: MouseEvent, paneId: PaneId, tabBar: HTMLElement): void {
		// ダブルクリックの対象。テキストノードのときは Element ではない
		const target                = event.target;
		// タブの上か。タブ上のダブルクリックでは無題タブを開かない
		const onTab                 = target instanceof Element && Boolean(target.closest('.tms-mde-tab'));
		// 新規ボタンの上か。ボタン上ではボタン側の処理に任せる
		const onNewTabButton        = target instanceof Element && Boolean(target.closest('.tms-mde-new-tab-button'));
		// タブバーの画面上の矩形
		const tabBarBox             = tabBar.getBoundingClientRect();
		// 横スクロールバーの上か。バー上のダブルクリックでは無題タブを開かない
		const inHorizontalScrollbar = isPointInHorizontalScrollbar(
			// 判定に渡すタブバーの矩形と中身の高さ。単位は px
			{
				// 左端
				left: tabBarBox.left,
				// 右端
				right: tabBarBox.right,
				// 上端
				top: tabBarBox.top,
				// 下端。スクロールバーを含む
				bottom: tabBarBox.bottom,
				// 中身の高さ。下端との差がスクロールバー
				clientHeight: tabBar.clientHeight
			},
			event.clientX,
			event.clientY
		);
		// タブ上、新規ボタン上、横スクロールバー上のどれかなら無題タブを開かない
		if (!shouldOpenUntitledTabOnTabBarDoubleClick({ onTab, onNewTabButton, inHorizontalScrollbar })) {
			return;
		}

		event.preventDefault();
		this.activePaneId = paneId;
		void this.createNewTab();
	}

	/**
	 * Web / シェルのメニューを閉じる
	 */
	private dismissAllMenus(): void {
		dismissContextMenus();
		void invokeBridge(BRIDGE_METHOD.uiDismissMenus);
	}

	/**
	 * タブコンテキストメニューを表示する
	 * @param tabId - タブ ID
	 * @param x - X 座標
	 * @param y - Y 座標
	 */
	private showTabContextMenu(tabId: string, x: number, y: number): void {
		dismissContextMenus();
		void invokeBridge(BRIDGE_METHOD.uiDismissMenus);

		// メニュー対象のタブ。既に閉じていれば undefined
		const tab      = this.tabs.find((entry) => entry.tabId === tabId);
		// 前面ペイン。無ければ undefined
		const pane     = this.panes.get(this.activePaneId);
		// ペイン内の位置。ペインが無い、またはタブが無いときは -1
		const tabIndex = pane?.tabIds.indexOf(tabId) ?? -1;
		// 設定の並びと、今のタブで押せない項目
		const entries  = this.buildConfiguredContextMenuEntries(
			this.settings.contextMenu.tabOrder,
			this.settings.contextMenu.tabHidden,
			// タブメニューの実行時状態。ショートカットと無効の理由を項目ごとに持つ
			{
				// 表示切替。大きいファイルかタブが無いときは無効。どちらか一方でも押せない
				toggleViewMode: { shortcut: this.settings.keybindings.toggleViewMode, disabled: !tab || tab.largeFile },
				// アウトライン表示
				toggleOutline: { shortcut: this.settings.keybindings.toggleOutline },
				// 上下分割。タブが無いときは無効
				splitHorizontal: { shortcut: this.settings.keybindings.splitHorizontal, disabled: !tab },
				// 左右分割。タブが無いときは無効
				splitVertical: { shortcut: this.settings.keybindings.splitVertical, disabled: !tab },
				// 分割を畳む。ペインが1枚のときは無効
				unsplit: { shortcut: this.settings.keybindings.unsplit, disabled: this.panes.size <= 1 },
				// このタブを閉じる。タブが無いときは無効
				close: { shortcut: this.settings.keybindings.closeTab, disabled: !tab },
				// 他のタブを閉じる。ペインが無いかタブが1枚なら無効。どちらか一方でも押せない
				closeOthers: { disabled: !pane || pane.tabIds.length <= 1 },
				// 右側を閉じる。位置が無いか右端なら無効
				closeRight: { disabled: !pane || tabIndex < 0 || tabIndex >= pane.tabIds.length - 1 },
				// パスをコピー。保存済みパスが無いときは無効
				copyPath: { disabled: !tab?.filePath },
				// フォルダで表示。保存済みパスが無いときは無効
				showInFolder: { disabled: !tab?.filePath }
			}
		);

		showContextMenuAtPoint(x, y, entries, (action) => void this.handleTabContextAction(tabId, action));
	}

	/** 現在のアクティブペインから上部テーブルメニューの活性状態を同期する */
	private syncNativeTableMenuState(): void {
		// 前面タブ。無ければ表メニューはソース扱いで無効側へ寄る
		const tab      = this.getActiveTab();
		// 前面エディタ。未マウントなら null
		const view     = this.editorView;
		// このペインの表示モード。タブが無ければソース
		const viewMode = tab ? (this.panes.get(this.activePaneId)?.viewModes.get(tab.tabId) ?? tab.viewMode) : 'source';

		// 表の中にキャレットがあるときの対象。表の外かエディタが無ければ null
		const snapshot = view ? snapshotActiveTableMenu(view) : null;
		// ネイティブの表メニューへ渡す活性
		const state    = buildTableMenuEnabledState({
			// エディタがマウントされているか
			hasView: view !== null,
			// ライブプレビュー以外では表編集を出さない
			viewMode,
			// 読み取り専用。エディタが無いときは編集不可
			readOnly: view?.state.readOnly ?? true,
			// キャレットが Markdown 表の中か。対象が無ければ false
			inMarkdownTable: snapshot?.inMarkdownTable ?? false,
			// 行・列の操作対象。表の外では null
			structure: snapshot?.structure ?? null,
			// 結合と揃えの対象。表の外では null
			cells: snapshot?.merge ?? null
		});

		// 直前と同じ活性ならブリッジを呼ばない
		const json = JSON.stringify(state);
		// 前回送った JSON と同じときは、メニューを更新しない
		if (json === this.lastTableMenuStateJson) return;
		this.lastTableMenuStateJson = json;
		void invokeBridge(BRIDGE_METHOD.uiUpdateTableMenuState, state).catch(() => undefined);
	}

	/**
	 * ネイティブのテーブルメニューから、右クリックと共通の処理を実行する
	 * @param action - ネイティブメニューから届いた表操作
	 */
	private async handleNativeTableMenuAction(action: TableMenuAction): Promise<void> {
		// 表を編集するタブ。無ければ何もしない
		const tab  = this.getActiveTab();
		// 前面エディタ。無ければ何もしない
		const view = this.editorView;
		// タブかエディタのどちらかが欠けても表は編集しない
		if (!tab || !view) return;
		// このペインの表示モード。ペイン側が無ければタブの値
		const viewMode = this.panes.get(this.activePaneId)?.viewModes.get(tab.tabId) ?? tab.viewMode;
		// 今のキャレット位置にある表の対象
		const snapshot = snapshotActiveTableMenu(view);
		// その操作が今押せるか
		const enabled  = buildTableMenuEnabledState({
			// この分岐ではエディタがある
			hasView: true,
			// ライブプレビュー以外では表編集を無効にする
			viewMode,
			// 読み取り専用なら表は編集しない
			readOnly: view.state.readOnly,
			// キャレットが Markdown 表の中か
			inMarkdownTable: snapshot.inMarkdownTable,
			// 行・列の操作対象。表の外では null
			structure: snapshot.structure,
			// 結合と揃えの対象。表の外では null
			cells: snapshot.merge
		});
		// 今の状態で押せない操作は実行しない
		if (!enabled[action]) return;

		await this.handleEditorContextAction(action, action === 'insertTable' ? view.state.selection.main.head : null, null, snapshot.merge, snapshot.structure);
		this.syncNativeTableMenuState();
	}

	/**
	 * エディタコンテキストメニューを表示する
	 * @param event - 右クリックイベント
	 */
	private showEditorContextMenu(event: MouseEvent): void {
		dismissContextMenus();
		void invokeBridge(BRIDGE_METHOD.uiDismissMenus);

		// メニュー対象のタブ。無ければ一部の項目を無効にする
		const tab             = this.getActiveTab();
		// 前面エディタ。無ければ編集項目は無効
		const view            = this.editorView;
		// 右クリックした文書位置。座標が本文の外なら null
		const clickPosition   = view?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
		// その位置のチェックボックス切替。ビューか位置が無ければ null。どちらか一方が欠けても作らない
		const checkboxAction  = view && clickPosition !== null ? buildToggleTaskMarkerTransaction(view.state, clickPosition) : null;
		// 右クリックした Markdown リンクの URL。リンクでなければ null
		const linkUrl         = view ? findMarkdownLinkUrlFromMouseEvent(view, event) : null;
		// 空でない選択があるか。エディタが無ければ false
		const hasSelection    = Boolean(view && view.state.selection.ranges.some((range) => !range.empty));
		// 右クリック位置の結合対象。表の外では null
		const tableMerge      = view ? snapshotTableMergeActionFromEvent(view, event) : null;
		// 右クリック位置の行・列対象。表の外では null
		const tableStructure  = view ? snapshotTableStructureActionFromEvent(view, event) : null;
		// このペインの表示モード。タブが無ければソース
		const viewMode        = tab ? (this.panes.get(this.activePaneId)?.viewModes.get(tab.tabId) ?? tab.viewMode) : 'source';
		// クリックが表ウィジェットの中か。要素でなければ false
		const inMarkdownTable = event.target instanceof Element && Boolean(event.target.closest('.cm-md-table-wrap'));
		// 設定の並びと、右クリック位置で出せない項目
		const entries         = this.buildConfiguredContextMenuEntries(
			this.settings.contextMenu.editorOrder,
			this.settings.contextMenu.editorHidden,
			// 編集メニューの実行時状態。隠す条件と無効の理由を項目ごとに持つ
			{
				// 元に戻す。エディタが無いか履歴が空なら無効。どちらか一方でも押せない
				undo: { shortcut: 'Ctrl+Z', disabled: !view || undoDepth(view.state) === 0 },
				// やり直す。エディタが無いかやり直しが空なら無効。どちらか一方でも押せない
				redo: { shortcut: 'Ctrl+Y', disabled: !view || redoDepth(view.state) === 0 },
				// 切り取り。エディタが無い、読み取り専用、選択が空のどれかなら無効
				cut: { shortcut: 'Ctrl+X', disabled: !view || view.state.readOnly || !hasSelection },
				// コピー。選択が空なら無効
				copy: { shortcut: 'Ctrl+C', disabled: !hasSelection },
				// 貼り付け。エディタが無いか読み取り専用なら無効。どちらか一方でも押せない
				paste: { shortcut: 'Ctrl+V', disabled: !view || view.state.readOnly },
				// 書式なし貼り付け。エディタが無いか読み取り専用なら無効。どちらか一方でも押せない
				pastePlain: { shortcut: this.settings.keybindings.pastePlain ?? 'Ctrl+Shift+V', disabled: !view || view.state.readOnly },
				// すべて選択。エディタが無いか本文が空なら無効。どちらか一方でも押せない
				selectAll: { shortcut: 'Ctrl+A', disabled: !view || view.state.doc.length === 0 },
				// 検索。エディタが無いときは無効
				find: { shortcut: this.settings.keybindings.find, disabled: !view },
				// 置換。エディタが無いか読み取り専用なら無効。どちらか一方でも押せない
				replace: { shortcut: this.settings.keybindings.replace, disabled: !view || view.state.readOnly },
				// チェック切替。対象行でなければ隠す
				toggleCheckbox: { shortcut: this.settings.keybindings.toggleCheckbox, hidden: !checkboxAction },
				// 表の挿入。ライブプレビュー以外か、既に表の中では隠す。どちらか一方でも出さない
				insertTable: { hidden: viewMode !== 'live-preview' || inMarkdownTable, disabled: !view || view.state.readOnly },
				// 行を上へ挿入。行対象でなければ隠す
				insertTableRowsBefore: { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly },
				// 行を下へ挿入。行対象でなければ隠す
				insertTableRowsAfter: { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly },
				// 行を削除。行対象でなければ隠し、削除できない位置は無効
				deleteTableRows: { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly || !tableStructure?.canDelete },
				// 行を上へ移動。行対象でなければ隠し、先頭では無効
				moveTableRowsUp: { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly || !tableStructure?.canMovePrevious },
				// 行を下へ移動。行対象でなければ隠し、末尾では無効
				moveTableRowsDown: { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly || !tableStructure?.canMoveNext },
				// 列を左へ挿入。列対象でなければ隠す
				insertTableColumnsBefore: { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly },
				// 列を右へ挿入。列対象でなければ隠す
				insertTableColumnsAfter: { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly },
				// 列を削除。列対象でなければ隠し、削除できない位置は無効
				deleteTableColumns: { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly || !tableStructure?.canDelete },
				// 列を左へ移動。列対象でなければ隠し、左端では無効
				moveTableColumnsLeft: { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly || !tableStructure?.canMovePrevious },
				// 列を右へ移動。列対象でなければ隠し、右端では無効
				moveTableColumnsRight: { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly || !tableStructure?.canMoveNext },
				// セル結合。結合できない選択では隠す
				mergeTableCells: { hidden: !tableMerge?.canMerge, disabled: !view || view.state.readOnly },
				// 結合解除。結合セルでなければ隠す
				unmergeTableCells: { hidden: !tableMerge?.canUnmerge, disabled: !view || view.state.readOnly },
				// 左揃え。表の外では隠す
				alignTableCellLeft: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				// 中央揃え。表の外では隠す
				alignTableCellCenter: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				// 右揃え。表の外では隠す
				alignTableCellRight: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				// 上揃え。表の外では隠す
				valignTableCellTop: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				// 上下中央。表の外では隠す
				valignTableCellMiddle: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				// 下揃え。表の外では隠す
				valignTableCellBottom: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				// リンクを開く。対応 URL でなければ隠す
				openLink: { hidden: !linkUrl || !isSupportedExternalLinkUrl(linkUrl) },
				// 見出しをすべて折りたたむ。折りたためる見出しが無ければ無効
				collapseAllHeadings: { disabled: !view || !hasFoldableHeadings(view.state) },
				// 見出しをすべて展開する。折りたたみ中が無ければ無効
				expandAllHeadings: { disabled: !view || !hasCollapsedHeadings(view.state) },
				// 表示切替。大きいファイルかタブが無いときは無効。どちらか一方でも押せない
				toggleViewMode: { shortcut: this.settings.keybindings.toggleViewMode, disabled: !tab || tab.largeFile },
				// アウトライン表示
				toggleOutline: { shortcut: this.settings.keybindings.toggleOutline },
				// 上下分割。タブが無いときは無効
				splitHorizontal: { shortcut: this.settings.keybindings.splitHorizontal, disabled: !tab },
				// 左右分割。タブが無いときは無効
				splitVertical: { shortcut: this.settings.keybindings.splitVertical, disabled: !tab },
				// 分割を畳む。ペインが1枚のときは無効
				unsplit: { shortcut: this.settings.keybindings.unsplit, disabled: this.panes.size <= 1 }
			}
		);

		showContextMenuAtPoint(event.clientX, event.clientY, entries, (action) => {
			void this.handleEditorContextAction(action, clickPosition, linkUrl, tableMerge, tableStructure);
		});
	}

	/**
	 * エディタ本文への貼り付けを処理する
	 * @param event - 貼り付けイベント
	 * @param view - エディタ
	 * @returns 処理したか
	 */
	private handleEditorPaste(event: ClipboardEvent, view: EditorView): boolean {
		// 読み取り専用か、表や検索などエディタ本文以外の貼り付けでは捕捉しない。どちらか一方でもブラウザへ返す
		if (view.state.readOnly || shouldSkipEditorPasteCapture(event)) {
			return false;
		}

		event.preventDefault();
		// 書式なし貼り付けのショートカット中は、ここでスマート貼り付けを重ねない
		if (this.suppressSmartPaste) {
			return true;
		}

		void this.pasteIntoEditor(view, 'smart');
		return true;
	}

	/**
	 * クリップボード内容を本文へ挿入する
	 * @param view - エディタ
	 */
	private async pasteIntoEditor(view: EditorView, mode: 'smart' | 'plain' = 'smart'): Promise<void> {
		// 読み取り専用の本文には貼らない
		if (view.state.readOnly) {
			return;
		}

		try {
			// シェルが整形した貼り付け結果。失敗時は ok が false
			const result = await invokeBridge<PasteForEditorResult>(BRIDGE_METHOD.clipboardPasteForEditor, { mode });
			// シェルが失敗を返したときは、理由があればそれを出す
			if (!result.ok) {
				showToast(result.error ?? '貼り付けに失敗しました。');
				return;
			}

			// 空のクリップボードは本文を変えない
			if (!result.text) {
				return;
			}

			view.dispatch({ ...view.state.replaceSelection(result.text), userEvent: 'input.paste' });
		} catch (error) {
			showToast(`貼り付けに失敗しました: ${this.formatError(error)}`);
		}
	}

	/**
	 * 保存設定の順序・表示状態へ実行時状態を重ね、描画項目を生成する
	 * @param order - 項目順
	 * @param hiddenItems - 非表示項目ID
	 * @param overrides - 実行時状態
	 * @returns 描画項目
	 */
	private buildConfiguredContextMenuEntries(order: string[], hiddenItems: string[], overrides: Record<string, Omit<ContextMenuEntry, 'id' | 'label'>>): ContextMenuEntry[] {
		// 設定で隠す項目 ID
		const hidden = new Set(hiddenItems);
		// 並び順どおりの描画項目。実行時の活性は overrides で上書きする
		return order.map((itemId) => ({
			// 設定順の項目 ID
			id: itemId,
			// 表示名。未知の ID はその文字列のまま出す
			label: CONTEXT_MENU_ITEM_LABELS[itemId] ?? itemId,
			// 設定で隠す項目か
			hidden: hidden.has(itemId),
			// 区切り線の項目か
			separator: isContextMenuSeparator(itemId),
			...overrides[itemId]
		}));
	}

	/**
	 * エディタの右クリックコマンドを実行する
	 * @param action - コマンドID
	 * @param clickPosition - 右クリックした文書位置
	 * @param linkUrl - 右クリックしたリンクURL
	 * @param tableMerge - 右クリック時点の表対象
	 * @param tableStructure - 右クリック時点の行・列対象
	 */
	private async handleEditorContextAction(action: string, clickPosition: number | null, linkUrl: string | null, tableMerge?: TableMergeMenuSnapshot | null, tableStructure?: TableStructureMenuSnapshot | null): Promise<void> {
		// コマンドを実行するエディタ。未マウントなら何もしない
		const view = this.editorView;
		// エディタが無いときは右クリック操作を実行できない
		if (!view) {
			return;
		}

		try {
			// 元に戻すとやり直しは、履歴操作だけして本文コマンドへ進まない
			if (action === 'undo' || action === 'redo') {
				(action === 'undo' ? undo : redo)(view);
				view.focus();
				return;
			}

			// コピーと切り取りは、選択文字列をクリップボードへ書く
			if (action === 'copy' || action === 'cut') {
				// 選択範囲を連結した文字列。空の選択は空文字
				const text = view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to)).join(view.state.lineBreak);
				await invokeBridge(BRIDGE_METHOD.clipboardWriteText, { text });
				// 切り取りのときだけ、選択を本文から消す
				if (action === 'cut') {
					view.dispatch({ ...view.state.replaceSelection(''), userEvent: 'delete.cut' });
				}
				view.focus();
				return;
			}

			// 貼り付けと書式なし貼り付けは、モードだけ変えて同じ挿入を使う
			if (action === 'paste' || action === 'pastePlain') {
				await this.pasteIntoEditor(view, action === 'pastePlain' ? 'plain' : 'smart');
				view.focus();
				return;
			}

			// 本文全体を選択する
			if (action === 'selectAll') {
				selectAll(view);
				view.focus();
				return;
			}

			// 検索か置換のパネルを開く。置換は読み取り専用側で既に無効
			if (action === 'find' || action === 'replace') {
				this.openActiveSearchPanel(action);
				return;
			}

			// 表を挿入する。ダイアログを閉じたら何も入れない
			if (action === 'insertTable') {
				// 列数とデータ行数。キャンセルなら null
				const options = await showInsertTableDialog();
				// キャンセルされたら表は入れず、フォーカスだけ戻す
				if (!options) {
					view.focus();
					return;
				}
				// 挿入する Markdown の表
				const markdown = createMarkdownTable(options.columns, options.dataRows);
				// 挿入位置。右クリック位置が無ければキャレット。文書長を超えない
				const position = Math.min(clickPosition ?? view.state.selection.main.head, view.state.doc.length);
				// 表の挿入を入力操作として記録する
				view.dispatch({
					// その位置へ表を入れる変更
					changes: buildTableInsertionChange(view.state, position, markdown),
					// 入力として履歴に残す
					userEvent: 'input.type'
				});
				view.focus();
				return;
			}

			// 行・列の挿入、削除、移動。表メニュー以外の操作では null
			const structureAction = tableStructureActionFromContextMenu(action);
			// 行・列操作であり、右クリック時の対象が残っているときだけ適用する。どちらか一方が欠けても進まない
			if (structureAction && tableStructure) {
				// 適用できなかったときはフォーカスだけ戻す
				if (!applyTableStructureSnapshot(view, tableStructure, structureAction)) view.focus();
				return;
			}

			// 結合か結合解除であり、右クリック時のセル対象があるときだけ適用する。どちらか一方が欠けても進まない
			if ((action === 'mergeTableCells' || action === 'unmergeTableCells') && tableMerge) {
				// 適用できなかったときはフォーカスだけ戻す
				if (!applyTableMergeSnapshot(view, tableMerge, action === 'mergeTableCells' ? 'merge' : 'unmerge')) {
					view.focus();
				}
				return;
			}

			// 横揃えか縦揃えの差分。表メニュー以外の操作では null
			const alignPatch = tableAlignPatchFromAction(action);
			// 揃え操作であり、右クリック時のセル対象があるときだけ適用する。どちらか一方が欠けても進まない
			if (alignPatch && tableMerge) {
				// 適用できなかったときはフォーカスだけ戻す
				if (!applyTableAlignSnapshot(view, tableMerge, alignPatch)) {
					view.focus();
				}
				return;
			}

			// チェック切替であり、右クリック位置があるときだけ印を反転する。どちらか一方が欠けても進まない
			if (action === 'toggleCheckbox' && clickPosition !== null) {
				// タスク印を反転するトランザクション。対象行でなければ null
				const spec = buildToggleTaskMarkerTransaction(view.state, Math.min(clickPosition, view.state.doc.length));
				// 対象行のときだけ印を変える
				if (spec) {
					view.dispatch(spec);
				}
				view.focus();
				return;
			}

			// 対応する外部 URL のときだけ開く。リンク、URL、対応スキームのどれか一つが欠けても開かない
			if (action === 'openLink' && linkUrl && isSupportedExternalLinkUrl(linkUrl)) {
				await invokeBridge(BRIDGE_METHOD.shellOpenExternal, { url: linkUrl });
				return;
			}

			// 折りたためる見出しをすべて閉じる
			if (action === 'collapseAllHeadings') {
				collapseAllHeadings(view);
				view.focus();
				return;
			}

			// 折りたたんだ見出しをすべて開く
			if (action === 'expandAllHeadings') {
				expandAllHeadings(view);
				view.focus();
				return;
			}

			// ライブプレビューとソースを切り替える
			if (action === 'toggleViewMode') {
				this.toggleActiveTabViewMode();
				// アウトラインの表示を切り替える
			} else if (action === 'toggleOutline') {
				this.toggleOutline();
				// 上下か左右に分割する。どちらでもない操作はこの分岐に入らない
			} else if (action === 'splitHorizontal' || action === 'splitVertical') {
				this.splitActiveView(action === 'splitHorizontal' ? 'horizontal' : 'vertical');
				// 分割を畳む
			} else if (action === 'unsplit') {
				this.unsplitActiveView();
			}
		} catch (error) {
			showErrorMessage(this.formatError(error));
		}
	}

	/**
	 * タブコンテキストメニュー操作を処理する
	 * @param tabId - タブ ID
	 * @param action - アクション ID
	 */
	private async handleTabContextAction(tabId: string, action: string): Promise<void> {
		// 操作するタブ。既に閉じていれば undefined
		const tab  = this.tabs.find((entry) => entry.tabId === tabId);
		// 前面ペイン。無ければ操作できない
		const pane = this.panes.get(this.activePaneId);
		// タブかペインのどちらかが欠けてもメニュー操作は実行しない
		if (!tab || !pane) {
			return;
		}

		// そのタブを前面にしてから表示モードを切り替える
		if (action === 'toggleViewMode') {
			this.activateTab(tabId, this.activePaneId, { recordRecent: true });
			this.toggleActiveTabViewMode();
			return;
		}

		// アウトラインの表示を切り替える。タブの選択は変えない
		if (action === 'toggleOutline') {
			this.toggleOutline();
			return;
		}

		// そのタブを前面にしてから上下か左右に分割する。どちらでもない操作はこの分岐に入らない
		if (action === 'splitHorizontal' || action === 'splitVertical') {
			this.activateTab(tabId, this.activePaneId, { recordRecent: true });
			this.splitActiveView(action === 'splitHorizontal' ? 'horizontal' : 'vertical');
			return;
		}

		// そのタブを前面にしてから分割を畳む
		if (action === 'unsplit') {
			this.activateTab(tabId, this.activePaneId, { recordRecent: true });
			this.unsplitActiveView();
			return;
		}

		// このタブを閉じる
		if (action === 'close') {
			await this.closeTab(tabId);
			return;
		}

		// このタブ以外を閉じる。保存確認で残したタブがあればそこで止める
		if (action === 'closeOthers') {
			for (const otherTabId of [...pane.tabIds]) {
				// 操作中のタブは残す
				if (otherTabId !== tabId) {
					// 閉じられたか。保存確認でキャンセルなら false
					const closed = await this.closeTab(otherTabId, pane.paneId);
					// キャンセルされたら残りのタブは閉じない
					if (!closed) {
						break;
					}
				}
			}

			return;
		}

		// このタブより右を閉じる。保存確認で残したタブがあればそこで止める
		if (action === 'closeRight') {
			// このタブの位置。見つからなければ -1 で、右は空になる
			const index = pane.tabIds.indexOf(tabId);
			for (const otherTabId of pane.tabIds.slice(index + 1)) {
				// 閉じられたか。保存確認でキャンセルなら false
				const closed = await this.closeTab(otherTabId, pane.paneId);
				// キャンセルされたらさらに右は閉じない
				if (!closed) {
					break;
				}
			}

			return;
		}

		// 保存済みパスをクリップボードへ書く。未保存は空文字
		if (action === 'copyPath') {
			await invokeBridge(BRIDGE_METHOD.clipboardWriteText, { text: tab.filePath ?? '' });
			return;
		}

		// 保存済みパスがあるときだけ、エクスプローラーでそのファイルを表示する。パスが無ければ何もしない
		if (action === 'showInFolder' && tab.filePath) {
			await invokeBridge(BRIDGE_METHOD.shellShowInFolder, { filePath: tab.filePath });
		}
	}

	/**
	 * タブを同一ペイン内で並べ替えるか、別ペインへ移動する
	 * @param sourceTabId - 動かすタブ ID
	 * @param sourcePaneId - 移動元ペイン
	 * @param targetPaneId - 移動先ペイン
	 * @param targetIndex - 移動先での位置。省略時は末尾
	 */
	private moveOrReorderTab(sourceTabId: string, sourcePaneId: PaneId, targetPaneId: PaneId, targetIndex?: number): void {
		// 移動元ペイン。無ければ動かさない
		const sourcePane = this.panes.get(sourcePaneId);
		// 移動先ペイン。無ければ動かさない
		const targetPane = this.panes.get(targetPaneId);
		// 移動元か移動先のどちらかが欠けてもタブは動かさない
		if (!sourcePane || !targetPane) return;
		// 移動元での位置。既に無ければ -1
		const sourceIndex = sourcePane.tabIds.indexOf(sourceTabId);
		// 移動元にタブが残っていないときは何もしない
		if (sourceIndex < 0) return;

		sourcePane.tabIds.splice(sourceIndex, 1);
		// 移動先に同じタブが既にある位置。無ければ -1
		const existingIndex = targetPane.tabIds.indexOf(sourceTabId);
		// 移動先に重複があるときだけ、先に取り除く
		if (existingIndex >= 0) targetPane.tabIds.splice(existingIndex, 1);
		// 挿入位置。省略時は末尾。範囲外は 0 から末尾へ収める。単位は添字
		const insertionIndex = targetIndex === undefined ? targetPane.tabIds.length : Math.min(Math.max(targetIndex, 0), targetPane.tabIds.length);
		targetPane.tabIds.splice(insertionIndex, 0, sourceTabId);
		// 移動元に残っているエディタ状態。無ければ undefined
		const state = sourcePane.editorStates.get(sourceTabId);
		// 状態があるときだけ移動先へ写す
		if (state) targetPane.editorStates.set(sourceTabId, state);
		// 移動元の表示モード。無ければ undefined
		const viewMode = sourcePane.viewModes.get(sourceTabId);
		// 表示モードがあるときだけ移動先へ写す
		if (viewMode) targetPane.viewModes.set(sourceTabId, viewMode);
		sourcePane.editorStates.delete(sourceTabId);
		sourcePane.viewModes.delete(sourceTabId);
		targetPane.activeTabId = sourceTabId;

		// 移動元の選択が動いたタブなら、残った先頭を選択する。残らなければ null
		if (sourcePane.activeTabId === sourceTabId) sourcePane.activeTabId = sourcePane.tabIds[0] ?? null;
		// 移動元が空になり、他のペインが残っているときだけ、そのペインをレイアウトから外す。どちらか一方では外さない
		if (sourcePane.tabIds.length === 0 && this.panes.size > 1) {
			this.paneLayout = removePane(this.paneLayout, sourcePaneId) ?? createPaneLayout(targetPaneId);
			this.panes.delete(sourcePaneId);
		}
		this.activePaneId = targetPaneId;
		this.activeTabId  = sourceTabId;
		this.mountActiveEditor();
	}

	/**
	 * タブを指定ペインのコンテンツ領域へ分割配置する
	 * @param tab - 新しいペインへ置くタブ
	 * @param targetPaneId - 分割する側のペイン
	 * @param placement - ドロップ位置から決めた分割方向
	 * @param sourcePaneId - 移動元ペイン。同一ペインの分割では省略できる
	 */
	private splitTabIntoNewPane(tab: TabRuntime, targetPaneId: PaneId, placement: PaneDropPlacement, sourcePaneId?: PaneId): void {
		// 分割する側のペイン。無ければ分けない
		const targetPane = this.panes.get(targetPaneId);
		// ドラッグ元のペイン。別ウィンドウ由来などで ID が無ければ null
		const sourcePane = sourcePaneId ? this.panes.get(sourcePaneId) : null;
		// 分割先が無いか、移動元 ID があるのにペインが無いときは分けない。どちらの欠けでも戻る
		if (!targetPane || (sourcePaneId && !sourcePane)) return;

		this.persistActiveEditorState();
		// 新しいペインの ID
		const paneId   = `pane-${crypto.randomUUID()}`;
		// 分割ノードの ID
		const splitId  = `split-${crypto.randomUUID()}`;
		// 新しいペインの表示モード。移動元が無ければタブの値
		const viewMode = sourcePane?.viewModes.get(tab.tabId) ?? tab.viewMode;
		// 新しいペインの本文。移動元に状態が無ければ作り直す
		const state    = sourcePane?.editorStates.get(tab.tabId) ?? this.createPaneEditorState(tab, tab.editorState.doc.toString(), viewMode);
		// 分割で増やす実行時ペイン
		this.panes.set(paneId, {
			// 新しいペイン ID
			paneId,
			// ドラッグしたタブだけを載せる
			tabIds: [tab.tabId],
			// そのタブを選択状態にする
			activeTabId: tab.tabId,
			// 新しいペインのエディタ状態
			editorStates: new Map([[tab.tabId, state]]),
			// 新しいペインの表示モード
			viewModes: new Map([[tab.tabId, viewMode]])
		});
		this.paneLayout = splitPane(this.paneLayout, targetPaneId, paneId, splitId, placement.direction, placement.newPanePosition);

		// 同じウィンドウ内の移動元があるときだけ、元の並びからタブを外す
		if (sourcePane) {
			// 移動元がそのペインの最後の1枚か。最後の1枚はビューを残す
			const keepOriginalView = sourcePane.paneId === targetPaneId && sourcePane.tabIds.length === 1;
			// 最後の1枚でないときだけ、移動元からタブと状態を外す
			if (!keepOriginalView) {
				sourcePane.tabIds = sourcePane.tabIds.filter((tabId) => tabId !== tab.tabId);
				sourcePane.editorStates.delete(tab.tabId);
				sourcePane.viewModes.delete(tab.tabId);
				// 外したタブが選択中なら、残った先頭を選ぶ。残らなければ null
				if (sourcePane.activeTabId === tab.tabId) sourcePane.activeTabId = sourcePane.tabIds[0] ?? null;
			}
			// 移動元が空になったら、そのペインをレイアウトから外す
			if (sourcePane.tabIds.length === 0) {
				this.paneLayout = removePane(this.paneLayout, sourcePane.paneId) ?? createPaneLayout(paneId);
				this.panes.delete(sourcePane.paneId);
			}
		}

		this.activePaneId = paneId;
		this.activeTabId  = tab.tabId;
		this.mountActiveEditor();
		this.refreshStatusBar();
	}

	/** タブの分割ドロップ表示を消去する */
	private clearTabDropIndicators(): void {
		this.editorHostElement.querySelectorAll<HTMLElement>('.tms-mde-editor-pane[data-tab-drop-zone]').forEach((pane) => delete pane.dataset.tabDropZone);
		this.editorHostElement.querySelectorAll<HTMLElement>('.tms-mde-pane-editor-surface.is-tab-drag-over').forEach((surface) => surface.classList.remove('is-tab-drag-over'));
		this.editorHostElement.querySelectorAll<HTMLElement>('.tms-mde-pane-tab-bar[data-tab-drop-index]').forEach((tabBar) => delete tabBar.dataset.tabDropIndex);
		this.editorHostElement.querySelectorAll<HTMLElement>('.tms-mde-tab.is-tab-drop-before, .tms-mde-tab.is-tab-drop-after').forEach((tab) => tab.classList.remove('is-tab-drop-before', 'is-tab-drop-after'));
	}

	/**
	 * タブバー上のマウス位置から、ドラッグ元を除去した後の挿入位置を算出する
	 * @param tabBar - 位置を測るタブバー
	 * @param clientX - ビューポート上のマウス X
	 * @param excludedTabId - 幅の計算から除くドラッグ中のタブ。別ペインから来たときは省略
	 * @returns ドラッグ元を除いたあとの挿入位置。0 が先頭
	 */
	private calculateTabBarDropIndex(tabBar: HTMLElement, clientX: number, excludedTabId?: string): number {
		// 幅の計算から除いたタブ要素。ドラッグ元を除く
		const tabs = [...tabBar.querySelectorAll<HTMLElement>('.tms-mde-tab')].filter((element) => element.dataset.tabId !== excludedTabId);
		return calculateTabDropIndex(
			tabs.map((element) => element.getBoundingClientRect()),
			clientX
		);
	}

	/**
	 * タブバーへ挿入位置マーカーを表示する
	 * @param tabBar - マーカーを出すタブバー
	 * @param paneId - そのタブバーのペイン
	 * @param clientX - ビューポート上のマウス X
	 * @returns マーカーを置いた挿入位置。0 が先頭
	 */
	private showTabBarDropIndicator(tabBar: HTMLElement, paneId: PaneId, clientX: number): number {
		this.clearTabDropIndicators();
		// 同じペイン内のドラッグなら、そのタブを幅の計算から除く。別ペインなら undefined
		const excludedTabId         = this.tabDragSourcePaneId === paneId ? (this.tabDragSourceId ?? undefined) : undefined;
		// 挿入位置の計算に使うタブ。ドラッグ元は除く
		const tabs                  = [...tabBar.querySelectorAll<HTMLElement>('.tms-mde-tab')].filter((element) => element.dataset.tabId !== excludedTabId);
		// マウス位置の挿入添字。0 が先頭
		const targetIndex           = calculateTabDropIndex(
			tabs.map((element) => element.getBoundingClientRect()),
			clientX
		);
		tabBar.dataset.tabDropIndex = String(targetIndex);
		// 途中へ入れるときは、そのタブの左に印を出す
		if (targetIndex < tabs.length) tabs[targetIndex].classList.add('is-tab-drop-before');
		else tabs.at(-1)?.classList.add('is-tab-drop-after');
		return targetIndex;
	}

	/**
	 * ウィンドウ外へドロップされたタブを新しいプロセスへ引き渡す
	 * @param tabId - 新しいウィンドウへ渡すタブ
	 * @param paneId - そのタブがいたペイン
	 * @param screenX - 新しいウィンドウの画面 X
	 * @param screenY - 新しいウィンドウの画面 Y
	 */
	private async detachTabToNewWindow(tabId: string, paneId: PaneId, screenX: number, screenY: number): Promise<void> {
		// 引き渡すタブ。既に閉じていれば何もしない
		const tab = this.tabs.find((entry) => entry.tabId === tabId);
		// タブが残っていないときは新しいウィンドウを作らない
		if (!tab) return;
		this.persistActiveEditorState();
		try {
			// 新しいプロセスがタブを受け取ったか。失敗時は catch へ落ちる
			const result = await invokeBridge<{ detached: boolean }>(BRIDGE_METHOD.windowDetachTab, {
				// 新しいウィンドウの画面 X。単位は px
				screenX,
				// 新しいウィンドウの画面 Y。単位は px
				screenY,
				// 引き渡すタブの本文と保存状態
				tab: {
					// タブの題名
					title: tab.title,
					// 保存済みパス。未保存は null
					filePath: tab.filePath,
					// 今の本文
					text: tab.editorState.doc.toString(),
					// 最後に保存した本文。未保存の比較に使う
					savedText: tab.savedText,
					// 保存に使う文字コード
					encoding: tab.encoding,
					// 代表の改行
					eol: tab.eol,
					// 行ごとに改行が混在しているか
					eolMixed: tab.eolMixed,
					// 未保存か
					dirty: tab.dirty,
					// 大きいファイルとしてソース固定か
					largeFile: tab.largeFile,
					// このペインの表示モード。ペイン側が無ければタブの値
					viewMode: this.panes.get(paneId)?.viewModes.get(tabId) ?? tab.viewMode,
					// 行ごとの改行。空配列は後で読み直す対象ではない
					lineEols: tab.lineEols
				}
			});
			// 受け取りに成功したときだけ、このウィンドウからタブを外す
			if (result.detached) await this.closeTab(tabId, paneId, true, true);
		} catch (error) {
			showErrorMessage(`タブを別ウィンドウへ移動できませんでした: ${this.formatError(error)}`);
		}
	}

	// ----------------------------------------------
	// エディタの配置
	// ----------------------------------------------

	/**
	 * アクティブエディタをマウントする
	 */
	private mountActiveEditor(): void {
		this.editorViews.forEach((view) => view.destroy());
		this.editorViews.clear();
		this.editorView                  = null;
		this.editorHostElement.innerHTML = '';
		this.editorHostElement.appendChild(this.renderPaneLayoutNode(this.paneLayout));
		this.renderTabBar();
		this.activatePane(this.activePaneId);
		this.renderOutline();
		this.applyEditorZoom();
	}

	/**
	 * 分割ツリーをDOMへ変換する
	 * @param node - 描画する分割木の節
	 * @returns その節に対応する要素
	 */
	private renderPaneLayoutNode(node: PaneLayoutNode): HTMLElement {
		// 葉のペインはホスト要素だけを返す
		if (node.kind === 'pane') return this.createPaneHost(node.paneId);

		// 二つに分けるコンテナー
		const container           = document.createElement('div');
		container.className       = `tms-mde-pane-split is-${node.direction}`;
		container.dataset.splitId = node.splitId;
		// 前側の子
		const first               = this.renderPaneLayoutNode(node.first);
		// 比率を変える境界
		const divider             = this.createSplitDivider(node, container);
		// 後側の子
		const second              = this.renderPaneLayoutNode(node.second);
		container.append(first, divider, second);
		this.applySplitRatio(node, container);
		return container;
	}

	/**
	 * エディタペインとペイン固有タブバーを生成する
	 * @param paneId - ホストを作るペイン
	 * @returns タブバーと編集面を含むペイン要素
	 */
	private createPaneHost(paneId: PaneId): HTMLElement {
		// 描画するペイン。ID が無ければ例外にする
		const pane = this.panes.get(paneId);
		// レイアウトにあるのに実行時ペインが無いときは、壊れた状態として止める
		if (!pane) throw new Error(`ペインが見つかりません: ${paneId}`);

		// タブバーと編集面を含むペイン要素
		const host            = document.createElement('section');
		host.className        = 'tms-mde-editor-pane';
		host.dataset.paneId   = paneId;
		// タブバーと新規ボタンの枠
		const tabWrap         = document.createElement('div');
		tabWrap.className     = 'tms-mde-pane-tab-bar-wrap';
		// このペインのタブを並べるバー
		const tabBar          = document.createElement('div');
		tabBar.className      = 'tms-mde-pane-tab-bar';
		tabBar.dataset.paneId = paneId;
		// 横ホイールでタブバーを横スクロールする。縦スクロールに使うホイールはブラウザに任せる
		tabBar.addEventListener(
			'wheel',
			(event) => {
				// 横スクロールとして消費できたときだけ、ページのスクロールを止める
				if (applyTabBarWheelScroll(tabBar, event)) event.preventDefault();
			},
			{ passive: false }
		);
		// タブをドラッグ中だけ、バー上の挿入位置を示す。ドラッグ外は何もしない
		tabBar.addEventListener('dragover', (event) => {
			// タブのドラッグでなければ挿入位置を出さない
			if (!this.tabDragSourceId) return;
			event.preventDefault();
			// dataTransfer があるときだけ移動カーソルにする
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			this.showTabBarDropIndicator(tabBar, paneId, event.clientX);
		});
		// バーの外へ出たとき、挿入位置の表示を消す。子要素への移動では消さない
		tabBar.addEventListener('dragleave', (event) => {
			// バーの中の子へ移っただけなら表示を残す
			if (event.relatedTarget instanceof Node && tabBar.contains(event.relatedTarget)) return;
			this.clearTabDropIndicators();
		});
		// タブバーへ落とされたタブを、その位置へ並べ替える
		tabBar.addEventListener('drop', (event) => {
			event.preventDefault();
			event.stopPropagation();
			// 表示していた挿入位置。属性が無いときは NaN で、下ではマウス位置から取り直す
			const targetIndex = Number.parseInt(tabBar.dataset.tabDropIndex ?? '', 10);
			this.clearTabDropIndicators();
			// 移動元のタブとペインが両方あるときだけ並べ替える。どちらか一方が欠けても動かさない
			if (this.tabDragSourceId && this.tabDragSourcePaneId) {
				this.moveOrReorderTab(this.tabDragSourceId, this.tabDragSourcePaneId, paneId, Number.isFinite(targetIndex) ? targetIndex : this.calculateTabBarDropIndex(tabBar, event.clientX, this.tabDragSourcePaneId === paneId ? this.tabDragSourceId : undefined));
			}
		});
		// タブバーの空きをダブルクリックしたとき、無題タブをこのペインに開く
		tabWrap.addEventListener('dblclick', (event) => {
			this.handleTabBarEmptyDoubleClick(event, paneId, tabBar);
		});
		// このペインに空タブを足すボタン
		const addButton       = document.createElement('button');
		addButton.type        = 'button';
		addButton.tabIndex    = -1;
		addButton.className   = 'tms-mde-new-tab-button';
		addButton.textContent = '＋';
		addButton.setAttribute('aria-label', 'このペインに新規タブ');
		// 新規ボタンで、このペインを前面にして空タブを作る
		addButton.addEventListener('click', () => {
			this.activePaneId = paneId;
			void this.createNewTab();
		});
		tabWrap.append(tabBar, addButton);

		// エディタを載せる面。タブのドロップで分割先を示す
		const editorSurface     = document.createElement('div');
		editorSurface.className = 'tms-mde-pane-editor-surface';
		// タブを面の上へドラッグしたとき、分割する側を示す。タブのドラッグでなければ何もしない
		editorSurface.addEventListener('dragover', (event) => {
			// 移動元のタブとペインが両方無いドラッグは、分割表示にしない。どちらか一方が欠けてもしない
			if (!this.tabDragSourceId || !this.tabDragSourcePaneId) return;
			event.preventDefault();
			event.stopPropagation();
			// dataTransfer があるときだけ移動カーソルにする
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			this.clearTabDropIndicators();
			// 面のどの縁に近いか。分割方向と新ペインの側が決まる
			const placement          = calculatePaneDropPlacement(host.getBoundingClientRect(), event.clientX, event.clientY);
			host.dataset.tabDropZone = placement.zone;
			editorSurface.classList.add('is-tab-drag-over');
		});
		// 面の外へ出たとき、分割の表示を消す。子要素への移動では消さない
		editorSurface.addEventListener('dragleave', (event) => {
			// 面の中の子へ移っただけなら表示を残す
			if (event.relatedTarget instanceof Node && editorSurface.contains(event.relatedTarget)) return;
			this.clearTabDropIndicators();
		});
		// 面へ落とされたタブを、落とした側の新しいペインへ分ける
		editorSurface.addEventListener('drop', (event) => {
			// 移動元のタブとペインが両方無いときは分けない。どちらか一方が欠けても分けない
			if (!this.tabDragSourceId || !this.tabDragSourcePaneId) return;
			event.preventDefault();
			event.stopPropagation();
			// ドラッグ中のタブ。既に閉じられていれば undefined
			const sourceTab = this.tabs.find((entry) => entry.tabId === this.tabDragSourceId);
			// 落とした位置から決めた分割方向と新ペインの側
			const placement = calculatePaneDropPlacement(host.getBoundingClientRect(), event.clientX, event.clientY);
			this.clearTabDropIndicators();
			// タブが残っているときだけ新しいペインへ分ける
			if (sourceTab) this.splitTabIntoNewPane(sourceTab, paneId, placement, this.tabDragSourcePaneId);
		});
		host.append(tabWrap, editorSurface);
		// このペインで選択中のタブ。選択が無ければ null
		const tab = pane.activeTabId ? this.tabs.find((entry) => entry.tabId === pane.activeTabId) : null;
		// 選択中のタブがあるときだけエディタを載せる
		if (tab) {
			// 保持している状態。無ければ本文から作り直す
			const state = pane.editorStates.get(tab.tabId) ?? this.createPaneEditorState(tab, tab.editorState.doc.toString(), pane.viewModes.get(tab.tabId) ?? tab.viewMode);
			pane.editorStates.set(tab.tabId, state);
			this.mountPaneEditor(paneId, editorSurface, tab, state);
		}
		return host;
	}

	/**
	 * ペインへEditorViewをマウントする
	 * @param paneId - マウント先のペイン
	 * @param host - EditorView を入れる要素
	 * @param tab - 表示するタブ
	 * @param state - そのペイン用のエディタ状態
	 */
	private mountPaneEditor(paneId: PaneId, host: HTMLElement, tab: TabRuntime, state: EditorState): void {
		// このペインに載せたエディタ。本文の変更は他ペインへ同期する
		const view = mountEditorView(host, state, (transaction, sourceView) => this.dispatchEditorTransaction(transaction, sourceView));
		this.editorViews.set(paneId, view);
		this.applyDocumentContextToEditor(view, tab.filePath);
		// このペインのエディタへフォーカスが移ったら、前面ペインを切り替える
		view.dom.addEventListener('focusin', () => this.activatePane(paneId));
		this.bindNoteViewPosition(view);
	}

	/**
	 * ペイン間で本文変更だけを同期する
	 * @param transaction - 同期元トランザクション
	 * @param sourceView - 同期元ビュー
	 */
	private dispatchEditorTransaction(transaction: Transaction, sourceView: EditorView): void {
		sourceView.update([transaction]);
		// 前面エディタの本文変更では、表メニューの活性も合わせる
		if (sourceView === this.editorView) this.syncNativeTableMenuState();
		// 同期の再入か、本文が変わっていない変更では他ペインへ写さない。どちらか一方でも写さない
		if (this.synchronizingSplitTransaction || !transaction.docChanged) {
			return;
		}

		// 変更元のペイン ID。ビューが外れていれば null
		const sourcePaneId = this.findPaneId(sourceView);
		// 変更元の実行時ペイン。ID が無ければ null
		const sourcePane   = sourcePaneId ? this.panes.get(sourcePaneId) : null;
		// 同期するタブ。選択が無ければ undefined
		const tabId        = sourcePane?.activeTabId;
		// ペインか選択タブのどちらかが欠けても同期しない
		if (!sourcePaneId || !tabId) return;
		this.synchronizingSplitTransaction = true;
		try {
			this.panes.forEach((pane, paneId) => {
				// 変更元自身か、同じタブを持たないペインは写さない。どちらか一方でも写さない
				if (paneId === sourcePaneId || !pane.tabIds.includes(tabId)) return;
				// そのペインで同じタブが前面なら、マウント済みビュー。裏なら null
				const targetView  = pane.activeTabId === tabId ? this.editorViews.get(paneId) : null;
				// 写し先の状態。ビューが無ければ保持している状態。どちらも無ければ undefined
				const targetState = targetView?.state ?? pane.editorStates.get(tabId);
				// 写し先の状態が無いペインは飛ばす
				if (!targetState) return;
				// 同じ本文変更。適用できない差分なら null
				const synchronized = createSynchronizedTransaction(transaction, targetState);
				// 適用できない差分は飛ばす
				if (!synchronized) return;
				// 前面ビューがあるときは画面へ反映する
				if (targetView) targetView.update([synchronized]);
				else pane.editorStates.set(tabId, synchronized.state);
			});
		} finally {
			this.synchronizingSplitTransaction = false;
		}
	}

	/**
	 * アクティブペインを切り替える
	 * @param paneId - ペイン ID
	 */
	private activatePane(paneId: PaneId): void {
		// 切り替えるビュー。未マウントなら undefined
		const view = this.editorViews.get(paneId);
		// 切り替える実行時ペイン。無ければ undefined
		const pane = this.panes.get(paneId);
		// ビューか選択タブのどちらかが欠けても前面にはしない
		if (!view || !pane?.activeTabId) {
			return;
		}

		this.activePaneId = paneId;
		this.editorView   = view;
		this.activeTabId  = pane.activeTabId;
		this.editorHostElement.querySelectorAll<HTMLElement>('.tms-mde-editor-pane').forEach((pane) => {
			pane.classList.toggle('is-active', pane.dataset.paneId === paneId);
		});
		this.renderTabBar();
		this.refreshStatusBar();
		this.renderOutline();
		void this.updateWindowTitle();
		this.syncNativeTableMenuState();
	}

	/**
	 * 分割境界バーを生成する
	 * @param direction - 分割方向
	 * @returns 境界バー
	 */
	private createSplitDivider(split: PaneSplit, container: HTMLElement): HTMLElement {
		// 上下か左右か。キーとグリッドの向きに使う
		const direction   = split.direction;
		// ドラッグとキーで比率を変える境界
		const divider     = document.createElement('div');
		divider.className = 'tms-mde-split-divider';
		divider.tabIndex  = 0;
		divider.setAttribute('role', 'separator');
		divider.setAttribute('aria-label', direction === 'horizontal' ? '上下分割の境界' : '左右分割の境界');
		divider.setAttribute('aria-orientation', direction === 'horizontal' ? 'horizontal' : 'vertical');
		divider.setAttribute('aria-valuemin', '20');
		divider.setAttribute('aria-valuemax', '80');

		// 境界を押したとき、ドラッグを始め比率はまだ変えない
		divider.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			divider.setPointerCapture(event.pointerId);
			divider.classList.add('is-dragging');
		});
		// キャプチャ中の移動だけで、分割比率をポインター位置へ合わせる
		divider.addEventListener('pointermove', (event) => {
			// この境界が押されていない移動では比率を変えない
			if (!divider.hasPointerCapture(event.pointerId)) {
				return;
			}
			this.updateSplitRatioFromPointer(split, container, event.clientX, event.clientY);
		});
		/**
		 * 境界バーのドラッグを終了する
		 * @param event - ポインターイベント
		 */
		const finishDrag = (event: PointerEvent): void => {
			// この境界がポインターを掴んでいるときだけ解放する
			if (divider.hasPointerCapture(event.pointerId)) {
				divider.releasePointerCapture(event.pointerId);
			}
			divider.classList.remove('is-dragging');
		};
		// ボタンを離したらドラッグ表示を終わらせる。比率は移動中に確定済み
		divider.addEventListener('pointerup', finishDrag);
		// ポインターが取り消されたら、ドラッグ表示だけ終わらせる。比率は移動中の値のまま
		divider.addEventListener('pointercancel', finishDrag);
		// 境界のダブルクリックで、比率を半分に戻す
		divider.addEventListener('dblclick', () => {
			this.paneLayout = updateSplitRatio(this.paneLayout, split.splitId, 0.5);
			this.applySplitRatio({ ...split, ratio: 0.5 }, container);
		});
		// 矢印キーで分割比率を 5% ずつ変える。左右分割と上下分割でキーの意味が違う
		divider.addEventListener('keydown', (event) => {
			// 比率を減らすキー。上下分割は上、左右分割は左
			const decreaseKey = direction === 'horizontal' ? 'ArrowUp' : 'ArrowLeft';
			// 比率を増やすキー。上下分割は下、左右分割は右
			const increaseKey = direction === 'horizontal' ? 'ArrowDown' : 'ArrowRight';
			// 増減のどちらでもないキーでは比率を変えない
			if (event.key !== decreaseKey && event.key !== increaseKey) {
				return;
			}
			event.preventDefault();
			// 一段の変化。減らすキーは -0.05、増やすキーは 0.05。単位は比率
			const delta     = event.key === decreaseKey ? -0.05 : 0.05;
			// 0 から 1 の範囲へ収めた新しい比率
			const ratio     = calculateSplitRatio(split.ratio + delta, 0, 1);
			split.ratio     = ratio;
			this.paneLayout = updateSplitRatio(this.paneLayout, split.splitId, ratio);
			this.applySplitRatio(split, container);
		});
		return divider;
	}

	/**
	 * ポインター座標から分割比率を更新する
	 * @param split - 分割ノード
	 * @param container - 分割コンテナー
	 * @param clientX - X 座標
	 * @param clientY - Y 座標
	 */
	private updateSplitRatioFromPointer(split: PaneSplit, container: HTMLElement, clientX: number, clientY: number): void {
		// 分割コンテナーの画面上の矩形。単位は px
		const rect      = container.getBoundingClientRect();
		// ポインター位置から 0 から 1 へ収めた比率。上下分割は Y、左右分割は X
		const ratio     = split.direction === 'horizontal' ? calculateSplitRatio(clientY, rect.top, rect.height) : calculateSplitRatio(clientX, rect.left, rect.width);
		split.ratio     = ratio;
		this.paneLayout = updateSplitRatio(this.paneLayout, split.splitId, ratio);
		this.applySplitRatio(split, container);
	}

	/**
	 * 分割比率をレイアウトへ反映する
	 * @param split - 分割ノード
	 * @param container - 分割コンテナー
	 */
	private applySplitRatio(split: PaneSplit, container: HTMLElement): void {
		// 前側のトラック。単位は fr
		const primary   = `${split.ratio}fr`;
		// 後側のトラック。残りを fr で表す
		const secondary = `${1 - split.ratio}fr`;
		// 上下分割は行の比率を変える。境界は 6px
		if (split.direction === 'horizontal') {
			container.style.gridTemplateColumns = 'minmax(0, 1fr)';
			container.style.gridTemplateRows    = `minmax(0, ${primary}) 6px minmax(0, ${secondary})`;
		} else {
			container.style.gridTemplateColumns = `minmax(0, ${primary}) 6px minmax(0, ${secondary})`;
			container.style.gridTemplateRows    = 'minmax(0, 1fr)';
		}

		// 比率を読み上げる境界。描画前なら null
		const divider = container.querySelector<HTMLElement>(':scope > .tms-mde-split-divider');
		divider?.setAttribute('aria-valuenow', String(Math.round(split.ratio * 100)));
	}

	// ----------------------------------------------
	// ノートの表示位置
	// ----------------------------------------------

	/**
	 * 画像解決用のドキュメント文脈をエディタへ反映する
	 * @param view - 対象ビュー
	 * @param filePath - ファイルパス
	 */
	private applyDocumentContextToEditor(view: EditorView, filePath: string | null): void {
		view.dispatch({
			effects: setDocumentContextEffect.of({
				// 相対画像の基準パス。未保存は null
				filePath,
				// リモート画像を読むか。設定が無いときは読む
				loadRemoteImages: this.settings.loadRemoteImages ?? true
			})
		});
	}

	/**
	 * アクティブエディタ状態をタブへ反映する
	 * @param forceNoteViewCapture - 復元の途中でも表示位置を記録するか。省略時は false
	 */
	private persistActiveEditorState(forceNoteViewCapture = false): void {
		this.editorViews.forEach((view, paneId) => {
			// そのビューのペイン。外れていれば undefined
			const pane  = this.panes.get(paneId);
			// そのペインの選択タブ。未選択なら undefined
			const tabId = pane?.activeTabId;
			// ペインか選択タブのどちらかが欠けても状態は書き戻さない
			if (!pane || !tabId) return;
			pane.editorStates.set(tabId, view.state);
			// 選択中のタブ本体。閉じていれば undefined
			const tab = this.tabs.find((entry) => entry.tabId === tabId);
			// タブが残っているときだけ、共有の本文状態を更新する
			if (tab) tab.editorState = view.state;
		});
		this.captureMountedNoteViews(forceNoteViewCapture);
	}

	/**
	 * 起動時に受け取った表示位置をメモリへ載せる
	 * @param value - 保存ドキュメント
	 */
	private loadNoteViewPositions(value: unknown): void {
		this.noteViewPositions.replace(normalizeNoteViewPositionDocument(value));
		this.lastNoteViewPositionJson = JSON.stringify(this.noteViewPositions.toDocument());
	}

	/**
	 * マウント済みビューの表示位置を、準備ができたものだけ記録する
	 * アクティブペインを最後に書き、同じノートの位置はそちらを優先する
	 * @param force - 準備完了を待たず記録するか。省略時は false
	 */
	private captureMountedNoteViews(force = false): void {
		this.editorViews.forEach((view, paneId) => {
			// 前面ペインは最後に記録する。同じノートの位置はそちらを優先する
			if (paneId === this.activePaneId) return;
			this.rememberNoteView(view, force);
		});
		// 前面のビュー。未マウントなら undefined
		const activeView = this.editorViews.get(this.activePaneId);
		// 前面ビューがあるときだけ、最後にその位置を記録する
		if (activeView) this.rememberNoteView(activeView, force);
	}

	/**
	 * 表示位置の復元が終わるまで、先頭へのスクロールを保存しない
	 * @param view - エディタ
	 */
	private bindNoteViewPosition(view: EditorView): void {
		// このビューに保存されている表示位置。無ければ null
		const position         = this.noteViewPositionForView(view);
		/**
		 * スクロールのたびに表示位置を記録する
		 */
		const rememberOnScroll = (): void => {
			this.scheduleRememberNoteView(view);
		};
		// スクロールのたびに、次のフレームで表示位置を記録する
		view.scrollDOM.addEventListener('scroll', rememberOnScroll, { passive: true });

		// 保存済み位置が無いビューは、すぐに計測してよい
		if (!position) {
			this.noteViewCaptureReady.add(view);
			this.scheduleCaretSync(view, false);
			return;
		}

		/**
		 * 復元を終えたらキャレットを描き直して、以後のユーザー操作を記録できるようにする
		 * @param applied - 行高が揃った位置まで戻せたら true
		 */
		const finishRestore = (applied: boolean): void => {
			/**
			 * 計測の外でキャレットを描き直す
			 */
			const finishAfterFrame = (): void => {
				// ビューが外れていたらキャレットは描き直さない
				if (!view.dom.isConnected) return;
				// 行高が揃う前の復元に失敗したときだけ、選択行を画面内へ入れる
				if (!applied) this.revealSelectionLine(view);
				this.syncMountedCaret(view);
				this.noteViewCaptureReady.add(view);
			};
			window.requestAnimationFrame(finishAfterFrame);
		};
		// ペインDOMはこのメソッドの呼出し後にレイアウトへ接続される
		// 接続前に復元を始めると scrollDOM.isConnected が false になり、キャレット行表示へフォールバックしてしまう
		window.requestAnimationFrame(() => {
			// フレームまでにビューが外れていたら復元しない
			if (!view.dom.isConnected) return;
			restoreNoteViewScroll(view, position, finishRestore);
		});
	}

	/**
	 * 描画後にキャレットを選択位置へ合わせ、アクティブペインなら入力できるようフォーカスする
	 * 行高が揃う前にフォーカスすると、DOM 選択が編集できない隙間に入り、キー入力が捨てられる
	 * @param view - エディタ
	 * @param bringSelectionIntoView - 表示位置へ戻せなかったとき、選択行を画面内へ入れる
	 */
	private scheduleCaretSync(view: EditorView, bringSelectionIntoView: boolean): void {
		/**
		 * 計測の外でキャレットとフォーカスを合わせる
		 */
		const syncAfterFrame = (): void => {
			// ビューが外れていたらキャレットは合わせない
			if (!view.dom.isConnected) return;
			// 表示位置へ戻せなかったときだけ、選択行を画面内へ入れる
			if (bringSelectionIntoView) this.revealSelectionLine(view);
			this.syncMountedCaret(view);
		};
		window.requestAnimationFrame(syncAfterFrame);
	}

	/**
	 * 描画キャレットを選択位置へ合わせ、アクティブペインならフォーカスする
	 * @param view - エディタ
	 */
	private syncMountedCaret(view: EditorView): void {
		// ビューが外れていたらキャレットは描き直さない
		if (!view.dom.isConnected) return;
		view.dispatch(createCaretRedrawSpec(view.state.selection));
		// 前面ペインのときだけ入力できるようフォーカスする
		if (this.editorViews.get(this.activePaneId) === view) view.focus();
	}

	/**
	 * 選択行が画面外なら、その行の上端までスクロールする
	 * @param view - エディタ
	 */
	private revealSelectionLine(view: EditorView): void {
		// 本文のスクロール領域
		const scroller = view.scrollDOM;
		// 未接続か高さが 0 のときは、スクロール位置を計算できない。どちらか一方でも戻る
		if (!scroller.isConnected || scroller.clientHeight <= 0) return;
		// 選択位置の行ブロック。単位は px
		const block     = view.lineBlockAt(view.state.selection.main.head);
		// 今見えている上端。単位は px
		const top       = scroller.scrollTop;
		// 今見えている下端。単位は px
		const bottom    = top + scroller.clientHeight;
		// スクロールできる最大値。単位は px。内容が短ければ 0
		const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		// 行がすでに画面内なら動かさない。上端と下端の 1px は境界の揺れとして画面内に含める
		if (block.bottom >= top + 1 && block.top <= bottom - 1) return;
		scroller.scrollTop = Math.min(maxScroll, Math.max(0, block.top));
	}

	/**
	 * ビューに対応する保存済み表示位置を返す
	 * @param view - エディタ
	 * @returns 無ければ null
	 */
	private noteViewPositionForView(view: EditorView): NoteViewPosition | null {
		// このビューのタブ。外れていれば null
		const tab = this.tabForView(view);
		// タブが無いビューの位置は保存しない
		if (!tab) return null;
		// 保存済みファイルはパスをキーにする
		if (tab.filePath) return this.noteViewPositions.get(tab.filePath);
		return this.untitledNoteViewPositions.get(tab.tabId) ?? null;
	}

	/**
	 * スクロールや選択の直後は、次のフレームで表示位置を記録する
	 * 同じターンで行位置を読むと、Ctrl+End の末尾補正より先に計測が走り、見積もり高さで止まってしまう
	 * @param view - エディタ
	 */
	private scheduleRememberNoteView(view: EditorView): void {
		// 復元が終わるまでは、先頭へのスクロールを保存しない
		if (!this.noteViewCaptureReady.has(view)) return;
		// 同じビューの記録が既に次のフレームへ予約済みなら重ねない
		if (this.noteViewRememberScheduled.has(view)) return;
		this.noteViewRememberScheduled.add(view);
		/**
		 * 描画後のビューポートから表示位置を記録する
		 */
		const rememberAfterFrame = (): void => {
			this.noteViewRememberScheduled.delete(view);
			this.rememberNoteView(view);
		};
		window.requestAnimationFrame(rememberAfterFrame);
	}

	/**
	 * ビューの現在位置をノートへ記録する。復元中は無視する
	 * @param view - エディタ
	 */
	private rememberNoteView(view: EditorView, force = false): void {
		// 強制でなければ、復元中のビューは記録しない
		if (!force && !this.noteViewCaptureReady.has(view)) return;
		// このビューのタブ。外れていれば null
		const tab      = this.tabForView(view);
		// 今の表示位置。タブが無ければ null
		const position = tab ? captureNoteViewPosition(view) : null;
		// タブか位置のどちらかが欠けても記録しない
		if (!tab || !position) return;
		// 保存済みファイルはパスへ記録し、無題用の位置は消す
		if (tab.filePath) {
			this.noteViewPositions.remember(tab.filePath, position);
			this.untitledNoteViewPositions.delete(tab.tabId);
			this.scheduleNoteViewPositionSave();
			return;
		}
		this.untitledNoteViewPositions.set(tab.tabId, position);
	}

	/**
	 * ビューが表示しているタブを返す
	 * @param view - エディタ
	 * @returns タブ
	 */
	private tabForView(view: EditorView): TabRuntime | null {
		// このビューのペイン ID。外れていれば null
		const paneId = this.findPaneId(view);
		// 実行時ペイン。ID が無ければ null
		const pane   = paneId ? this.panes.get(paneId) : null;
		// 選択中タブが無いペインのビューは対応付けない
		if (!pane?.activeTabId) return null;
		return this.tabs.find((tab) => tab.tabId === pane.activeTabId) ?? null;
	}

	/**
	 * 表示位置のディスク保存を少し遅らせる
	 */
	private scheduleNoteViewPositionSave(): void {
		// 待ちがあるときだけ、前の保存予約を取り消す
		if (this.noteViewSaveTimer !== null) window.clearTimeout(this.noteViewSaveTimer);
		/**
		 * 遅延後に表示位置を保存する
		 */
		const saveLater = (): void => {
			this.noteViewSaveTimer = null;
			void this.flushNoteViewPositions();
		};
		this.noteViewSaveTimer = window.setTimeout(saveLater, AppController.NOTE_VIEW_POSITION_SAVE_DELAY_MS);
	}

	/**
	 * 未保存の表示位置をディスクへ書く
	 */
	private flushNoteViewPositions(): Promise<void> {
		// 遅延中の保存があれば、今すぐ止めてから最新を書く
		if (this.noteViewSaveTimer !== null) {
			window.clearTimeout(this.noteViewSaveTimer);
			this.noteViewSaveTimer = null;
		}
		/**
		 * 直前の保存の後に最新の表示位置を書く
		 */
		const saveAfterCurrent = (): Promise<void> => this.saveNoteViewPositions();
		this.noteViewSaveChain = this.noteViewSaveChain.then(saveAfterCurrent);
		return this.noteViewSaveChain;
	}

	/**
	 * メモリ上の表示位置を保存する。内容が同じなら書き込まない
	 */
	private async saveNoteViewPositions(): Promise<void> {
		// 保存する表示位置。パスをキーにした文書
		const document = this.noteViewPositions.toDocument();
		// 直前と比較する JSON。同じならディスクへ書かない
		const json     = JSON.stringify(document);
		// 前回保存した内容と同じときは書き込まない
		if (json === this.lastNoteViewPositionJson) return;
		try {
			// 保存結果。失敗時は success が false
			const result = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.noteViewPositionsSave, document as unknown as Record<string, unknown>);
			// シェルが失敗を返したときは、理由があればそれをログへ残して前回値は更新しない
			if (!result.success) {
				void writeLog('WARN', result.message ?? 'Note view position save failed.');
				return;
			}
			this.lastNoteViewPositionJson = json;
		} catch (error) {
			void writeLog('WARN', `Note view position save failed: ${this.formatError(error)}`);
		}
	}

	// ----------------------------------------------
	// ステータス
	// ----------------------------------------------

	/**
	 * ステータスバーの表示倍率を更新する
	 * @param zoom - 倍率
	 */
	private updateUiZoomStatus(zoom: number): void {
		// 100% か。100% の表示はクリックで戻す対象にしない
		const isDefault = zoom === 1;

		this.statusElements.zoom.textContent = formatUiZoomPercent(zoom);
		this.statusElements.zoom.classList.toggle('tms-mde-status-static', isDefault);
		this.statusElements.zoom.setAttribute('aria-label', isDefault ? '表示倍率' : '表示倍率（クリックで100%に戻す）');
	}

	/**
	 * エディタ本文の表示倍率を反映する
	 */
	private applyEditorZoom(): void {
		// マウント済みエディタが無いときはフォントサイズを当てられない
		if (this.editorViews.size === 0) {
			return;
		}

		// 倍率を掛けた本文フォント。単位は px
		const fontSizePx = `${computeZoomedFontSize(this.settings.editorFontSize)}px`;

		this.editorViews.forEach((view) => {
			view.dom.style.fontSize = fontSizePx;
			view.dom.style.setProperty('--tms-mde-editor-font-size', fontSizePx);
		});
	}

	/**
	 * ステータスバーを更新する
	 */
	private refreshStatusBar(): void {
		// 状態を出すタブ。無ければステータスは空のまま
		const tab = this.getActiveTab();
		// タブかエディタのどちらかが欠けても、カーソル位置は出せない
		if (!tab || !this.editorView) {
			return;
		}

		// 主選択。複数選択でもステータスは主範囲だけ
		const selection = this.editorView.state.selection.main;
		// キャレットがある行
		const line      = this.editorView.state.doc.lineAt(selection.head);
		// 行内の列。1 始まり
		const column    = selection.head - line.from + 1;
		// 文書の文字数。改行を含む
		const charCount = this.editorView.state.doc.length;

		this.statusElements.cursor.textContent    = `行 ${line.number}, 列 ${column}`;
		this.statusElements.charCount.textContent = `${charCount} 文字`;
		this.statusElements.encoding.textContent  = formatEncodingLabel(tab.encoding);
		this.statusElements.eol.textContent       = formatEolLabel(tab.eol, tab.eolMixed);
		// このペインの表示モード。ペイン側が無ければタブの値
		const viewMode                            = this.panes.get(this.activePaneId)?.viewModes.get(tab.tabId) ?? tab.viewMode;
		this.statusElements.viewMode.textContent  = viewMode === 'live-preview' ? 'ライブプレビュー' : 'ソース';
		this.statusElements.viewMode.classList.toggle('tms-mde-status-static', tab.largeFile);

		this.statusElements.largeFile.hidden = !tab.largeFile;
	}

	/**
	 * ウィンドウタイトルを更新する
	 */
	private async updateWindowTitle(): Promise<void> {
		// タイトルに出すタブ。無ければ変えない
		const tab = this.getActiveTab();
		// タブが無いときはウィンドウタイトルを更新しない
		if (!tab) {
			return;
		}

		await invokeBridge(BRIDGE_METHOD.windowSetTitle, {
			title: buildWindowTitle(tab.title, tab.dirty, tab.filePath)
		});
	}

	/**
	 * ドキュメント変更を処理する
	 * @param view - 変更元ビュー
	 */
	private handleDocumentChange(view: EditorView): void {
		// 変更元のペイン ID。ビューが外れていれば null
		const paneId = this.findPaneId(view);
		// 変更元の実行時ペイン。ID が無ければ null
		const pane   = paneId ? this.panes.get(paneId) : null;
		// そのペインの選択タブ。未選択か閉じ済みなら null
		const tab    = pane?.activeTabId ? this.tabs.find((entry) => entry.tabId === pane.activeTabId) : null;
		// タブ、ペイン、ペイン ID のどれか一つが欠けても変更は取り込まない
		if (!tab || !pane || !paneId) {
			return;
		}

		// 変更前の状態。ペイン側が無ければタブの状態
		const previousState = pane.editorStates.get(tab.tabId) ?? tab.editorState;
		// 変更前の本文。行末マップの差分に使う
		const previousCm6   = previousState.doc.toString();
		// 変更後の本文
		const currentText   = view.state.doc.toString();
		pane.editorStates.set(tab.tabId, view.state);
		tab.editorState = view.state;

		// 分割同期の再入では、未保存やアウトラインを二重に更新しない
		if (this.synchronizingSplitTransaction) {
			return;
		}

		// 変更前の行末マップ。今回の差分の基準
		const previousLineEols = tab.lineEols;
		tab.lineEols           = syncLineEols(previousLineEols, previousCm6, currentText, tab.eol);
		tab.dirty              = currentText !== tab.savedText;
		this.renderTabBar();
		this.refreshStatusBar();
		// 前面エディタの変更だけアウトラインを描き直す
		if (view === this.editorView) {
			this.renderOutline();
		}
		void this.updateWindowTitle();

		// 本文だけの入力では装飾更新を dispatch しない。IME composition 中に
		// 行末ウィジェットを差し替えると、先頭のローマ字が確定・重複するため
		// 改行マーカーを出していて、行末マップが変わったときだけ後で反映する。どちらか一方が欠けても反映しない
		if (this.settings.showEolMarkers && tab.lineEols !== previousLineEols) {
			// この時点の行末マップ。マイクロタスクまで保持する
			const lineEols = tab.lineEols;
			// この時点のタブ ID。別タブへ移っていたら反映しない
			const tabId    = tab.tabId;
			queueMicrotask(() => {
				// マイクロタスク時点の前面タブ。閉じていれば null
				const active = this.getActiveTab();
				// 前面が無いか、別タブへ移っていたら行末マーカーは更新しない。どちらか一方でも更新しない
				if (!active || active.tabId !== tabId) {
					return;
				}

				this.applyLineEolsToEditor(lineEols);
				this.persistActiveEditorState();
			});
		}
	}

	/**
	 * EditorView に対応するペイン ID を取得する
	 * @param view - 対象ビュー
	 * @returns ペイン ID
	 */
	private findPaneId(view: EditorView): PaneId | null {
		for (const [paneId, mountedView] of this.editorViews) {
			// 同じビューを載せているペインが見つかったら、その ID を返す
			if (mountedView === view) {
				return paneId;
			}
		}
		return null;
	}

	/**
	 * 選択状態をペインへ保存し、アクティブペインのステータスを更新する
	 * @param view - 対象ビュー
	 */
	private handleSelectionChange(view: EditorView): void {
		// 選択が変わったペイン ID。ビューが外れていれば null
		const paneId = this.findPaneId(view);
		// その実行時ペイン。ID が無ければ null
		const pane   = paneId ? this.panes.get(paneId) : null;
		// そのペインの選択タブ。未選択か閉じ済みなら null
		const tab    = pane?.activeTabId ? this.tabs.find((entry) => entry.tabId === pane.activeTabId) : null;
		// タブ、ペイン、ペイン ID のどれか一つが欠けても選択は保存しない
		if (!tab || !pane || !paneId) {
			return;
		}

		pane.editorStates.set(tab.tabId, view.state);
		tab.editorState = view.state;
		this.scheduleRememberNoteView(view);
		// 前面エディタの選択だけ、ステータスとアウトラインの強調を更新する
		if (view === this.editorView) {
			this.refreshStatusBar();
			this.updateOutlineActiveItem();
		}
	}

	// ----------------------------------------------
	// アウトライン
	// ----------------------------------------------

	/** アウトラインパネルの表示 / 非表示を切り替える */
	private toggleOutline(): void {
		this.setOutlineVisible(!this.outlineVisible);
	}

	/**
	 * アウトラインパネルの表示状態を切り替える
	 * @param visible - 表示するなら true
	 */
	private setOutlineVisible(visible: boolean): void {
		this.outlineVisible             = visible;
		this.outlinePanelElement.hidden = !visible;
		// 表示するときだけ見出しを描き直す。隠すときは DOM を残す
		if (visible) this.renderOutline();
	}

	/** アクティブペインの見出し一覧を描画する */
	private renderOutline(): void {
		// パネルが隠れているときは見出しを集めない
		if (!this.outlineVisible) return;

		this.outlineItems = this.editorView ? collectOutlineItems(this.editorView.state) : [];
		// インデント付きの見出し木。見出しが無ければ空
		const tree        = buildOutlineTree(this.outlineItems);
		this.pruneOutlineCollapsedFroms(tree);
		this.outlineListElement.innerHTML = '';
		this.outlineEmptyElement.hidden   = this.outlineItems.length > 0;
		this.outlineListElement.hidden    = this.outlineItems.length === 0;

		for (const node of tree) {
			this.outlineListElement.appendChild(this.createOutlineNodeElement(node));
		}

		this.updateOutlineActiveItem();
	}

	/**
	 * アウトラインの1見出しと子孫を描画する
	 * @param node - ノード
	 * @returns ノード要素
	 */
	private createOutlineNodeElement(node: OutlineTreeNode): HTMLElement {
		// 見出し1件の枠
		const wrap     = document.createElement('div');
		wrap.className = 'tms-mde-outline-node';
		// 開閉ボタンと見出しボタンを並べる行
		const row      = document.createElement('div');
		row.className  = 'tms-mde-outline-row';
		row.style.setProperty('--tms-mde-outline-level', String(node.item.level));
		// 子見出しがあるか
		const hasChildren = node.children.length > 0;
		// 子があり、その見出し位置が折りたたみ集合に入っているか
		const collapsed   = hasChildren && this.outlineCollapsedFroms.has(node.item.from);

		// 子がある見出しだけ開閉ボタンを出す
		if (hasChildren) {
			// 子の開閉ボタン
			const twist       = document.createElement('button');
			twist.type        = 'button';
			twist.className   = 'tms-mde-outline-twist';
			twist.textContent = collapsed ? '▶' : '▼';
			twist.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
			twist.setAttribute('aria-label', collapsed ? '展開' : '折りたたむ');
			// 開閉ボタンを押してもエディタのフォーカスを奪わない
			twist.addEventListener('mousedown', preserveEditorFocusOnOutlineMouseDown);
			// 開閉ボタンで、その見出しの子だけを開閉する。見出しへのジャンプはしない
			twist.addEventListener('click', (event) => {
				event.stopPropagation();
				this.toggleOutlineFold(node.item.from);
			});
			row.appendChild(twist);
		} else {
			// 子が無い見出しの空き。開閉ボタンと同じ幅を取る
			const spacer     = document.createElement('span');
			spacer.className = 'tms-mde-outline-twist is-leaf';
			spacer.setAttribute('aria-hidden', 'true');
			row.appendChild(spacer);
		}

		// 見出しへジャンプするボタン
		const button                = document.createElement('button');
		button.type                 = 'button';
		button.className            = 'tms-mde-outline-item';
		button.textContent          = node.item.title;
		button.title                = node.item.title;
		button.dataset.outlineIndex = String(node.index);
		// 見出しを押してもエディタのフォーカスを奪わない
		button.addEventListener('mousedown', preserveEditorFocusOnOutlineMouseDown);
		// 見出しのクリックで、その位置へキャレットを移す
		button.addEventListener('click', () => this.jumpToOutlineItem(node.item));
		row.appendChild(button);
		wrap.appendChild(row);

		// 子がある見出しだけ、折りたたみできる子リストを足す
		if (hasChildren) {
			// 子見出しを入れる枠。折りたたみ中は隠す
			const children     = document.createElement('div');
			children.className = 'tms-mde-outline-children';
			children.hidden    = collapsed;
			for (const child of node.children) {
				children.appendChild(this.createOutlineNodeElement(child));
			}
			wrap.appendChild(children);
		}

		return wrap;
	}

	/**
	 * 存在しなくなった折りたたみ位置を捨てる
	 * @param tree - 現在のツリー
	 */
	private pruneOutlineCollapsedFroms(tree: OutlineTreeNode[]): void {
		// 今の木で折りたためる見出し位置。消えた位置は捨てる
		const valid = new Set(collectFoldableOutlineFroms(tree));
		for (const from of [...this.outlineCollapsedFroms]) {
			// 今の木に無い位置は折りたたみ集合から外す
			if (!valid.has(from)) this.outlineCollapsedFroms.delete(from);
		}
	}

	/**
	 * 子を持つ見出しの開閉を切り替える
	 * @param from - 見出し位置
	 */
	private toggleOutlineFold(from: number): void {
		// 折りたたみ中なら開く。開いているときは下の else で閉じる
		if (this.outlineCollapsedFroms.has(from)) this.outlineCollapsedFroms.delete(from);
		else this.outlineCollapsedFroms.add(from);
		this.renderOutline();
	}

	/** アウトラインをすべて展開する */
	private expandAllOutline(): void {
		this.outlineCollapsedFroms.clear();
		this.renderOutline();
	}

	/** 子を持つ見出しをすべて折りたたむ。子自身の開閉状態は維持する */
	private collapseAllOutline(): void {
		this.outlineItems          = this.editorView ? collectOutlineItems(this.editorView.state) : [];
		this.outlineCollapsedFroms = new Set(collectFoldableOutlineFroms(buildOutlineTree(this.outlineItems)));
		this.renderOutline();
	}

	/** キャレット位置に対応する見出しを強調し、アウトラインの表示範囲へ収める */
	private updateOutlineActiveItem(): void {
		// パネルが隠れているか、エディタが無いときは強調しない。どちらか一方でも戻る
		if (!this.outlineVisible || !this.editorView) return;

		// キャレットが属する見出しの添字。どの見出しより前なら -1
		const activeIndex = findActiveOutlineItemIndex(this.outlineItems, this.editorView.state.selection.main.head);
		// 祖先を開いたので、リストを描き直す必要があるか
		let expanded      = false;
		for (const from of collectOutlineAncestorFroms(this.outlineItems, activeIndex)) {
			expanded = this.outlineCollapsedFroms.delete(from) || expanded;
		}
		// 祖先を開いたときは、描き直した側で強調まで行う
		if (expanded) {
			this.renderOutline();
			return;
		}

		this.outlineListElement.querySelectorAll<HTMLElement>('.tms-mde-outline-item').forEach((element) => {
			// キャレットの見出しか。添字が一致しない項目は false
			const active = Number(element.dataset.outlineIndex) === activeIndex;
			element.classList.toggle('is-active', active);
			// 現在位置の見出しだけ aria-current を付ける
			if (active) {
				element.setAttribute('aria-current', 'location');
			} else {
				element.removeAttribute('aria-current');
			}
		});
		// 強調する見出し要素。添字が無ければ null
		const activeElement = this.outlineListElement.querySelector<HTMLElement>(`.tms-mde-outline-item[data-outline-index="${activeIndex}"]`);
		// 対応する見出しがリストに無いときはスクロールしない
		if (!activeElement) return;

		// 見出しの画面上の矩形。単位は px
		const itemRect        = activeElement.getBoundingClientRect();
		// リストの画面上の矩形。単位は px
		const viewportRect    = this.outlineListElement.getBoundingClientRect();
		// 見出しがリスト内に収まるスクロール位置。単位は px
		const targetScrollTop = computeOutlineListScrollTop({
			// 見出しの上端
			itemTop: itemRect.top,
			// 見出しの下端
			itemBottom: itemRect.bottom,
			// リストの上端
			viewportTop: viewportRect.top,
			// リストの下端
			viewportBottom: viewportRect.bottom,
			// 今のスクロール位置
			scrollTop: this.outlineListElement.scrollTop,
			// スクロールできる最大値。内容が短ければ 0
			maxScrollTop: Math.max(0, this.outlineListElement.scrollHeight - this.outlineListElement.clientHeight)
		});
		this.outlineListElement.scrollTo({ top: targetScrollTop });
	}

	/**
	 * 選択した見出しへキャレットを移動する。スクロールは補正プラグインが行う
	 * @param item - 移動先の見出し
	 */
	private jumpToOutlineItem(item: OutlineItem): void {
		// エディタが無いときは見出しへ移動できない
		if (!this.editorView) return;

		expandHeadingAt(this.editorView, item.from);
		jumpToOutlineItem(this.editorView, item);
	}

	// ----------------------------------------------
	// タブの実行時モデル
	// ----------------------------------------------

	/**
	 * 追加ペイン用の EditorState を生成する
	 * @param tab - 対象タブ
	 * @param text - 初期本文
	 * @param viewMode - 初期表示モード
	 * @returns エディタ状態
	 */
	private createPaneEditorState(tab: TabRuntime, text: string, viewMode: ViewMode): EditorState {
		// 共有する選択。新しいペインも同じ位置から開く
		const selection = tab.editorState.selection.main;
		// 追加ペインのエディタ状態。本文と折りたたみはタブ側を引き継ぐ
		return createEditorState({
			// 初期本文
			text,
			// 今の設定
			settings: this.settings,
			// そのペインの表示モード
			viewMode,
			// 相対画像の基準パス。未保存は null
			filePath: tab.filePath,
			// 行ごとの改行
			lineEols: tab.lineEols,
			// コンパイル済みの装飾規則
			customDecorations: this.customDecorationRules,
			// 主選択の両端。単位は文書位置
			selection: { anchor: selection.anchor, head: selection.head },
			// 折りたたまれている見出し位置。無ければ空
			collapsedHeadingFroms: getCollapsedHeadingFroms(tab.editorState),
			/** 本文変更を処理する */
			onDocChange: (view) => this.handleDocumentChange(view),
			/** 選択変更を処理する */
			onSelectionChange: (view) => this.handleSelectionChange(view),
			/** 折りたたみ状態の変更を表示位置履歴へ保存する */
			onFoldChange: (view) => this.scheduleRememberNoteView(view),
			/** 貼り付けを処理する */
			onPaste: (event, view) => this.handleEditorPaste(event, view)
		});
	}

	/**
	 * 既存 EditorState を新しい設定で再構成する
	 * @param tab - 対象タブ
	 * @param state - 現在の状態
	 * @param viewMode - ペインの表示モード
	 * @returns 再構成後の状態
	 */
	private reconfigurePaneEditorState(tab: TabRuntime, state: EditorState, viewMode: ViewMode): EditorState {
		return reconfigureEditorState(state, {
			// 今の本文
			text: state.doc.toString(),
			// 今の設定
			settings: this.settings,
			// そのペインの表示モード
			viewMode,
			// 相対画像の基準パス。未保存は null
			filePath: tab.filePath,
			// 行ごとの改行
			lineEols: tab.lineEols,
			// コンパイル済みの装飾規則
			customDecorations: this.customDecorationRules,
			/** 本文変更を処理する */
			onDocChange: (view) => this.handleDocumentChange(view),
			/** 選択変更を処理する */
			onSelectionChange: (view) => this.handleSelectionChange(view),
			/** 折りたたみ状態の変更を表示位置履歴へ保存する */
			onFoldChange: (view) => this.scheduleRememberNoteView(view),
			/** 貼り付けを処理する */
			onPaste: (event, view) => this.handleEditorPaste(event, view)
		});
	}

	/**
	 * タブランタイムを生成する
	 * @param options - 生成オプション
	 * @returns タブ
	 */
	private createTabRuntime(options: { filePath: string | null; text: string; encoding: EncodingKind; eol: EolKind; eolMixed: boolean; largeFile: boolean; viewMode: ViewMode; lineEols: Array<EolKind | null> }): TabRuntime {
		// 新しいタブ ID
		const tabId       = crypto.randomUUID();
		// 同じパスに保存されている表示位置。未保存か未記録なら null
		const savedView   = options.filePath ? this.noteViewPositions.get(options.filePath) : null;
		// タブを開いたときのエディタ状態。保存位置があれば選択と折りたたみを戻す
		const editorState = createEditorState({
			// 開く本文
			text: options.text,
			// 今の設定
			settings: this.settings,
			// 初期の表示モード
			viewMode: options.viewMode,
			// 相対画像の基準パス。未保存は null
			filePath: options.filePath,
			// 行ごとの改行
			lineEols: options.lineEols,
			// コンパイル済みの装飾規則
			customDecorations: this.customDecorationRules,
			// 保存位置から戻す選択。記録が無ければエディタの既定
			selection: savedView ? selectionFromNoteViewPosition(savedView, options.text.length) : undefined,
			// 保存されていた折りたたみ位置。記録が無ければ undefined
			collapsedHeadingFroms: savedView?.collapsedHeadingFroms,
			/**
			 * ドキュメント変更時
			 */
			onDocChange: (view) => {
				this.handleDocumentChange(view);
			},
			/**
			 * 選択変更時
			 */
			onSelectionChange: (view) => {
				this.handleSelectionChange(view);
			},
			/** 折りたたみ状態の変更を表示位置履歴へ保存する */
			onFoldChange: (view) => this.scheduleRememberNoteView(view),
			/**
			 * 貼り付け時
			 */
			onPaste: (event, view) => this.handleEditorPaste(event, view)
		});

		// 生成したタブ。未保存で、本文は開いたときの文字列
		return {
			// タブ ID
			tabId,
			// パスか無題から作る題名
			title: buildTabTitle(options.filePath),
			// 保存済みパス。未保存は null
			filePath: options.filePath,
			// 保存に使う文字コード
			encoding: options.encoding,
			// 代表の改行
			eol: options.eol,
			// 行ごとに改行が混在しているか
			eolMixed: options.eolMixed,
			// 開いた直後は保存済み
			dirty: false,
			// 未保存比較の基準になる本文
			savedText: options.text,
			// 初期の表示モード
			viewMode: options.viewMode,
			// 大きいファイルとしてソース固定か
			largeFile: options.largeFile,
			// 行ごとの改行
			lineEols: options.lineEols,
			// 開いたときのエディタ状態
			editorState
		};
	}

	/**
	 * アクティブタブを取得する
	 * @returns タブ
	 */
	private getActiveTab(): TabRuntime | null {
		// 選択中タブが無いときは null
		if (!this.activeTabId) {
			return null;
		}

		return this.tabs.find((tab) => tab.tabId === this.activeTabId) ?? null;
	}

	/**
	 * タブをペインへ登録し、ペイン固有の表示状態を初期化する
	 * @param tab - 登録するタブ
	 * @param paneId - 登録先のペイン
	 */
	private addTabToPane(tab: TabRuntime, paneId: PaneId): void {
		// 登録先のペイン。無ければ何もしない
		const pane = this.panes.get(paneId);
		// ペインが無いときはタブを登録できない
		if (!pane) return;
		// 同じタブが並びにあるときは追加しない
		if (!pane.tabIds.includes(tab.tabId)) pane.tabIds.push(tab.tabId);
		// エディタ状態が無いときだけ、本文から作る
		if (!pane.editorStates.has(tab.tabId)) pane.editorStates.set(tab.tabId, this.createPaneEditorState(tab, tab.editorState.doc.toString(), tab.viewMode));
		// 表示モードが無いときだけ、タブの値を入れる
		if (!pane.viewModes.has(tab.tabId)) pane.viewModes.set(tab.tabId, tab.viewMode);
	}

	/**
	 * 同じ文書を表示する全ペインへ本文置換を反映する
	 * @param tab - 本文を置き換えるタブ
	 * @param text - 新しい本文。改行は LF
	 */
	private replaceTabText(tab: TabRuntime, text: string): void {
		this.panes.forEach((pane, paneId) => {
			// そのタブを持たないペインは本文を置き換えない
			if (!pane.tabIds.includes(tab.tabId)) return;
			// そのペインでタブが前面ならマウント済みビュー。裏なら null
			const view = pane.activeTabId === tab.tabId ? this.editorViews.get(paneId) : null;
			// 画面に出ているビューは、表示ごと本文を置き換える
			if (view) {
				replaceEditorText(view, text);
				pane.editorStates.set(tab.tabId, view.state);
				return;
			}
			// 裏に保持している状態。無ければ undefined
			const state = pane.editorStates.get(tab.tabId);
			// 保持状態があるときだけ、履歴に残さず本文を置き換える
			if (state)
				pane.editorStates.set(
					tab.tabId,
					state.update({
						// 文書全体を新しい本文へ置き換える。from と to は文書位置、insert は置換後の文字列
						changes: { from: 0, to: state.doc.length, insert: text },
						// 再読込なのでアンドゥ履歴には残さない
						annotations: Transaction.addToHistory.of(false)
					}).state
				);
		});
		// タブ本体の本文も、履歴に残さず同じ文字列へ置き換える
		tab.editorState = tab.editorState.update({
			// 文書全体を新しい本文へ置き換える。from と to は文書位置、insert は置換後の文字列
			changes: { from: 0, to: tab.editorState.doc.length, insert: text },
			// 再読込なのでアンドゥ履歴には残さない
			annotations: Transaction.addToHistory.of(false)
		}).state;
	}

	/**
	 * 指定タブを含む先頭のペインを返す
	 * @param tabId - 探すタブ ID
	 * @returns そのタブを含む最初のペイン。無いときは null
	 */
	private findPaneContainingTab(tabId: string): PaneId | null {
		for (const [paneId, pane] of this.panes) {
			// そのタブを含む最初のペインが見つかったら ID を返す
			if (pane.tabIds.includes(tabId)) return paneId;
		}
		return null;
	}

	/** 単一ペイン状態へ戻す */
	private resetPaneLayout(): void {
		this.editorViews.forEach((view) => view.destroy());
		this.editorViews.clear();
		this.panes.clear();
		this.paneLayout   = createPaneLayout(AppController.INITIAL_PANE_ID);
		this.activePaneId = AppController.INITIAL_PANE_ID;
		this.activeTabId  = null;
		this.panes.set(AppController.INITIAL_PANE_ID, {
			// 初期ペイン ID
			paneId: AppController.INITIAL_PANE_ID,
			// タブは空から始める
			tabIds: [],
			// 選択中タブは無い
			activeTabId: null,
			// エディタ状態は空
			editorStates: new Map(),
			// 表示モードは空
			viewModes: new Map()
		});
	}

	/**
	 * 既定文字コードを解決する
	 * @param value - 設定値
	 * @returns 文字コード
	 */
	private parseDefaultEncoding(value: string): EncodingKind {
		// BOM 付き UTF-8 の別名は、どちらも同じ文字コードへ揃える
		if (value === 'utf8Bom' || value === 'utf-8(bom)') {
			return 'utf8Bom';
		}

		// 設定が cp932 のときだけ Shift_JIS 系にする
		if (value === 'cp932') {
			return 'cp932';
		}

		return 'utf8';
	}

	/**
	 * 既定改行コードを解決する
	 * @param value - 設定値
	 * @returns 改行コード
	 */
	private parseDefaultEol(value: string): EolKind {
		return value === 'lf' ? 'lf' : 'crlf';
	}

	/**
	 * エラーを整形する
	 * @param error - エラー
	 * @returns メッセージ
	 */
	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

// ----------------------------------------------
// メニュー操作の変換
// ----------------------------------------------

/**
 * 右クリックの配置コマンドを文書変更へ変換する
 * @param action - コマンドID
 * @returns 水平または垂直の配置。配置コマンドでなければ null
 */
function tableAlignPatchFromAction(action: string): TableAlignPatch | null {
	// 左揃え
	if (action === 'alignTableCellLeft') {
		return { align: 'left' };
	}

	// 中央揃え
	if (action === 'alignTableCellCenter') {
		return { align: 'center' };
	}

	// 右揃え
	if (action === 'alignTableCellRight') {
		return { align: 'right' };
	}

	// 上揃え
	if (action === 'valignTableCellTop') {
		return { valign: 'top' };
	}

	// 上下中央
	if (action === 'valignTableCellMiddle') {
		return { valign: 'middle' };
	}

	// 下揃え
	if (action === 'valignTableCellBottom') {
		return { valign: 'bottom' };
	}

	return null;
}

/**
 * 右クリックの表構造コマンドを、行や列の操作へ変換する
 * 配置コマンドは対象外
 * @param action - メニュー項目の ID
 * @returns 挿入、削除、移動のいずれか。配置コマンドのときは null
 */
function tableStructureActionFromContextMenu(action: string): TableStructureAction | null {
	// 行か列を、対象の前へ挿入する。どちらでもない操作はこの分岐に入らない
	if (action === 'insertTableRowsBefore' || action === 'insertTableColumnsBefore') return 'insert-before';
	// 行か列を、対象の後へ挿入する。どちらでもない操作はこの分岐に入らない
	if (action === 'insertTableRowsAfter' || action === 'insertTableColumnsAfter') return 'insert-after';
	// 行か列を削除する。どちらでもない操作はこの分岐に入らない
	if (action === 'deleteTableRows' || action === 'deleteTableColumns') return 'delete';
	// 行は上、列は左へ移動する。どちらでもない操作はこの分岐に入らない
	if (action === 'moveTableRowsUp' || action === 'moveTableColumnsLeft') return 'move-previous';
	// 行は下、列は右へ移動する。どちらでもない操作はこの分岐に入らない
	if (action === 'moveTableRowsDown' || action === 'moveTableColumnsRight') return 'move-next';
	return null;
}

/**
 * エクスポート既定ファイル名を作る
 * @param tab - タブ
 * @param ext - 拡張子
 * @returns 拡張子を付けたファイル名。使えない文字はアンダースコア
 */
function suggestedExportFileName(tab: TabRuntime, ext: 'html' | 'pdf'): string {
	// パスから拡張子を除いたファイル名。未保存は空文字
	const fromPath = tab.filePath ? tab.filePath.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '') : '';
	// 使えない文字を除いた基幹名。パスも題名も空なら「無題」
	const base     = (fromPath || tab.title || '無題').replace(/[\\/:*?"<>|]/g, '_').trim() || '無題';
	return `${base}.${ext}`;
}

/**
 * エクスポートに使うテーマを解決する
 * @param theme - 設定値
 * @returns 明暗の確定値。system は OS の配色
 */
function resolveExportTheme(theme: string): 'light' | 'dark' {
	// 設定が dark のときは暗いテーマで書き出す
	if (theme === 'dark') {
		return 'dark';
	}

	// 設定が light のときは明るいテーマで書き出す
	if (theme === 'light') {
		return 'light';
	}

	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
