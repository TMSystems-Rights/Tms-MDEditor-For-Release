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
import {
	applyTableAlignSnapshot,
	applyTableMergeSnapshot,
	applyTableStructureSnapshot,
	clearActiveTableMenuTarget,
	snapshotActiveTableMenu,
	snapshotTableMergeActionFromEvent,
	snapshotTableStructureActionFromEvent,
	TABLE_MENU_STATE_CHANGE_EVENT,
	type TableMergeMenuSnapshot,
	type TableStructureMenuSnapshot,
} from '../livePreview/tableWidget';
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
import {
	buildOutlineTree,
	collectOutlineAncestorFroms,
	collectFoldableOutlineFroms,
	collectOutlineItems,
	computeOutlineListScrollTop,
	findActiveOutlineItemIndex,
	jumpToOutlineItem,
	preserveEditorFocusOnOutlineMouseDown,
	type OutlineItem,
	type OutlineTreeNode,
} from '../outline/outline';
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
		mode         : 'default',
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
	private readonly panes = new Map<PaneId, PaneRuntime>([[AppController.INITIAL_PANE_ID, {
		paneId: AppController.INITIAL_PANE_ID,
		tabIds: [],
		activeTabId: null,
		editorStates: new Map(),
		viewModes: new Map()
	}]]);

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
		this.statusElements        = {
			cursor: document.getElementById('tmsMdeStatusCursor') as HTMLElement,
			charCount: document.getElementById('tmsMdeStatusCharCount') as HTMLElement,
			encoding: document.getElementById('tmsMdeStatusEncoding') as HTMLElement,
			eol: document.getElementById('tmsMdeStatusEol') as HTMLElement,
			viewMode: document.getElementById('tmsMdeStatusViewMode') as HTMLElement,
			zoom: document.getElementById('tmsMdeStatusZoom') as HTMLElement,
			largeFile: document.getElementById('tmsMdeStatusLargeFile') as HTMLElement,
			version: document.getElementById('tmsMdeStatusVersion') as HTMLElement
		};

		for (const element of Object.values(this.statusElements)) {
			element.tabIndex = -1;
		}

		document.getElementById('tmsMdeOutlineClose')?.addEventListener('click', () => {
			this.setOutlineVisible(false);
			this.editorView?.focus();
		});
		document.getElementById('tmsMdeOutlineExpandAll')?.addEventListener('mousedown', preserveEditorFocusOnOutlineMouseDown);
		document.getElementById('tmsMdeOutlineExpandAll')?.addEventListener('click', () => {
			this.expandAllOutline();
		});
		document.getElementById('tmsMdeOutlineCollapseAll')?.addEventListener('mousedown', preserveEditorFocusOnOutlineMouseDown);
		document.getElementById('tmsMdeOutlineCollapseAll')?.addEventListener('click', () => {
			this.collapseAllOutline();
		});
		this.outlineResizerElement.addEventListener('pointerdown', (event) => this.startOutlineResize(event));
		this.outlineResizerElement.addEventListener('pointermove', (event) => this.resizeOutline(event));
		this.outlineResizerElement.addEventListener('pointerup', (event) => this.finishOutlineResize(event, true));
		this.outlineResizerElement.addEventListener('pointercancel', (event) => this.finishOutlineResize(event, false));
		this.outlineResizerElement.addEventListener('keydown', (event) => this.resizeOutlineWithKeyboard(event));

		this.statusElements.encoding.addEventListener('click', () => {
			this.handleEncodingMenuClick();
		});

		this.statusElements.eol.addEventListener('click', () => {
			this.handleEolMenuClick();
		});

		this.statusElements.viewMode.addEventListener('click', () => {
			this.toggleActiveTabViewMode();
		});

		this.editorHostElement.addEventListener('contextmenu', (event) => {
			const surface = (event.target as HTMLElement | null)?.closest<HTMLElement>('.tms-mde-pane-editor-surface');
			if (!surface) {
				return;
			}

			event.preventDefault();
			const pane   = surface.closest<HTMLElement>('.tms-mde-editor-pane');
			const paneId = pane?.dataset.paneId as PaneId | undefined;
			if (paneId) {
				this.activatePane(paneId);
			}
			this.showEditorContextMenu(event);
		});

		this.editorHostElement.addEventListener(TABLE_MENU_STATE_CHANGE_EVENT, () => {
			this.syncNativeTableMenuState();
		});
		this.editorHostElement.addEventListener('mousedown', (event) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest('.cm-md-table-wrap')) return;
			const paneId = target?.closest<HTMLElement>('.tms-mde-editor-pane')?.dataset.paneId as PaneId | undefined;
			const view   = paneId ? this.editorViews.get(paneId) : null;
			if (view) clearActiveTableMenuTarget(view);
		}, true);

		this.statusElements.zoom.addEventListener('click', () => {
			if (getUiZoom() === 1) {
				return;
			}

			resetUiZoom();
		});

		bindUiZoom((zoom) => {
			this.updateUiZoomStatus(zoom);
			this.applyEditorZoom();
		});

		window.addEventListener(
			'keydown',
			(event) => {
				if (event.key === 'Escape') {
					this.dismissAllMenus();
				}

				void this.handleGlobalKeydown(event);
			},
			true
		);

		window.addEventListener(
			'dragover',
			(event) => {
				if (!isFileDrag(event.dataTransfer)) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				if (event.dataTransfer) {
					event.dataTransfer.dropEffect = 'copy';
				}
			},
			true
		);

		window.addEventListener(
			'drop',
			(event) => {
				if (!isFileDrag(event.dataTransfer)) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				this.dismissAllMenus();

				const files = event.dataTransfer?.files;
				if (!files || files.length === 0) {
					return;
				}

				// WebView2 では File.path が取れないため、C# 側へ AdditionalObjects として渡す
				postDroppedFiles(files);
			},
			true
		);

		document.addEventListener(
			'mousedown',
			(event) => {
				const target = event.target as HTMLElement | null;
				if (target?.closest('.tms-mde-context-menu')) {
					return;
				}

				this.dismissAllMenus();
			},
			true
		);

		this.editorHostElement.addEventListener('focusin', () => {
			this.dismissAllMenus();
		});

		onBridgeEvent(BRIDGE_EVENT.appReady, (payload) => {
			void this.handleAppReady(payload as AppReadyPayload);
		});

		onBridgeEvent(BRIDGE_EVENT.appOpenFiles, (payload) => {
			const files = (payload as { files?: string[] }).files ?? [];
			void this.openFilePaths(files);
		});

		onBridgeEvent(BRIDGE_EVENT.appQueryClose, () => {
			void this.handleQueryClose();
		});

		onBridgeEvent(BRIDGE_EVENT.uiDismissContextMenus, () => {
			dismissContextMenus();
		});

		onBridgeEvent(BRIDGE_EVENT.menuNewFile, () => {
			void this.createNewTab();
		});

		onBridgeEvent(BRIDGE_EVENT.menuOpenFile, () => {
			void this.openFileDialog();
		});

		onBridgeEvent(BRIDGE_EVENT.menuSave, () => {
			void this.saveActiveTab();
		});

		onBridgeEvent(BRIDGE_EVENT.menuSaveAs, () => {
			void this.saveAsActiveTab();
		});

		onBridgeEvent(BRIDGE_EVENT.menuExportHtml, () => {
			void this.exportActiveTab('html');
		});

		onBridgeEvent(BRIDGE_EVENT.menuExportPdf, () => {
			void this.exportActiveTab('pdf');
		});

		onBridgeEvent(BRIDGE_EVENT.menuPrint, () => {
			void this.printActiveTab();
		});

		onBridgeEvent(BRIDGE_EVENT.menuTableAction, (payload) => {
			const action = (payload as { action?: unknown }).action;
			if (isTableMenuAction(action)) void this.handleNativeTableMenuAction(action);
		});

		onBridgeEvent(BRIDGE_EVENT.menuToggleViewMode, () => {
			this.toggleActiveTabViewMode();
		});

		onBridgeEvent(BRIDGE_EVENT.menuToggleOutline, () => {
			this.toggleOutline();
		});

		onBridgeEvent(BRIDGE_EVENT.menuCollapseAllHeadings, () => {
			if (this.editorView) collapseAllHeadings(this.editorView);
		});

		onBridgeEvent(BRIDGE_EVENT.menuExpandAllHeadings, () => {
			if (this.editorView) expandAllHeadings(this.editorView);
		});

		onBridgeEvent(BRIDGE_EVENT.appExternalFileChanged, (payload) => {
			const externalChange = payload as { filePath?: string; kind?: 'changed' | 'deleted' | 'renamed' };
			if (externalChange.filePath) void this.handleExternalFileChanged(externalChange.filePath, externalChange.kind ?? 'changed');
		});
		onBridgeEvent(BRIDGE_EVENT.menuReloadWithEncoding, () => {
			void this.reloadActiveFileWithEncoding();
		});

		onBridgeEvent(BRIDGE_EVENT.menuSplitHorizontal, () => {
			this.splitActiveView('horizontal');
		});

		onBridgeEvent(BRIDGE_EVENT.menuSplitVertical, () => {
			this.splitActiveView('vertical');
		});

		onBridgeEvent(BRIDGE_EVENT.menuUnsplit, () => {
			this.unsplitActiveView();
		});

		onBridgeEvent(BRIDGE_EVENT.menuFind, () => {
			this.openActiveSearchPanel('find');
		});

		onBridgeEvent(BRIDGE_EVENT.menuReplace, () => {
			this.openActiveSearchPanel('replace');
		});

		onBridgeEvent(BRIDGE_EVENT.menuFindNext, () => {
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'next');
			}
		});

		onBridgeEvent(BRIDGE_EVENT.menuFindPrevious, () => {
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'previous');
			}
		});

		onBridgeEvent(BRIDGE_EVENT.menuOpenSettings, () => {
			void this.openSettings();
		});

		onBridgeEvent(BRIDGE_EVENT.menuReloadCssSnippets, () => {
			void this.refreshCssSnippets(true);
		});

		onBridgeEvent(BRIDGE_EVENT.menuOpenSnippetsFolder, () => {
			void this.openSnippetsFolder();
		});

		onBridgeEvent(BRIDGE_EVENT.appReceiveDetachedTab, (payload) => {
			this.receiveDetachedTab(payload as DetachedTabDropPayload);
		});

		onBridgeEvent(BRIDGE_EVENT.menuCheckForUpdates, () => {
			void this.checkForUpdates();
		});

		onBridgeEvent(BRIDGE_EVENT.updateAvailable, (payload) => {
			const typed = payload as { release?: UpdateReleaseInfo; mode?: 'installer' | 'portable' };
			if (typed.release) this.showUpdateAvailableToast(typed.release, typed.mode);
		});

		onBridgeEvent(BRIDGE_EVENT.updateDownloadProgress, (payload) => {
			const progress = payload as UpdateDownloadProgress;
			const message  = `更新をダウンロード中です: ${progress.percent}%`;
			if (!this.updateDownloadToast) {
				this.updateDownloadToast = showActionToast(message, [{
					label  : 'キャンセル',
					/** ネイティブ側で共有しているダウンロード用キャンセルトークンを停止する */
					onClick: () => void invokeBridge(BRIDGE_METHOD.updateCancelDownload)
				}]);
			} else {
				this.updateDownloadToast.updateMessage(message);
			}
		});

		onBridgeEvent(BRIDGE_EVENT.updateDownloadCompleted, (payload) => {
			this.dismissUpdateDownloadToast();
			const version = (payload as { version?: string }).version ?? '';
			showActionToast(`バージョン ${version} の更新をダウンロードしました。`, [
				{ label: '今すぐ更新', /** アプリを閉じた後に検証済みインストーラーを起動する */
					onClick: () => void invokeBridge(BRIDGE_METHOD.updateApplyNow) },
				{ label: '後で', /** インストーラーを起動せず通知だけ閉じる */
					onClick: () => undefined }
			]);
		});

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
			const result = await invokeBridge<UpdateCheckResponse>(BRIDGE_METHOD.updateCheck);
			if (result.status === 'available' && result.release) {
				this.showUpdateAvailableToast(result.release, result.mode);
				return;
			}
			showToast(result.status === 'not-available' ? '現在のバージョンは最新です。' : result.message ?? '更新を確認できませんでした。');
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
		if (mode === 'portable' || this.isPortable) {
			showActionToast(`新しいバージョン v${release.version} があります。公式ページからポータブル ZIP 版をダウンロードしてください。`, [
				{
					label  : '公式ダウンロードページを開く',
					/** ポータブル版は自動更新できないため、手動取得先へ案内する */
					onClick: () => void invokeBridge(BRIDGE_METHOD.updateOpenOfficialPage)
				},
				{ label: '後で', /** 今回の通知だけを閉じ、次回以降の確認は維持する */
					onClick: () => undefined },
				{
					label  : 'このバージョンをスキップ',
					/** 同じリリースを次回の起動時チェックで再通知しない */
					onClick: () => void invokeBridge(BRIDGE_METHOD.updateSkipVersion, { version: release.version })
				}
			]);
			return;
		}

		showActionToast(`新しいバージョン v${release.version} があります。`, [
			{ label: 'ダウンロード', /** UIを塞がず、進捗通知付きで取得を開始する */
				onClick: () => void this.downloadUpdate() },
			{ label: 'このバージョンをスキップ', /** 同じリリースを以後の自動確認から除外する */
				onClick: () => void invokeBridge(BRIDGE_METHOD.updateSkipVersion, { version: release.version }) }
		]);
	}

	/**
	 * 検出済み更新をダウンロードする
	 */
	private async downloadUpdate(): Promise<void> {
		try {
			const result = await invokeBridge<{ success: boolean; cancelled: boolean; message?: string }>(BRIDGE_METHOD.updateDownload);
			if (result.cancelled) {
				this.dismissUpdateDownloadToast();
				showToast(result.message ?? '更新のダウンロードをキャンセルしました。');
				return;
			}
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

		if (payload.config?.settings) {
			this.settings = this.mergeSettingsWithDefaults(payload.config.settings);
		}

		this.setOutlineVisible(this.settings.outline.visible);
		this.applyOutlineLayout();

		this.dataDirInfo = {
			dataDir: payload.config?.dataDir ?? '',
			defaultDataDir: payload.config?.defaultDataDir ?? ''
		};

		const compiled             = compileCustomDecorationRules(payload.config?.customDecorations);
		this.rawCustomDecorations  = payload.config?.customDecorations ?? [];
		this.customDecorationRules = compiled.rules;
		if (compiled.invalidNames.length > 0) {
			const names = compiled.invalidNames.join(', ');
			showToast(`カスタム装飾ルールを無効化しました: ${names}`);
		}

		applyTheme(payload.config?.theme ?? this.settings.theme);
		applyCodeFontFamily(this.settings.codeFontFamily);
		applyImageBorder(this.settings.imageBorder);
		this.loadNoteViewPositions(payload.noteViewPositions);
		await this.refreshCssSnippets(false);

		if (payload.config?.loadMessage) {
			showToast(payload.config.loadMessage);
		}
		if (payload.sessionLoadMessage) {
			showToast(payload.sessionLoadMessage);
		}

		const startupFiles = payload.files ?? [];
		if (payload.detachedTab) {
			this.openDetachedTab(payload.detachedTab);
			await writeLog('INFO', 'Detached tab window initialized.');
			return;
		}

		let restored = false;
		if (this.isSessionOwner && payload.session) {
			restored = await this.restoreSession(payload.session);
			if (!restored && !isEmptySessionSnapshot(payload.session)) showToast('前回のセッションを復元できなかったため、新しいタブで起動します。');
		}
		if (startupFiles.length > 0) {
			await this.openFilePaths(startupFiles);
		}

		if (!restored && this.tabs.length === 0) await this.createNewTab();
		await writeLog('INFO', 'Editor shell initialized.');
	}

	/**
	 * 別ウィンドウから引き渡されたタブ状態を復元する
	 * @param payload - 別ウィンドウから渡されたタブの本文と表示状態
	 */
	private openDetachedTab(payload: DetachedTabPayload): void {
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
		const tab     = this.createTabRuntime({
			filePath: payload.filePath,
			text: payload.text,
			encoding: payload.encoding,
			eol: payload.eol,
			eolMixed: payload.eolMixed,
			largeFile: payload.largeFile,
			viewMode: payload.viewMode,
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
		const tab         = this.createDetachedTabRuntime(payload.tab);
		const target      = document.elementFromPoint(payload.clientX, payload.clientY);
		const element     = target instanceof HTMLElement ? target : null;
		const tabBar      = element?.closest<HTMLElement>('.tms-mde-pane-tab-bar');
		const paneElement = element?.closest<HTMLElement>('.tms-mde-editor-pane');
		const paneId      = (tabBar?.dataset.paneId ?? paneElement?.dataset.paneId) as PaneId | undefined;

		this.tabs.push(tab);
		const targetPaneId = paneId && this.panes.has(paneId) ? paneId : this.activePaneId;
		const targetIndex  = tabBar ? this.calculateTabBarDropIndex(tabBar, payload.clientX) : this.panes.get(targetPaneId)?.tabIds.length ?? 0;
		this.addTabToPane(tab, targetPaneId);
		const pane = this.panes.get(targetPaneId);
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
		if (document.querySelector('.tms-mde-settings-backdrop')) {
			return;
		}

		try {
			const config     = await invokeBridge<ConfigGetResponse>(BRIDGE_METHOD.configGet);
			this.dataDirInfo = config.dataDirInfo;
			this.isPortable  = config.isPortable === true || config.dataDirInfo.isPortable === true;
			this.cssSnippets = await invokeBridge<CssSnippetsResponse>(BRIDGE_METHOD.cssSnippetsList);
			const modal      = new SettingsModal({
				settings: config.config.settings,
				customDecorations: config.config.customDecorations,
				dataDirInfo: config.dataDirInfo,
				isPortable: this.isPortable,
				cssSnippets: this.cssSnippets,
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
				const state = pane.editorStates.get(tab.tabId);
				if (state) pane.editorStates.set(tab.tabId, this.reconfigurePaneEditorState(tab, state, pane.viewModes.get(tab.tabId) ?? tab.viewMode));
			});
		});

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
		if (!this.workspaceElement) {
			return;
		}

		this.workspaceElement.classList.toggle(
			'is-outline-left',
			this.settings.outline?.side === 'left',
		);
		this.applyOutlineWidth(this.settings.outline.width);
	}

	/**
	 * アウトライン境界のドラッグを開始する
	 * @param event - ポインターイベント
	 */
	private startOutlineResize(event: PointerEvent): void {
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
		if (event.pointerId !== this.outlineResizePointerId) return;

		const rect  = this.workspaceElement.getBoundingClientRect();
		const width = calculateOutlineWidth(event.clientX, rect.left, rect.width, this.settings.outline.side);
		this.applyOutlineWidth(width);
	}

	/**
	 * アウトライン境界のドラッグを終了する
	 * @param event - ポインターイベント
	 * @param save - 最終幅を保存するか
	 */
	private finishOutlineResize(event: PointerEvent, save: boolean): void {
		if (event.pointerId !== this.outlineResizePointerId) return;

		if (this.outlineResizerElement.hasPointerCapture(event.pointerId)) {
			this.outlineResizerElement.releasePointerCapture(event.pointerId);
		}
		this.outlineResizePointerId = null;
		document.body.classList.remove('is-outline-resizing');

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
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

		event.preventDefault();
		const direction  = event.key === 'ArrowRight' ? 1 : -1;
		const sideFactor = this.settings.outline.side === 'left' ? 1 : -1;
		const current    = this.outlinePanelElement.getBoundingClientRect().width;
		const width      = current + direction * sideFactor * OUTLINE_KEYBOARD_RESIZE_STEP;
		this.applyOutlineWidth(width);
		void this.persistOutlineWidth(this.outlinePanelElement.getBoundingClientRect().width);
	}

	/**
	 * アウトライン幅を画面へ反映する
	 * @param width - 幅（px）
	 */
	private applyOutlineWidth(width: number): void {
		const normalized = clampOutlineWidth(width, this.workspaceElement.getBoundingClientRect().width);
		this.workspaceElement.style.setProperty('--tms-mde-outline-width', `${normalized}px`);
		this.outlineResizerElement.setAttribute('aria-valuenow', String(normalized));
	}

	/**
	 * 調整後のアウトライン幅を設定へ保存する
	 * @param width - 幅（px）
	 */
	private async persistOutlineWidth(width: number): Promise<void> {
		const normalized = clampOutlineWidth(width, this.workspaceElement.getBoundingClientRect().width);
		try {
			const result = await invokeBridge<SaveConfigResponse>(BRIDGE_METHOD.configUpdate, {
				settings: { outline: { width: normalized } },
			});
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
		const compiled             = compileCustomDecorationRules(rules);
		this.rawCustomDecorations  = rules;
		this.customDecorationRules = compiled.rules;
		this.applySettings(this.settings);
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
			if (notify) {
				const status = getCssSnippetsReloadStatus(this.cssSnippets);
				if (status.isError) {
					showErrorMessage(status.message);
				} else {
					showToast(status.message);
				}
			}
		} catch (error) {
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
		return {
			...DEFAULT_SETTINGS,
			...settings,
			showEolMarkers: settings.showEolMarkers ?? true,
			codeFontFamily: settings.codeFontFamily?.trim() || DEFAULT_CODE_FONT_FAMILY,
			update: {
				...DEFAULT_SETTINGS.update,
				...settings.update
			},
			cssSnippets: {
				...DEFAULT_SETTINGS.cssSnippets,
				...settings.cssSnippets
			},
			outline: {
				...DEFAULT_SETTINGS.outline,
				...settings.outline
			},
			export: {
				...DEFAULT_SETTINGS.export,
				...settings.export,
				outline: {
					...DEFAULT_SETTINGS.export.outline,
					...settings.export?.outline
				}
			},
			externalBrowser: {
				...DEFAULT_SETTINGS.externalBrowser,
				...settings.externalBrowser
			},
			keybindings: {
				...DEFAULT_SETTINGS.keybindings,
				...settings.keybindings
			},
			search: {
				...DEFAULT_SETTINGS.search,
				...settings.search
			},
			imageBorder: {
				...DEFAULT_SETTINGS.imageBorder,
				...settings.imageBorder
			},
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
		const defaultEol = this.parseDefaultEol(this.settings.newFileEol);
		const split      = splitPreservingEol('');
		const cm6Text    = toCm6Text(split.lines, split.eols);
		const tab        = this.createTabRuntime({
			filePath: null,
			text: cm6Text,
			encoding: this.parseDefaultEncoding(this.settings.newFileEncoding),
			eol: defaultEol,
			eolMixed: false,
			largeFile: false,
			viewMode: this.settings.defaultViewMode,
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
			const result = await invokeBridge<{ canceled: boolean; file?: TextFileInfo }>(BRIDGE_METHOD.fileOpenDialog);
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
		const existing = this.tabs.find((tab) => tab.filePath && tab.filePath.toLowerCase() === file.filePath.toLowerCase());

		if (existing) {
			const paneId = this.findPaneContainingTab(existing.tabId) ?? this.activePaneId;
			this.activateTab(existing.tabId, paneId);
		} else {
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
		const session = normalizeSessionSnapshot(value);
		if (!session) return false;

		const restoredTabs: TabRuntime[] = [];
		const runtimeBySessionTabId      = new Map<string, TabRuntime>();
		const runtimeByPath              = new Map<string, TabRuntime>();
		let skippedCount                 = 0;

		for (const savedTab of session.tabs) {
			try {
				const pathKey = savedTab.filePath.toLowerCase();
				let tab       = runtimeByPath.get(pathKey);
				if (!tab) {
					const file              = await invokeBridge<TextFileInfo>(BRIDGE_METHOD.fileOpen, { filePath: savedTab.filePath });
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

		const restoredPanes = new Map<PaneId, PaneRuntime>();
		for (const savedPane of session.panes) {
			const tabIds: string[] = [];
			const editorStates     = new Map<string, EditorState>();
			const viewModes        = new Map<string, ViewMode>();
			for (const savedTabId of savedPane.tabIds) {
				const tab = runtimeBySessionTabId.get(savedTabId);
				if (!tab || tabIds.includes(tab.tabId)) continue;
				const viewMode = tab.largeFile ? 'source' : savedPane.viewModes[savedTabId] ?? tab.viewMode;
				tabIds.push(tab.tabId);
				viewModes.set(tab.tabId, viewMode);
				editorStates.set(tab.tabId, this.createPaneEditorState(tab, tab.editorState.doc.toString(), viewMode));
			}
			if (tabIds.length === 0) continue;
			const activeTab = runtimeBySessionTabId.get(savedPane.activeTabId);
			restoredPanes.set(savedPane.paneId, {
				paneId: savedPane.paneId,
				tabIds,
				activeTabId: activeTab && tabIds.includes(activeTab.tabId) ? activeTab.tabId : tabIds[0],
				editorStates,
				viewModes,
			});
		}

		const paneLayout = prunePaneLayout(session.paneLayout, new Set(restoredPanes.keys()));
		if (!paneLayout || restoredPanes.size === 0) return false;

		this.editorViews.forEach((view) => view.destroy());
		this.editorViews.clear();
		this.panes.clear();
		restoredPanes.forEach((pane, paneId) => this.panes.set(paneId, pane));
		const usedTabIds  = new Set([...restoredPanes.values()].flatMap((pane) => pane.tabIds));
		this.tabs         = restoredTabs.filter((tab) => usedTabIds.has(tab.tabId));
		this.paneLayout   = paneLayout;
		this.activePaneId = restoredPanes.has(session.activePaneId) ? session.activePaneId : restoredPanes.keys().next().value!;
		this.activeTabId  = restoredPanes.get(this.activePaneId)?.activeTabId ?? this.tabs[0]?.tabId ?? null;
		this.mountActiveEditor();
		this.refreshStatusBar();
		void this.updateWindowTitle();

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
		const sizeBytes      = file.fileSizeBytes ?? new TextEncoder().encode(file.text).length;
		const thresholdBytes = this.settings.largeFileThresholdMb * 1024 * 1024;
		const largeFile      = isLargeFile(sizeBytes, thresholdBytes);
		const viewMode       = largeFile ? 'source' : preferredViewMode;
		const split          = splitPreservingEol(file.text);
		const cm6Text        = toCm6Text(split.lines, split.eols);
		return this.createTabRuntime({
			filePath: file.filePath,
			text: cm6Text,
			encoding: file.encoding,
			eol: file.primaryEol,
			eolMixed: file.eolMixed,
			largeFile,
			viewMode,
			lineEols: split.eols,
		});
	}

	/**
	 * タブをアクティブ化する
	 * @param tabId - タブ ID
	 * @param paneId - ペイン ID
	 * @param options - ユーザ操作なら recentFiles を更新する
	 */
	public activateTab(
		tabId: string,
		paneId: PaneId = this.activePaneId,
		options: { recordRecent?: boolean } = {},
	): void {
		const nextTab = this.tabs.find((tab) => tab.tabId === tabId);
		const pane    = this.panes.get(paneId);
		if (!nextTab || !pane) {
			return;
		}

		const alreadyActive = pane.activeTabId === tabId && this.activePaneId === paneId;

		// タブを離れる操作は、復元追従中でも現在画面の実測位置を残す意思表示になる
		this.persistActiveEditorState(true);
		void this.flushNoteViewPositions();
		if (!pane.tabIds.includes(tabId)) this.addTabToPane(nextTab, paneId);
		pane.activeTabId  = tabId;
		this.activePaneId = paneId;
		this.activeTabId  = tabId;
		this.renderTabBar();
		this.mountActiveEditor();
		this.refreshStatusBar();
		void this.updateWindowTitle();

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
		const tab  = this.tabs.find((entry) => entry.tabId === tabId);
		const pane = this.panes.get(paneId);
		if (!tab || !pane || !pane.tabIds.includes(tabId)) {
			return false;
		}

		const occurrenceCount = [...this.panes.values()].filter((entry) => entry.tabIds.includes(tabId)).length;
		if (!skipConfirm && occurrenceCount === 1 && tab.dirty) {
			const choice = await showCloseConfirmDialog(tab.title);
			if (choice === 'cancel') {
				return false;
			}

			if (choice === 'save') {
				const saved = await this.saveTab(tabId);
				if (!saved) {
					return false;
				}
			}
		}

		pane.tabIds = pane.tabIds.filter((entry) => entry !== tabId);
		pane.editorStates.delete(tabId);
		pane.viewModes.delete(tabId);
		if (occurrenceCount === 1) {
			this.tabs = this.tabs.filter((entry) => entry.tabId !== tabId);
			this.untitledNoteViewPositions.delete(tabId);
		}

		if (this.tabs.length === 0) {
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

		if (pane.tabIds.length === 0 && this.panes.size > 1) {
			const adjacentPaneId = findAdjacentPaneId(this.paneLayout, paneId);
			this.paneLayout      = removePane(this.paneLayout, paneId) ?? createPaneLayout(adjacentPaneId ?? AppController.INITIAL_PANE_ID);
			this.panes.delete(paneId);
			this.activePaneId = adjacentPaneId ?? listPaneIds(this.paneLayout)[0];
		} else if (pane.activeTabId === tabId) {
			pane.activeTabId = pane.tabIds[0] ?? null;
		}

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
		const tab = this.getActiveTab();
		if (!tab) {
			return false;
		}

		this.persistActiveEditorState();

		try {
			const dialogResult = await invokeBridge<{ canceled: boolean; filePath?: string }>(BRIDGE_METHOD.fileSaveAsDialog, {
				filePath: tab.filePath ?? undefined
			});

			if (dialogResult.canceled || !dialogResult.filePath) {
				return false;
			}

			const options = await showSaveAsOptionsDialog({
				defaultEncoding: tab.encoding,
				defaultEol: tab.eol
			});

			if (!options) {
				return false;
			}

			const text     = tab.editorState.doc.toString();
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
		const tab = this.getActiveTab();
		if (!tab) {
			showToast('エクスポートするタブがありません。');
			return;
		}

		const preparing = showToast('エクスポートを準備しています', 0);
		try {
			const prepared = await this.buildActiveExportHtml(kind === 'html' ? 'inline' : 'file');
			if (!prepared) {
				return;
			}

			const dialogResult = await invokeBridge<{ canceled: boolean; filePath?: string }>(BRIDGE_METHOD.fileExportDialog, {
				kind,
				suggestedName: suggestedExportFileName(tab, kind),
				filePath     : tab.filePath ?? undefined,
			});
			if (dialogResult.canceled || !dialogResult.filePath) {
				return;
			}

			if (kind === 'html') {
				const saved = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.fileWriteUtf8, {
					filePath: dialogResult.filePath,
					text    : prepared.html,
				});
				if (!saved.success) {
					throw new Error(saved.message ?? 'HTML の保存に失敗しました。');
				}

				showToast('HTML を保存しました。');
				return;
			}

			const printed = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.exportPrintToPdf, {
				html    : prepared.html,
				filePath: dialogResult.filePath,
				media   : prepared.media,
			});
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
		if (!this.getActiveTab()) {
			showToast('印刷するタブがありません。');
			return;
		}

		const preparing = showToast('印刷を準備しています', 0);
		try {
			const prepared = await this.buildActiveExportHtml('file');
			if (!prepared) {
				return;
			}

			const printed = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.exportShowPrintUi, {
				html : prepared.html,
				media: prepared.media,
			});
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
		const tab = this.getActiveTab();
		if (!tab) {
			return null;
		}

		const snippets = this.cssSnippets.snippets
			.filter((snippet) => snippet.enabled && !snippet.error && snippet.cssText)
			.map((snippet) => snippet.cssText);
		const media    = [] as ExportMediaFile[];

		const html = await renderExportHtml({
			markdown         : tab.editorState.doc.toString(),
			title            : tab.title || '無題',
			filePath         : tab.filePath,
			theme            : resolveExportTheme(this.settings.theme),
			editorFontFamily : this.settings.editorFontFamily,
			editorFontSize   : this.settings.editorFontSize,
			codeFontFamily   : this.settings.codeFontFamily,
			imageBorder      : this.settings.imageBorder,
			snippetsCss      : snippets,
			customDecorations: this.rawCustomDecorations,
			loadRemoteImages : this.settings.loadRemoteImages,
			outline          : this.settings.export.outline,
			resolveImage     : imageMode === 'file'
				? (request) => this.resolvePrintImage(request, media)
				: (request) => this.resolveExportImage(request),
			renderMermaid    : this.renderExportMermaid.bind(this),
		});
		return { html, media };
	}

	/**
	 * エクスポート用に画像を Data URL へ解決する
	 * @param request - 画像要求
	 * @returns 画像の Data URL。未解決のときは null
	 */
	private async resolveExportImage(request: ExportImageRequest): Promise<string | null> {
		if (request.kind === 'url') {
			return this.settings.loadRemoteImages || request.raw.startsWith('data:') ? request.raw : null;
		}

		try {
			const result = await invokeBridge<{ ok: boolean; dataUrl?: string }>(BRIDGE_METHOD.fileReadImageAsDataUrl, {
				path        : request.embed ? undefined : request.raw,
				embed       : request.embed ? request.raw : undefined,
				documentPath: request.documentPath ?? undefined,
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
		if (request.kind === 'url') {
			return this.settings.loadRemoteImages || request.raw.startsWith('data:') ? request.raw : null;
		}

		try {
			const result = await invokeBridge<{ ok: boolean; resolvedPath?: string }>(BRIDGE_METHOD.fileResolveLocalImage, {
				path        : request.embed ? undefined : request.raw,
				embed       : request.embed ? request.raw : undefined,
				documentPath: request.documentPath ?? undefined,
			});
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
	private async renderExportMermaid(
		source: string,
		theme: 'default' | 'dark',
	): Promise<ExportMermaidResult> {
		const result = await renderMermaidSource(source, theme);
		return result.ok ? { ok: true, svg: result.svg } : { ok: false, error: result.error };
	}

	/**
	 * 指定タブを保存する
	 * @param tabId - タブ ID
	 * @returns 保存成功時 true
	 */
	private async saveTab(tabId: string): Promise<boolean> {
		const tab = this.tabs.find((entry) => entry.tabId === tabId);
		if (!tab) {
			return false;
		}

		if (this.activeTabId === tabId) {
			this.persistActiveEditorState();
		}

		if (!tab.filePath) {
			return this.saveAsActiveTab();
		}

		const cm6Text    = tab.editorState.doc.toString();
		let diskText: string;
		let nextLineEols = tab.lineEols;
		let nextEol      = tab.eol;
		let nextMixed    = tab.eolMixed;

		if (tab.eolMixed) {
			const choice = await showEolMixedDialog();
			if (choice === 'cancel') {
				return false;
			}

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
		const tab = this.tabs.find((entry) => entry.tabId === tabId);
		if (!tab) {
			return false;
		}

		try {
			// 改行は diskText に既に反映済み。C# 側で再統一しない
			const result = await invokeBridge<SaveFileResult>(BRIDGE_METHOD.fileSave, {
				filePath,
				text: diskText,
				encoding
			});

			if (!result.success) {
				return false;
			}

			const split   = splitPreservingEol(diskText);
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
				if (this.panes.get(paneId)?.activeTabId !== tabId) return;
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

		const dirtyTabs = this.tabs.filter((tab) => tab.dirty);

		for (const tab of dirtyTabs) {
			const choice = await showCloseConfirmDialog(tab.title);
			if (choice === 'cancel') {
				await invokeBridge(BRIDGE_METHOD.appReportCloseReady, { allowClose: false });
				return;
			}

			if (choice === 'save') {
				const saved = await this.saveTab(tab.tabId);
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
		if (!this.isSessionOwner) return;
		this.persistActiveEditorState();
		const snapshot = createSessionSnapshot({
			tabs: this.tabs.map((tab) => ({ tabId: tab.tabId, filePath: tab.filePath })),
			panes: [...this.panes.values()].map((pane) => ({
				paneId: pane.paneId,
				tabIds: pane.tabIds,
				activeTabId: pane.activeTabId,
				viewModes: Object.fromEntries(pane.tabIds.map((tabId) => [tabId, pane.viewModes.get(tabId) ?? this.tabs.find((tab) => tab.tabId === tabId)?.viewMode ?? this.settings.defaultViewMode])),
			})),
			paneLayout: this.paneLayout,
			activePaneId: this.activePaneId,
		}) ?? {
			schemaVersion: SESSION_SCHEMA_VERSION,
			tabs: [],
			panes: [],
			paneLayout: createPaneLayout(AppController.INITIAL_PANE_ID),
			activePaneId: AppController.INITIAL_PANE_ID,
		};

		try {
			const result = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.sessionSave, snapshot as unknown as Record<string, unknown>);
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
		if (document.querySelector('.tms-mde-dialog-backdrop')) {
			return;
		}

		if (event.key === 'Escape' && this.editorView && closeOpenSearchPanel(this.editorView)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		const keybindings = this.settings.keybindings;
		if (matchesShortcut(event, keybindings?.splitHorizontal ?? 'Ctrl+Shift+-')) {
			event.preventDefault();
			this.splitActiveView('horizontal');
			return;
		}

		if (matchesShortcut(event, keybindings?.splitVertical ?? 'Ctrl+Shift+\\')) {
			event.preventDefault();
			this.splitActiveView('vertical');
			return;
		}

		if (matchesShortcut(event, keybindings?.unsplit ?? 'Ctrl+Shift+U')) {
			event.preventDefault();
			this.unsplitActiveView();
			return;
		}

		if (handleUiZoomKeydown(event)) {
			return;
		}

		if (matchesShortcut(event, keybindings.save)) {
			event.preventDefault();
			await this.saveActiveTab();
			return;
		}

		if (matchesShortcut(event, keybindings.saveAs)) {
			event.preventDefault();
			await this.saveAsActiveTab();
			return;
		}

		if (matchesShortcut(event, keybindings.exportHtml ?? 'Ctrl+Shift+H')) {
			event.preventDefault();
			await this.exportActiveTab('html');
			return;
		}

		if (matchesShortcut(event, keybindings.exportPdf ?? 'Ctrl+Shift+P')) {
			event.preventDefault();
			await this.exportActiveTab('pdf');
			return;
		}

		if (matchesShortcut(event, keybindings.print ?? 'Ctrl+P')) {
			event.preventDefault();
			await this.printActiveTab();
			return;
		}

		if (matchesShortcut(event, keybindings.pastePlain ?? 'Ctrl+Shift+V')) {
			const target = event.target;
			if (target instanceof Element && (
				target.closest('.cm-md-table')
				|| target.closest('.cm-search')
				|| target.closest('.tms-mde-dialog-backdrop')
				|| target.closest('.tms-mde-settings-backdrop')
			)) {
				return;
			}

			event.preventDefault();
			this.suppressSmartPaste = true;
			if (this.editorView && !this.editorView.state.readOnly) {
				await this.pasteIntoEditor(this.editorView, 'plain');
			}

			window.setTimeout(() => {
				this.suppressSmartPaste = false;
			}, 0);
			return;
		}

		if (matchesShortcut(event, keybindings.openFile)) {
			event.preventDefault();
			await this.openFileDialog();
			return;
		}

		if (matchesShortcut(event, keybindings.newFile)) {
			event.preventDefault();
			await this.createNewTab();
			return;
		}

		if (matchesShortcut(event, keybindings.closeTab)) {
			event.preventDefault();
			if (this.activeTabId) {
				await this.closeTab(this.activeTabId);
			}
			return;
		}

		if (matchesShortcut(event, keybindings.nextTab)) {
			event.preventDefault();
			this.switchTab(1);
			return;
		}

		if (matchesShortcut(event, keybindings.prevTab)) {
			event.preventDefault();
			this.switchTab(-1);
			return;
		}

		if (matchesShortcut(event, keybindings.find)) {
			event.preventDefault();
			event.stopPropagation();
			this.openActiveSearchPanel('find');
			return;
		}

		if (matchesShortcut(event, keybindings.replace)) {
			event.preventDefault();
			event.stopPropagation();
			this.openActiveSearchPanel('replace');
			return;
		}

		if (matchesShortcut(event, keybindings.findPrev)) {
			event.preventDefault();
			event.stopPropagation();
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'previous');
			}
			return;
		}

		if (matchesShortcut(event, keybindings.findNext)) {
			event.preventDefault();
			event.stopPropagation();
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'next');
			}
			return;
		}

		const toggleViewModeShortcut = this.settings.keybindings.toggleViewMode;
		if (matchesShortcut(event, toggleViewModeShortcut)) {
			event.preventDefault();
			this.toggleActiveTabViewMode();
			return;
		}

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
		const tab = this.tabs.find((entry) => entry.filePath?.toLowerCase() === filePath.toLowerCase());
		if (!tab) return;
		if (kind !== 'changed') {
			tab.dirty = true;
			this.renderTabBar();
			this.refreshStatusBar();
			const action = kind === 'deleted' ? '削除' : 'リネーム';
			showActionToast(`外部で${action}されました: ${tab.title}`, [{
				label  : '無視',
				/** ディスク側が消えても、現在のバッファは未保存のまま保持する */
				onClick: () => showToast(`現在の編集内容を保持します: ${tab.title}`)
			}]);
			return;
		}
		if (tab.dirty || this.settings.externalChangeBehavior === 'confirm') {
			showActionToast(`外部で変更されました: ${tab.title}`, [
				{
					label  : '再読込（編集を破棄）',
					/** ユーザーの明示操作時だけ、未保存バッファをディスク内容で置き換える */
					onClick: () => void this.reloadExternalFile(tab)
				},
				{
					label  : '無視',
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
			if (!tab.filePath) return;
			const file    = await invokeBridge<TextFileInfo>(BRIDGE_METHOD.fileOpen, { filePath: tab.filePath });
			const split   = splitPreservingEol(file.text);
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
		const pane = this.panes.get(this.activePaneId);
		if (!pane?.activeTabId || pane.tabIds.length <= 1) {
			return;
		}

		const currentIndex = pane.tabIds.indexOf(pane.activeTabId);
		const nextIndex    = (currentIndex + offset + pane.tabIds.length) % pane.tabIds.length;
		this.activateTab(pane.tabIds[nextIndex], pane.paneId, { recordRecent: true });
	}

	/**
	 * 文字コードメニューを処理する
	 */
	private handleEncodingMenuClick(): void {
		const tab = this.getActiveTab();
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
		const tab = this.getActiveTab();
		if (!tab || !this.editorView) {
			return;
		}

		showEolConvertMenu(this.statusElements.eol, (targetEol) => {
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
		if (!this.settings.showEolMarkers) {
			return;
		}

		const tabId = this.activeTabId;
		this.editorViews.forEach((view, paneId) => {
			if (this.panes.get(paneId)?.activeTabId !== tabId) return;
			view.dispatch({
				effects: setLineEolsEffect.of(lineEols)
			});
		});
	}

	/** 指定文字コードでアクティブファイルを再読込する */
	private async reloadActiveFileWithEncoding(): Promise<void> {
		const tab = this.getActiveTab();
		if (!tab?.filePath) {
			showToast('保存済みファイルを選択してください。');
			return;
		}
		if (tab.dirty) {
			showToast('未保存の変更があるため再読込できません。');
			return;
		}
		const encoding = await showReloadEncodingDialog(tab.encoding);
		if (!encoding) return;
		try {
			const file    = await invokeBridge<TextFileInfo>(BRIDGE_METHOD.fileOpenWithEncoding, { filePath: tab.filePath, encoding });
			const split   = splitPreservingEol(file.text);
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
		const tab  = this.getActiveTab();
		const pane = this.panes.get(this.activePaneId);
		if (!tab || !pane || tab.largeFile) {
			return;
		}

		const currentMode = pane.viewModes.get(tab.tabId) ?? tab.viewMode;
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
		const tab        = this.getActiveTab();
		const sourcePane = this.panes.get(this.activePaneId);
		if (!tab || !sourcePane) {
			return;
		}

		this.persistActiveEditorState();
		const paneId  = `pane-${crypto.randomUUID()}`;
		const splitId = `split-${crypto.randomUUID()}`;
		const state   = this.createPaneEditorState(tab, tab.editorState.doc.toString(), sourcePane.viewModes.get(tab.tabId) ?? tab.viewMode);
		this.panes.set(paneId, {
			paneId,
			tabIds: [tab.tabId],
			activeTabId: tab.tabId,
			editorStates: new Map([[tab.tabId, state]]),
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
		const sourcePane = this.panes.get(this.activePaneId);
		if (!sourcePane || this.panes.size <= 1) {
			return;
		}

		this.persistActiveEditorState();
		const targetPaneId = findAdjacentPaneId(this.paneLayout, sourcePane.paneId);
		const targetPane   = targetPaneId ? this.panes.get(targetPaneId) : null;
		if (!targetPane) return;

		for (const tabId of sourcePane.tabIds) {
			if (!targetPane.tabIds.includes(tabId)) targetPane.tabIds.push(tabId);
			const state = sourcePane.editorStates.get(tabId);
			if (state) targetPane.editorStates.set(tabId, state);
			const viewMode = sourcePane.viewModes.get(tabId);
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
			const tabBar = this.editorHostElement.querySelector<HTMLElement>(`.tms-mde-pane-tab-bar[data-pane-id="${pane.paneId}"]`);
			if (!tabBar) return;
			const scrollLeft = tabBar.scrollLeft;
			tabBar.innerHTML = '';
			pane.tabIds.forEach((tabId) => {
				const tab = this.tabs.find((entry) => entry.tabId === tabId);
				if (tab) this.renderPaneTab(tabBar, pane, tab);
			});
			tabBar.scrollLeft = scrollLeft;
			const activeTab   = tabBar.querySelector<HTMLElement>('.tms-mde-tab.is-active');
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
		const active     = tab.tabId === pane.activeTabId;
		const tabElement = createDraggableTabElement(document, active);

		tabElement.className      = `tms-mde-tab${active ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}`;
		tabElement.dataset.tabId  = tab.tabId;
		tabElement.dataset.paneId = pane.paneId;
		tabElement.title          = tab.filePath ?? tab.title;

		const title       = document.createElement('span');
		title.className   = 'tms-mde-tab-title';
		title.textContent = tab.title;
		tabElement.appendChild(title);

		if (tab.dirty) {
			const dot       = document.createElement('span');
			dot.className   = 'tms-mde-tab-dot';
			dot.textContent = '●';
			tabElement.appendChild(dot);
		}

		const close     = document.createElement('span');
		close.className = 'tms-mde-tab-close';
		close.setAttribute('aria-label', '閉じる');
		close.textContent = '×';
		tabElement.appendChild(close);

		tabElement.addEventListener('click', (event) => {
			const target = event.target as HTMLElement;
			if (target.classList.contains('tms-mde-tab-close')) {
				void this.closeTab(tab.tabId, pane.paneId);
				return;
			}

			this.activateTab(tab.tabId, pane.paneId, { recordRecent: true });
		});

		tabElement.addEventListener('auxclick', (event) => {
			if (event.button === 1) {
				event.preventDefault();
				void this.closeTab(tab.tabId, pane.paneId);
			}
		});

		tabElement.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.activePaneId = pane.paneId;
			this.activeTabId  = tab.tabId;
			this.showTabContextMenu(tab.tabId, event.clientX, event.clientY);
		});

		tabElement.addEventListener('dragstart', (event) => {
			this.tabDragSourceId     = tab.tabId;
			this.tabDragSourcePaneId = pane.paneId;
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('application/x-tms-mde-tab', tab.tabId);
			}
		});
		tabElement.addEventListener('dragend', (event) => {
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
		const target                = event.target;
		const onTab                 = target instanceof Element && Boolean(target.closest('.tms-mde-tab'));
		const onNewTabButton        = target instanceof Element && Boolean(target.closest('.tms-mde-new-tab-button'));
		const tabBarBox             = tabBar.getBoundingClientRect();
		const inHorizontalScrollbar = isPointInHorizontalScrollbar(
			{
				left        : tabBarBox.left,
				right       : tabBarBox.right,
				top         : tabBarBox.top,
				bottom      : tabBarBox.bottom,
				clientHeight: tabBar.clientHeight
			},
			event.clientX,
			event.clientY
		);
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

		const tab      = this.tabs.find((entry) => entry.tabId === tabId);
		const pane     = this.panes.get(this.activePaneId);
		const tabIndex = pane?.tabIds.indexOf(tabId) ?? -1;
		const entries  = this.buildConfiguredContextMenuEntries(
			this.settings.contextMenu.tabOrder,
			this.settings.contextMenu.tabHidden,
			{
				toggleViewMode : { shortcut: this.settings.keybindings.toggleViewMode, disabled: !tab || tab.largeFile },
				toggleOutline  : { shortcut: this.settings.keybindings.toggleOutline },
				splitHorizontal: { shortcut: this.settings.keybindings.splitHorizontal, disabled: !tab },
				splitVertical  : { shortcut: this.settings.keybindings.splitVertical, disabled: !tab },
				unsplit        : { shortcut: this.settings.keybindings.unsplit, disabled: this.panes.size <= 1 },
				close          : { shortcut: this.settings.keybindings.closeTab, disabled: !tab },
				closeOthers    : { disabled: !pane || pane.tabIds.length <= 1 },
				closeRight     : { disabled: !pane || tabIndex < 0 || tabIndex >= pane.tabIds.length - 1 },
				copyPath       : { disabled: !tab?.filePath },
				showInFolder   : { disabled: !tab?.filePath },
			}
		);

		showContextMenuAtPoint(x, y, entries, (action) => void this.handleTabContextAction(tabId, action));
	}

	/** 現在のアクティブペインから上部テーブルメニューの活性状態を同期する */
	private syncNativeTableMenuState(): void {
		const tab      = this.getActiveTab();
		const view     = this.editorView;
		const viewMode = tab
			? this.panes.get(this.activePaneId)?.viewModes.get(tab.tabId) ?? tab.viewMode
			: 'source';

		const snapshot = view ? snapshotActiveTableMenu(view) : null;
		const state    = buildTableMenuEnabledState({
			hasView       : view !== null,
			viewMode,
			readOnly      : view?.state.readOnly ?? true,
			inMarkdownTable: snapshot?.inMarkdownTable ?? false,
			structure     : snapshot?.structure ?? null,
			cells         : snapshot?.merge ?? null,
		});

		const json = JSON.stringify(state);
		if (json === this.lastTableMenuStateJson) return;
		this.lastTableMenuStateJson = json;
		void invokeBridge(BRIDGE_METHOD.uiUpdateTableMenuState, state).catch(() => undefined);
	}

	/**
	 * ネイティブのテーブルメニューから、右クリックと共通の処理を実行する
	 * @param action - ネイティブメニューから届いた表操作
	 */
	private async handleNativeTableMenuAction(action: TableMenuAction): Promise<void> {
		const tab  = this.getActiveTab();
		const view = this.editorView;
		if (!tab || !view) return;
		const viewMode = this.panes.get(this.activePaneId)?.viewModes.get(tab.tabId) ?? tab.viewMode;
		const snapshot = snapshotActiveTableMenu(view);
		const enabled  = buildTableMenuEnabledState({
			hasView       : true,
			viewMode,
			readOnly      : view.state.readOnly,
			inMarkdownTable: snapshot.inMarkdownTable,
			structure     : snapshot.structure,
			cells         : snapshot.merge,
		});
		if (!enabled[action]) return;

		await this.handleEditorContextAction(
			action,
			action === 'insertTable' ? view.state.selection.main.head : null,
			null,
			snapshot.merge,
			snapshot.structure,
		);
		this.syncNativeTableMenuState();
	}

	/**
	 * エディタコンテキストメニューを表示する
	 * @param event - 右クリックイベント
	 */
	private showEditorContextMenu(event: MouseEvent): void {
		dismissContextMenus();
		void invokeBridge(BRIDGE_METHOD.uiDismissMenus);

		const tab             = this.getActiveTab();
		const view            = this.editorView;
		const clickPosition   = view?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
		const checkboxAction  = view && clickPosition !== null
			? buildToggleTaskMarkerTransaction(view.state, clickPosition)
			: null;
		const linkUrl         = view ? findMarkdownLinkUrlFromMouseEvent(view, event) : null;
		const hasSelection    = Boolean(view && view.state.selection.ranges.some((range) => !range.empty));
		const tableMerge      = view ? snapshotTableMergeActionFromEvent(view, event) : null;
		const tableStructure  = view ? snapshotTableStructureActionFromEvent(view, event) : null;
		const viewMode        = tab
			? this.panes.get(this.activePaneId)?.viewModes.get(tab.tabId) ?? tab.viewMode
			: 'source';
		const inMarkdownTable = event.target instanceof Element && Boolean(event.target.closest('.cm-md-table-wrap'));
		const entries         = this.buildConfiguredContextMenuEntries(
			this.settings.contextMenu.editorOrder,
			this.settings.contextMenu.editorHidden,
			{
				undo           : { shortcut: 'Ctrl+Z', disabled: !view || undoDepth(view.state) === 0 },
				redo           : { shortcut: 'Ctrl+Y', disabled: !view || redoDepth(view.state) === 0 },
				cut            : { shortcut: 'Ctrl+X', disabled: !view || view.state.readOnly || !hasSelection },
				copy           : { shortcut: 'Ctrl+C', disabled: !hasSelection },
				paste          : { shortcut: 'Ctrl+V', disabled: !view || view.state.readOnly },
				pastePlain     : { shortcut: this.settings.keybindings.pastePlain ?? 'Ctrl+Shift+V', disabled: !view || view.state.readOnly },
				selectAll      : { shortcut: 'Ctrl+A', disabled: !view || view.state.doc.length === 0 },
				find           : { shortcut: this.settings.keybindings.find, disabled: !view },
				replace        : { shortcut: this.settings.keybindings.replace, disabled: !view || view.state.readOnly },
				toggleCheckbox : { shortcut: this.settings.keybindings.toggleCheckbox, hidden: !checkboxAction },
				insertTable    : { hidden: viewMode !== 'live-preview' || inMarkdownTable, disabled: !view || view.state.readOnly },
				insertTableRowsBefore: { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly },
				insertTableRowsAfter : { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly },
				deleteTableRows      : { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly || !tableStructure?.canDelete },
				moveTableRowsUp      : { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly || !tableStructure?.canMovePrevious },
				moveTableRowsDown    : { hidden: tableStructure?.axis !== 'row', disabled: !view || view.state.readOnly || !tableStructure?.canMoveNext },
				insertTableColumnsBefore: { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly },
				insertTableColumnsAfter : { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly },
				deleteTableColumns      : { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly || !tableStructure?.canDelete },
				moveTableColumnsLeft    : { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly || !tableStructure?.canMovePrevious },
				moveTableColumnsRight   : { hidden: tableStructure?.axis !== 'column', disabled: !view || view.state.readOnly || !tableStructure?.canMoveNext },
				mergeTableCells: { hidden: !tableMerge?.canMerge, disabled: !view || view.state.readOnly },
				unmergeTableCells: { hidden: !tableMerge?.canUnmerge, disabled: !view || view.state.readOnly },
				alignTableCellLeft  : { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				alignTableCellCenter: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				alignTableCellRight : { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				valignTableCellTop   : { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				valignTableCellMiddle: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				valignTableCellBottom: { hidden: !tableMerge, disabled: !view || view.state.readOnly },
				openLink       : { hidden: !linkUrl || !isSupportedExternalLinkUrl(linkUrl) },
				collapseAllHeadings: { disabled: !view || !hasFoldableHeadings(view.state) },
				expandAllHeadings  : { disabled: !view || !hasCollapsedHeadings(view.state) },
				toggleViewMode : { shortcut: this.settings.keybindings.toggleViewMode, disabled: !tab || tab.largeFile },
				toggleOutline  : { shortcut: this.settings.keybindings.toggleOutline },
				splitHorizontal: { shortcut: this.settings.keybindings.splitHorizontal, disabled: !tab },
				splitVertical  : { shortcut: this.settings.keybindings.splitVertical, disabled: !tab },
				unsplit        : { shortcut: this.settings.keybindings.unsplit, disabled: this.panes.size <= 1 },
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
		if (view.state.readOnly || shouldSkipEditorPasteCapture(event)) {
			return false;
		}

		event.preventDefault();
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
		if (view.state.readOnly) {
			return;
		}

		try {
			const result = await invokeBridge<PasteForEditorResult>(BRIDGE_METHOD.clipboardPasteForEditor, { mode });
			if (!result.ok) {
				showToast(result.error ?? '貼り付けに失敗しました。');
				return;
			}

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
	private buildConfiguredContextMenuEntries(
		order: string[],
		hiddenItems: string[],
		overrides: Record<string, Omit<ContextMenuEntry, 'id' | 'label'>>,
	): ContextMenuEntry[] {
		const hidden = new Set(hiddenItems);
		return order.map((itemId) => ({
			id       : itemId,
			label    : CONTEXT_MENU_ITEM_LABELS[itemId] ?? itemId,
			hidden   : hidden.has(itemId),
			separator: isContextMenuSeparator(itemId),
			...overrides[itemId],
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
	private async handleEditorContextAction(
		action: string,
		clickPosition: number | null,
		linkUrl: string | null,
		tableMerge?: TableMergeMenuSnapshot | null,
		tableStructure?: TableStructureMenuSnapshot | null,
	): Promise<void> {
		const view = this.editorView;
		if (!view) {
			return;
		}

		try {
			if (action === 'undo' || action === 'redo') {
				(action === 'undo' ? undo : redo)(view);
				view.focus();
				return;
			}

			if (action === 'copy' || action === 'cut') {
				const text = view.state.selection.ranges
					.map((range) => view.state.sliceDoc(range.from, range.to))
					.join(view.state.lineBreak);
				await invokeBridge(BRIDGE_METHOD.clipboardWriteText, { text });
				if (action === 'cut') {
					view.dispatch({ ...view.state.replaceSelection(''), userEvent: 'delete.cut' });
				}
				view.focus();
				return;
			}

			if (action === 'paste' || action === 'pastePlain') {
				await this.pasteIntoEditor(view, action === 'pastePlain' ? 'plain' : 'smart');
				view.focus();
				return;
			}

			if (action === 'selectAll') {
				selectAll(view);
				view.focus();
				return;
			}

			if (action === 'find' || action === 'replace') {
				this.openActiveSearchPanel(action);
				return;
			}

			if (action === 'insertTable') {
				const options = await showInsertTableDialog();
				if (!options) {
					view.focus();
					return;
				}
				const markdown = createMarkdownTable(options.columns, options.dataRows);
				const position = Math.min(clickPosition ?? view.state.selection.main.head, view.state.doc.length);
				view.dispatch({
					changes  : buildTableInsertionChange(view.state, position, markdown),
					userEvent: 'input.type',
				});
				view.focus();
				return;
			}

			const structureAction = tableStructureActionFromContextMenu(action);
			if (structureAction && tableStructure) {
				if (!applyTableStructureSnapshot(view, tableStructure, structureAction)) view.focus();
				return;
			}

			if ((action === 'mergeTableCells' || action === 'unmergeTableCells') && tableMerge) {
				if (!applyTableMergeSnapshot(
					view,
					tableMerge,
					action === 'mergeTableCells' ? 'merge' : 'unmerge',
				)) {
					view.focus();
				}
				return;
			}

			const alignPatch = tableAlignPatchFromAction(action);
			if (alignPatch && tableMerge) {
				if (!applyTableAlignSnapshot(view, tableMerge, alignPatch)) {
					view.focus();
				}
				return;
			}

			if (action === 'toggleCheckbox' && clickPosition !== null) {
				const spec = buildToggleTaskMarkerTransaction(view.state, Math.min(clickPosition, view.state.doc.length));
				if (spec) {
					view.dispatch(spec);
				}
				view.focus();
				return;
			}

			if (action === 'openLink' && linkUrl && isSupportedExternalLinkUrl(linkUrl)) {
				await invokeBridge(BRIDGE_METHOD.shellOpenExternal, { url: linkUrl });
				return;
			}

			if (action === 'collapseAllHeadings') {
				collapseAllHeadings(view);
				view.focus();
				return;
			}

			if (action === 'expandAllHeadings') {
				expandAllHeadings(view);
				view.focus();
				return;
			}

			if (action === 'toggleViewMode') {
				this.toggleActiveTabViewMode();
			} else if (action === 'toggleOutline') {
				this.toggleOutline();
			} else if (action === 'splitHorizontal' || action === 'splitVertical') {
				this.splitActiveView(action === 'splitHorizontal' ? 'horizontal' : 'vertical');
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
		const tab  = this.tabs.find((entry) => entry.tabId === tabId);
		const pane = this.panes.get(this.activePaneId);
		if (!tab || !pane) {
			return;
		}

		if (action === 'toggleViewMode') {
			this.activateTab(tabId, this.activePaneId, { recordRecent: true });
			this.toggleActiveTabViewMode();
			return;
		}

		if (action === 'toggleOutline') {
			this.toggleOutline();
			return;
		}

		if (action === 'splitHorizontal' || action === 'splitVertical') {
			this.activateTab(tabId, this.activePaneId, { recordRecent: true });
			this.splitActiveView(action === 'splitHorizontal' ? 'horizontal' : 'vertical');
			return;
		}

		if (action === 'unsplit') {
			this.activateTab(tabId, this.activePaneId, { recordRecent: true });
			this.unsplitActiveView();
			return;
		}

		if (action === 'close') {
			await this.closeTab(tabId);
			return;
		}

		if (action === 'closeOthers') {
			for (const otherTabId of [...pane.tabIds]) {
				if (otherTabId !== tabId) {
					const closed = await this.closeTab(otherTabId, pane.paneId);
					if (!closed) {
						break;
					}
				}
			}

			return;
		}

		if (action === 'closeRight') {
			const index = pane.tabIds.indexOf(tabId);
			for (const otherTabId of pane.tabIds.slice(index + 1)) {
				const closed = await this.closeTab(otherTabId, pane.paneId);
				if (!closed) {
					break;
				}
			}

			return;
		}

		if (action === 'copyPath') {
			await invokeBridge(BRIDGE_METHOD.clipboardWriteText, { text: tab.filePath ?? '' });
			return;
		}

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
		const sourcePane = this.panes.get(sourcePaneId);
		const targetPane = this.panes.get(targetPaneId);
		if (!sourcePane || !targetPane) return;
		const sourceIndex = sourcePane.tabIds.indexOf(sourceTabId);
		if (sourceIndex < 0) return;

		sourcePane.tabIds.splice(sourceIndex, 1);
		const existingIndex = targetPane.tabIds.indexOf(sourceTabId);
		if (existingIndex >= 0) targetPane.tabIds.splice(existingIndex, 1);
		const insertionIndex = targetIndex === undefined ? targetPane.tabIds.length : Math.min(Math.max(targetIndex, 0), targetPane.tabIds.length);
		targetPane.tabIds.splice(insertionIndex, 0, sourceTabId);
		const state = sourcePane.editorStates.get(sourceTabId);
		if (state) targetPane.editorStates.set(sourceTabId, state);
		const viewMode = sourcePane.viewModes.get(sourceTabId);
		if (viewMode) targetPane.viewModes.set(sourceTabId, viewMode);
		sourcePane.editorStates.delete(sourceTabId);
		sourcePane.viewModes.delete(sourceTabId);
		targetPane.activeTabId = sourceTabId;

		if (sourcePane.activeTabId === sourceTabId) sourcePane.activeTabId = sourcePane.tabIds[0] ?? null;
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
		const targetPane = this.panes.get(targetPaneId);
		const sourcePane = sourcePaneId ? this.panes.get(sourcePaneId) : null;
		if (!targetPane || (sourcePaneId && !sourcePane)) return;

		this.persistActiveEditorState();
		const paneId   = `pane-${crypto.randomUUID()}`;
		const splitId  = `split-${crypto.randomUUID()}`;
		const viewMode = sourcePane?.viewModes.get(tab.tabId) ?? tab.viewMode;
		const state    = sourcePane?.editorStates.get(tab.tabId) ?? this.createPaneEditorState(tab, tab.editorState.doc.toString(), viewMode);
		this.panes.set(paneId, {
			paneId,
			tabIds: [tab.tabId],
			activeTabId: tab.tabId,
			editorStates: new Map([[tab.tabId, state]]),
			viewModes: new Map([[tab.tabId, viewMode]])
		});
		this.paneLayout = splitPane(this.paneLayout, targetPaneId, paneId, splitId, placement.direction, placement.newPanePosition);

		if (sourcePane) {
			const keepOriginalView = sourcePane.paneId === targetPaneId && sourcePane.tabIds.length === 1;
			if (!keepOriginalView) {
				sourcePane.tabIds = sourcePane.tabIds.filter((tabId) => tabId !== tab.tabId);
				sourcePane.editorStates.delete(tab.tabId);
				sourcePane.viewModes.delete(tab.tabId);
				if (sourcePane.activeTabId === tab.tabId) sourcePane.activeTabId = sourcePane.tabIds[0] ?? null;
			}
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
		const tabs = [...tabBar.querySelectorAll<HTMLElement>('.tms-mde-tab')]
			.filter((element) => element.dataset.tabId !== excludedTabId);
		return calculateTabDropIndex(tabs.map((element) => element.getBoundingClientRect()), clientX);
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
		const excludedTabId         = this.tabDragSourcePaneId === paneId ? this.tabDragSourceId ?? undefined : undefined;
		const tabs                  = [...tabBar.querySelectorAll<HTMLElement>('.tms-mde-tab')]
			.filter((element) => element.dataset.tabId !== excludedTabId);
		const targetIndex           = calculateTabDropIndex(tabs.map((element) => element.getBoundingClientRect()), clientX);
		tabBar.dataset.tabDropIndex = String(targetIndex);
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
		const tab = this.tabs.find((entry) => entry.tabId === tabId);
		if (!tab) return;
		this.persistActiveEditorState();
		try {
			const result = await invokeBridge<{ detached: boolean }>(BRIDGE_METHOD.windowDetachTab, {
				screenX,
				screenY,
				tab: {
					title: tab.title,
					filePath: tab.filePath,
					text: tab.editorState.doc.toString(),
					savedText: tab.savedText,
					encoding: tab.encoding,
					eol: tab.eol,
					eolMixed: tab.eolMixed,
					dirty: tab.dirty,
					largeFile: tab.largeFile,
					viewMode: this.panes.get(paneId)?.viewModes.get(tabId) ?? tab.viewMode,
					lineEols: tab.lineEols
				}
			});
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
		if (node.kind === 'pane') return this.createPaneHost(node.paneId);

		const container           = document.createElement('div');
		container.className       = `tms-mde-pane-split is-${node.direction}`;
		container.dataset.splitId = node.splitId;
		const first               = this.renderPaneLayoutNode(node.first);
		const divider             = this.createSplitDivider(node, container);
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
		const pane = this.panes.get(paneId);
		if (!pane) throw new Error(`ペインが見つかりません: ${paneId}`);

		const host            = document.createElement('section');
		host.className        = 'tms-mde-editor-pane';
		host.dataset.paneId   = paneId;
		const tabWrap         = document.createElement('div');
		tabWrap.className     = 'tms-mde-pane-tab-bar-wrap';
		const tabBar          = document.createElement('div');
		tabBar.className      = 'tms-mde-pane-tab-bar';
		tabBar.dataset.paneId = paneId;
		tabBar.addEventListener('wheel', (event) => {
			if (applyTabBarWheelScroll(tabBar, event)) event.preventDefault();
		}, { passive: false });
		tabBar.addEventListener('dragover', (event) => {
			if (!this.tabDragSourceId) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			this.showTabBarDropIndicator(tabBar, paneId, event.clientX);
		});
		tabBar.addEventListener('dragleave', (event) => {
			if (event.relatedTarget instanceof Node && tabBar.contains(event.relatedTarget)) return;
			this.clearTabDropIndicators();
		});
		tabBar.addEventListener('drop', (event) => {
			event.preventDefault();
			event.stopPropagation();
			const targetIndex = Number.parseInt(tabBar.dataset.tabDropIndex ?? '', 10);
			this.clearTabDropIndicators();
			if (this.tabDragSourceId && this.tabDragSourcePaneId) {
				this.moveOrReorderTab(
					this.tabDragSourceId,
					this.tabDragSourcePaneId,
					paneId,
					Number.isFinite(targetIndex) ? targetIndex : this.calculateTabBarDropIndex(tabBar, event.clientX, this.tabDragSourcePaneId === paneId ? this.tabDragSourceId : undefined),
				);
			}
		});
		tabWrap.addEventListener('dblclick', (event) => {
			this.handleTabBarEmptyDoubleClick(event, paneId, tabBar);
		});
		const addButton       = document.createElement('button');
		addButton.type        = 'button';
		addButton.tabIndex    = -1;
		addButton.className   = 'tms-mde-new-tab-button';
		addButton.textContent = '＋';
		addButton.setAttribute('aria-label', 'このペインに新規タブ');
		addButton.addEventListener('click', () => {
			this.activePaneId = paneId;
			void this.createNewTab();
		});
		tabWrap.append(tabBar, addButton);

		const editorSurface     = document.createElement('div');
		editorSurface.className = 'tms-mde-pane-editor-surface';
		editorSurface.addEventListener('dragover', (event) => {
			if (!this.tabDragSourceId || !this.tabDragSourcePaneId) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			this.clearTabDropIndicators();
			const placement          = calculatePaneDropPlacement(host.getBoundingClientRect(), event.clientX, event.clientY);
			host.dataset.tabDropZone = placement.zone;
			editorSurface.classList.add('is-tab-drag-over');
		});
		editorSurface.addEventListener('dragleave', (event) => {
			if (event.relatedTarget instanceof Node && editorSurface.contains(event.relatedTarget)) return;
			this.clearTabDropIndicators();
		});
		editorSurface.addEventListener('drop', (event) => {
			if (!this.tabDragSourceId || !this.tabDragSourcePaneId) return;
			event.preventDefault();
			event.stopPropagation();
			const sourceTab = this.tabs.find((entry) => entry.tabId === this.tabDragSourceId);
			const placement = calculatePaneDropPlacement(host.getBoundingClientRect(), event.clientX, event.clientY);
			this.clearTabDropIndicators();
			if (sourceTab) this.splitTabIntoNewPane(sourceTab, paneId, placement, this.tabDragSourcePaneId);
		});
		host.append(tabWrap, editorSurface);
		const tab = pane.activeTabId ? this.tabs.find((entry) => entry.tabId === pane.activeTabId) : null;
		if (tab) {
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
		const view = mountEditorView(host, state, (transaction, sourceView) => this.dispatchEditorTransaction(transaction, sourceView));
		this.editorViews.set(paneId, view);
		this.applyDocumentContextToEditor(view, tab.filePath);
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
		if (sourceView === this.editorView) this.syncNativeTableMenuState();
		if (this.synchronizingSplitTransaction || !transaction.docChanged) {
			return;
		}

		const sourcePaneId = this.findPaneId(sourceView);
		const sourcePane   = sourcePaneId ? this.panes.get(sourcePaneId) : null;
		const tabId        = sourcePane?.activeTabId;
		if (!sourcePaneId || !tabId) return;
		this.synchronizingSplitTransaction = true;
		try {
			this.panes.forEach((pane, paneId) => {
				if (paneId === sourcePaneId || !pane.tabIds.includes(tabId)) return;
				const targetView  = pane.activeTabId === tabId ? this.editorViews.get(paneId) : null;
				const targetState = targetView?.state ?? pane.editorStates.get(tabId);
				if (!targetState) return;
				const synchronized = createSynchronizedTransaction(transaction, targetState);
				if (!synchronized) return;
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
		const view = this.editorViews.get(paneId);
		const pane = this.panes.get(paneId);
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
		const direction   = split.direction;
		const divider     = document.createElement('div');
		divider.className = 'tms-mde-split-divider';
		divider.tabIndex  = 0;
		divider.setAttribute('role', 'separator');
		divider.setAttribute('aria-label', direction === 'horizontal' ? '上下分割の境界' : '左右分割の境界');
		divider.setAttribute('aria-orientation', direction === 'horizontal' ? 'horizontal' : 'vertical');
		divider.setAttribute('aria-valuemin', '20');
		divider.setAttribute('aria-valuemax', '80');

		divider.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			divider.setPointerCapture(event.pointerId);
			divider.classList.add('is-dragging');
		});
		divider.addEventListener('pointermove', (event) => {
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
			if (divider.hasPointerCapture(event.pointerId)) {
				divider.releasePointerCapture(event.pointerId);
			}
			divider.classList.remove('is-dragging');
		};
		divider.addEventListener('pointerup', finishDrag);
		divider.addEventListener('pointercancel', finishDrag);
		divider.addEventListener('dblclick', () => {
			this.paneLayout = updateSplitRatio(this.paneLayout, split.splitId, 0.5);
			this.applySplitRatio({ ...split, ratio: 0.5 }, container);
		});
		divider.addEventListener('keydown', (event) => {
			const decreaseKey = direction === 'horizontal' ? 'ArrowUp' : 'ArrowLeft';
			const increaseKey = direction === 'horizontal' ? 'ArrowDown' : 'ArrowRight';
			if (event.key !== decreaseKey && event.key !== increaseKey) {
				return;
			}
			event.preventDefault();
			const delta     = event.key === decreaseKey ? -0.05 : 0.05;
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
		const rect      = container.getBoundingClientRect();
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
		const primary   = `${split.ratio}fr`;
		const secondary = `${1 - split.ratio}fr`;
		if (split.direction === 'horizontal') {
			container.style.gridTemplateColumns = 'minmax(0, 1fr)';
			container.style.gridTemplateRows    = `minmax(0, ${primary}) 6px minmax(0, ${secondary})`;
		} else {
			container.style.gridTemplateColumns = `minmax(0, ${primary}) 6px minmax(0, ${secondary})`;
			container.style.gridTemplateRows    = 'minmax(0, 1fr)';
		}

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
				filePath,
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
			const pane  = this.panes.get(paneId);
			const tabId = pane?.activeTabId;
			if (!pane || !tabId) return;
			pane.editorStates.set(tabId, view.state);
			const tab = this.tabs.find((entry) => entry.tabId === tabId);
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
			if (paneId === this.activePaneId) return;
			this.rememberNoteView(view, force);
		});
		const activeView = this.editorViews.get(this.activePaneId);
		if (activeView) this.rememberNoteView(activeView, force);
	}

	/**
	 * 表示位置の復元が終わるまで、先頭へのスクロールを保存しない
	 * @param view - エディタ
	 */
	private bindNoteViewPosition(view: EditorView): void {
		const position         = this.noteViewPositionForView(view);
		/**
		 * スクロールのたびに表示位置を記録する
		 */
		const rememberOnScroll = (): void => {
			this.scheduleRememberNoteView(view);
		};
		view.scrollDOM.addEventListener('scroll', rememberOnScroll, { passive: true });

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
				if (!view.dom.isConnected) return;
				if (!applied) this.revealSelectionLine(view);
				this.syncMountedCaret(view);
				this.noteViewCaptureReady.add(view);
			};
			window.requestAnimationFrame(finishAfterFrame);
		};
		// ペインDOMはこのメソッドの呼出し後にレイアウトへ接続される
		// 接続前に復元を始めると scrollDOM.isConnected が false になり、キャレット行表示へフォールバックしてしまう
		window.requestAnimationFrame(() => {
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
			if (!view.dom.isConnected) return;
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
		if (!view.dom.isConnected) return;
		view.dispatch(createCaretRedrawSpec(view.state.selection));
		if (this.editorViews.get(this.activePaneId) === view) view.focus();
	}

	/**
	 * 選択行が画面外なら、その行の上端までスクロールする
	 * @param view - エディタ
	 */
	private revealSelectionLine(view: EditorView): void {
		const scroller = view.scrollDOM;
		if (!scroller.isConnected || scroller.clientHeight <= 0) return;
		const block     = view.lineBlockAt(view.state.selection.main.head);
		const top       = scroller.scrollTop;
		const bottom    = top + scroller.clientHeight;
		const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		if (block.bottom >= top + 1 && block.top <= bottom - 1) return;
		scroller.scrollTop = Math.min(maxScroll, Math.max(0, block.top));
	}

	/**
	 * ビューに対応する保存済み表示位置を返す
	 * @param view - エディタ
	 * @returns 無ければ null
	 */
	private noteViewPositionForView(view: EditorView): NoteViewPosition | null {
		const tab = this.tabForView(view);
		if (!tab) return null;
		if (tab.filePath) return this.noteViewPositions.get(tab.filePath);
		return this.untitledNoteViewPositions.get(tab.tabId) ?? null;
	}

	/**
	 * スクロールや選択の直後は、次のフレームで表示位置を記録する
	 * 同じターンで行位置を読むと、Ctrl+End の末尾補正より先に計測が走り、見積もり高さで止まってしまう
	 * @param view - エディタ
	 */
	private scheduleRememberNoteView(view: EditorView): void {
		if (!this.noteViewCaptureReady.has(view)) return;
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
		if (!force && !this.noteViewCaptureReady.has(view)) return;
		const tab      = this.tabForView(view);
		const position = tab ? captureNoteViewPosition(view) : null;
		if (!tab || !position) return;
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
		const paneId = this.findPaneId(view);
		const pane   = paneId ? this.panes.get(paneId) : null;
		if (!pane?.activeTabId) return null;
		return this.tabs.find((tab) => tab.tabId === pane.activeTabId) ?? null;
	}

	/**
	 * 表示位置のディスク保存を少し遅らせる
	 */
	private scheduleNoteViewPositionSave(): void {
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
		const document = this.noteViewPositions.toDocument();
		const json     = JSON.stringify(document);
		if (json === this.lastNoteViewPositionJson) return;
		try {
			const result = await invokeBridge<{ success: boolean; message?: string }>(BRIDGE_METHOD.noteViewPositionsSave, document as unknown as Record<string, unknown>);
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
		const isDefault = zoom === 1;

		this.statusElements.zoom.textContent = formatUiZoomPercent(zoom);
		this.statusElements.zoom.classList.toggle('tms-mde-status-static', isDefault);
		this.statusElements.zoom.setAttribute('aria-label', isDefault ? '表示倍率' : '表示倍率（クリックで100%に戻す）');
	}

	/**
	 * エディタ本文の表示倍率を反映する
	 */
	private applyEditorZoom(): void {
		if (this.editorViews.size === 0) {
			return;
		}

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
		const tab = this.getActiveTab();
		if (!tab || !this.editorView) {
			return;
		}

		const selection = this.editorView.state.selection.main;
		const line      = this.editorView.state.doc.lineAt(selection.head);
		const column    = selection.head - line.from + 1;
		const charCount = this.editorView.state.doc.length;

		this.statusElements.cursor.textContent    = `行 ${line.number}, 列 ${column}`;
		this.statusElements.charCount.textContent = `${charCount} 文字`;
		this.statusElements.encoding.textContent  = formatEncodingLabel(tab.encoding);
		this.statusElements.eol.textContent       = formatEolLabel(tab.eol, tab.eolMixed);
		const viewMode                            = this.panes.get(this.activePaneId)?.viewModes.get(tab.tabId) ?? tab.viewMode;
		this.statusElements.viewMode.textContent  = viewMode === 'live-preview' ? 'ライブプレビュー' : 'ソース';
		this.statusElements.viewMode.classList.toggle('tms-mde-status-static', tab.largeFile);

		this.statusElements.largeFile.hidden = !tab.largeFile;
	}

	/**
	 * ウィンドウタイトルを更新する
	 */
	private async updateWindowTitle(): Promise<void> {
		const tab = this.getActiveTab();
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
		const paneId = this.findPaneId(view);
		const pane   = paneId ? this.panes.get(paneId) : null;
		const tab    = pane?.activeTabId ? this.tabs.find((entry) => entry.tabId === pane.activeTabId) : null;
		if (!tab || !pane || !paneId) {
			return;
		}

		const previousState = pane.editorStates.get(tab.tabId) ?? tab.editorState;
		const previousCm6   = previousState.doc.toString();
		const currentText   = view.state.doc.toString();
		pane.editorStates.set(tab.tabId, view.state);
		tab.editorState = view.state;

		if (this.synchronizingSplitTransaction) {
			return;
		}

		const previousLineEols = tab.lineEols;
		tab.lineEols           = syncLineEols(previousLineEols, previousCm6, currentText, tab.eol);
		tab.dirty              = currentText !== tab.savedText;
		this.renderTabBar();
		this.refreshStatusBar();
		if (view === this.editorView) {
			this.renderOutline();
		}
		void this.updateWindowTitle();

		// 本文だけの入力では装飾更新を dispatch しない。IME composition 中に
		// 行末ウィジェットを差し替えると、先頭のローマ字が確定・重複するため
		if (this.settings.showEolMarkers && tab.lineEols !== previousLineEols) {
			const lineEols = tab.lineEols;
			const tabId    = tab.tabId;
			queueMicrotask(() => {
				const active = this.getActiveTab();
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
		const paneId = this.findPaneId(view);
		const pane   = paneId ? this.panes.get(paneId) : null;
		const tab    = pane?.activeTabId ? this.tabs.find((entry) => entry.tabId === pane.activeTabId) : null;
		if (!tab || !pane || !paneId) {
			return;
		}

		pane.editorStates.set(tab.tabId, view.state);
		tab.editorState = view.state;
		this.scheduleRememberNoteView(view);
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
		if (visible) this.renderOutline();
	}

	/** アクティブペインの見出し一覧を描画する */
	private renderOutline(): void {
		if (!this.outlineVisible) return;

		this.outlineItems = this.editorView ? collectOutlineItems(this.editorView.state) : [];
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
		const wrap     = document.createElement('div');
		wrap.className = 'tms-mde-outline-node';
		const row      = document.createElement('div');
		row.className  = 'tms-mde-outline-row';
		row.style.setProperty('--tms-mde-outline-level', String(node.item.level));
		const hasChildren = node.children.length > 0;
		const collapsed   = hasChildren && this.outlineCollapsedFroms.has(node.item.from);

		if (hasChildren) {
			const twist       = document.createElement('button');
			twist.type        = 'button';
			twist.className   = 'tms-mde-outline-twist';
			twist.textContent = collapsed ? '▶' : '▼';
			twist.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
			twist.setAttribute('aria-label', collapsed ? '展開' : '折りたたむ');
			twist.addEventListener('mousedown', preserveEditorFocusOnOutlineMouseDown);
			twist.addEventListener('click', (event) => {
				event.stopPropagation();
				this.toggleOutlineFold(node.item.from);
			});
			row.appendChild(twist);
		} else {
			const spacer     = document.createElement('span');
			spacer.className = 'tms-mde-outline-twist is-leaf';
			spacer.setAttribute('aria-hidden', 'true');
			row.appendChild(spacer);
		}

		const button                = document.createElement('button');
		button.type                 = 'button';
		button.className            = 'tms-mde-outline-item';
		button.textContent          = node.item.title;
		button.title                = node.item.title;
		button.dataset.outlineIndex = String(node.index);
		button.addEventListener('mousedown', preserveEditorFocusOnOutlineMouseDown);
		button.addEventListener('click', () => this.jumpToOutlineItem(node.item));
		row.appendChild(button);
		wrap.appendChild(row);

		if (hasChildren) {
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
		const valid = new Set(collectFoldableOutlineFroms(tree));
		for (const from of [...this.outlineCollapsedFroms]) {
			if (!valid.has(from)) this.outlineCollapsedFroms.delete(from);
		}
	}

	/**
	 * 子を持つ見出しの開閉を切り替える
	 * @param from - 見出し位置
	 */
	private toggleOutlineFold(from: number): void {
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
		this.outlineCollapsedFroms = new Set(
			collectFoldableOutlineFroms(buildOutlineTree(this.outlineItems)),
		);
		this.renderOutline();
	}

	/** キャレット位置に対応する見出しを強調し、アウトラインの表示範囲へ収める */
	private updateOutlineActiveItem(): void {
		if (!this.outlineVisible || !this.editorView) return;

		const activeIndex = findActiveOutlineItemIndex(this.outlineItems, this.editorView.state.selection.main.head);
		let expanded      = false;
		for (const from of collectOutlineAncestorFroms(this.outlineItems, activeIndex)) {
			expanded = this.outlineCollapsedFroms.delete(from) || expanded;
		}
		if (expanded) {
			this.renderOutline();
			return;
		}

		this.outlineListElement.querySelectorAll<HTMLElement>('.tms-mde-outline-item').forEach((element) => {
			const active = Number(element.dataset.outlineIndex) === activeIndex;
			element.classList.toggle('is-active', active);
			if (active) {
				element.setAttribute('aria-current', 'location');
			} else {
				element.removeAttribute('aria-current');
			}
		});
		const activeElement = this.outlineListElement.querySelector<HTMLElement>(
			`.tms-mde-outline-item[data-outline-index="${activeIndex}"]`,
		);
		if (!activeElement) return;

		const itemRect        = activeElement.getBoundingClientRect();
		const viewportRect    = this.outlineListElement.getBoundingClientRect();
		const targetScrollTop = computeOutlineListScrollTop({
			itemTop      : itemRect.top,
			itemBottom   : itemRect.bottom,
			viewportTop  : viewportRect.top,
			viewportBottom: viewportRect.bottom,
			scrollTop    : this.outlineListElement.scrollTop,
			maxScrollTop : Math.max(0, this.outlineListElement.scrollHeight - this.outlineListElement.clientHeight),
		});
		this.outlineListElement.scrollTo({ top: targetScrollTop });
	}

	/**
	 * 選択した見出しへキャレットを移動する。スクロールは補正プラグインが行う
	 * @param item - 移動先の見出し
	 */
	private jumpToOutlineItem(item: OutlineItem): void {
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
		const selection = tab.editorState.selection.main;
		return createEditorState({
			text,
			settings: this.settings,
			viewMode,
			filePath: tab.filePath,
			lineEols: tab.lineEols,
			customDecorations: this.customDecorationRules,
			selection: { anchor: selection.anchor, head: selection.head },
			collapsedHeadingFroms: getCollapsedHeadingFroms(tab.editorState),
			/** 本文変更を処理する */
			onDocChange: (view) => this.handleDocumentChange(view),
			/** 選択変更を処理する */
			onSelectionChange: (view) => this.handleSelectionChange(view),
			/** 折りたたみ状態の変更を表示位置履歴へ保存する */
			onFoldChange: (view) => this.scheduleRememberNoteView(view),
			/** 貼り付けを処理する */
			onPaste: (event, view) => this.handleEditorPaste(event, view),
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
			text: state.doc.toString(),
			settings: this.settings,
			viewMode,
			filePath: tab.filePath,
			lineEols: tab.lineEols,
			customDecorations: this.customDecorationRules,
			/** 本文変更を処理する */
			onDocChange: (view) => this.handleDocumentChange(view),
			/** 選択変更を処理する */
			onSelectionChange: (view) => this.handleSelectionChange(view),
			/** 折りたたみ状態の変更を表示位置履歴へ保存する */
			onFoldChange: (view) => this.scheduleRememberNoteView(view),
			/** 貼り付けを処理する */
			onPaste: (event, view) => this.handleEditorPaste(event, view),
		});
	}

	/**
	 * タブランタイムを生成する
	 * @param options - 生成オプション
	 * @returns タブ
	 */
	private createTabRuntime(options: { filePath: string | null; text: string; encoding: EncodingKind; eol: EolKind; eolMixed: boolean; largeFile: boolean; viewMode: ViewMode; lineEols: Array<EolKind | null> }): TabRuntime {
		const tabId       = crypto.randomUUID();
		const savedView   = options.filePath ? this.noteViewPositions.get(options.filePath) : null;
		const editorState = createEditorState({
			text: options.text,
			settings: this.settings,
			viewMode: options.viewMode,
			filePath: options.filePath,
			lineEols: options.lineEols,
			customDecorations: this.customDecorationRules,
			selection: savedView ? selectionFromNoteViewPosition(savedView, options.text.length) : undefined,
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
			onPaste: (event, view) => this.handleEditorPaste(event, view),
		});

		return {
			tabId,
			title: buildTabTitle(options.filePath),
			filePath: options.filePath,
			encoding: options.encoding,
			eol: options.eol,
			eolMixed: options.eolMixed,
			dirty: false,
			savedText: options.text,
			viewMode: options.viewMode,
			largeFile: options.largeFile,
			lineEols: options.lineEols,
			editorState
		};
	}

	/**
	 * アクティブタブを取得する
	 * @returns タブ
	 */
	private getActiveTab(): TabRuntime | null {
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
		const pane = this.panes.get(paneId);
		if (!pane) return;
		if (!pane.tabIds.includes(tab.tabId)) pane.tabIds.push(tab.tabId);
		if (!pane.editorStates.has(tab.tabId)) pane.editorStates.set(tab.tabId, this.createPaneEditorState(tab, tab.editorState.doc.toString(), tab.viewMode));
		if (!pane.viewModes.has(tab.tabId)) pane.viewModes.set(tab.tabId, tab.viewMode);
	}

	/**
	 * 同じ文書を表示する全ペインへ本文置換を反映する
	 * @param tab - 本文を置き換えるタブ
	 * @param text - 新しい本文。改行は LF
	 */
	private replaceTabText(tab: TabRuntime, text: string): void {
		this.panes.forEach((pane, paneId) => {
			if (!pane.tabIds.includes(tab.tabId)) return;
			const view = pane.activeTabId === tab.tabId ? this.editorViews.get(paneId) : null;
			if (view) {
				replaceEditorText(view, text);
				pane.editorStates.set(tab.tabId, view.state);
				return;
			}
			const state = pane.editorStates.get(tab.tabId);
			if (state) pane.editorStates.set(tab.tabId, state.update({
				changes: { from: 0, to: state.doc.length, insert: text },
				annotations: Transaction.addToHistory.of(false)
			}).state);
		});
		tab.editorState = tab.editorState.update({
			changes: { from: 0, to: tab.editorState.doc.length, insert: text },
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
			paneId: AppController.INITIAL_PANE_ID,
			tabIds: [],
			activeTabId: null,
			editorStates: new Map(),
			viewModes: new Map()
		});
	}

	/**
	 * 既定文字コードを解決する
	 * @param value - 設定値
	 * @returns 文字コード
	 */
	private parseDefaultEncoding(value: string): EncodingKind {
		if (value === 'utf8Bom' || value === 'utf-8(bom)') {
			return 'utf8Bom';
		}

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
	if (action === 'alignTableCellLeft') {
		return { align: 'left' };
	}

	if (action === 'alignTableCellCenter') {
		return { align: 'center' };
	}

	if (action === 'alignTableCellRight') {
		return { align: 'right' };
	}

	if (action === 'valignTableCellTop') {
		return { valign: 'top' };
	}

	if (action === 'valignTableCellMiddle') {
		return { valign: 'middle' };
	}

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
	if (action === 'insertTableRowsBefore' || action === 'insertTableColumnsBefore') return 'insert-before';
	if (action === 'insertTableRowsAfter' || action === 'insertTableColumnsAfter') return 'insert-after';
	if (action === 'deleteTableRows' || action === 'deleteTableColumns') return 'delete';
	if (action === 'moveTableRowsUp' || action === 'moveTableColumnsLeft') return 'move-previous';
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
	const fromPath = tab.filePath
		? tab.filePath.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '')
		: '';
	const base     = (fromPath || tab.title || '無題').replace(/[\\/:*?"<>|]/g, '_').trim() || '無題';
	return `${base}.${ext}`;
}

/**
 * エクスポートに使うテーマを解決する
 * @param theme - 設定値
 * @returns 明暗の確定値。system は OS の配色
 */
function resolveExportTheme(theme: string): 'light' | 'dark' {
	if (theme === 'dark') {
		return 'dark';
	}

	if (theme === 'light') {
		return 'light';
	}

	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
