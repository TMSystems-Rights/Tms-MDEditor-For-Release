import { redo, redoDepth, selectAll, undo, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { invokeBridge, onBridgeEvent, postDroppedFiles, writeLog } from '../bridge';
import { createEditorState, mountEditorView, reconfigureEditorState, replaceEditorText } from '../editor/createEditor';
import { buildToggleTaskMarkerTransaction } from '../editor/checkboxToggle';
import { setLineEolsEffect } from '../editor/eolMarkers';
import { compileCustomDecorationRules, type CompiledCustomDecorationRule } from '../livePreview/customDecorations';
import { findMarkdownLinkUrlFromMouseEvent, isSupportedExternalLinkUrl, setDocumentContextEffect, setViewModeEffect } from '../livePreview/livePreviewPlugin';
import { showActionToast, showToast, type ToastHandle } from './toast';
import type { AppReadyPayload, AppSettings, ConfigGetResponse, CssSnippetsResponse, CustomDecorationRule, DataDirInfo, DetachedTabDropPayload, DetachedTabPayload, EncodingKind, EolKind, TabModel, TextFileInfo, UpdateCheckResponse, UpdateDownloadProgress, UpdateReleaseInfo, ViewMode } from '../types/app';
import { dismissContextMenus, showCloseConfirmDialog, showContextMenuAtPoint, showEncodingMenu, showEolConvertMenu, showEolMixedDialog, showErrorMessage, showReloadEncodingDialog, showSaveAsOptionsDialog, type ContextMenuEntry } from './dialogs';
import { applyTheme } from './theme';
import { bindUiZoom, computeZoomedFontSize, formatUiZoomPercent, getUiZoom, handleUiZoomKeydown, resetUiZoom } from './uiZoom';
import { buildTabTitle, buildWindowTitle, formatEncodingLabel, formatEolLabel, isLargeFile, normalizeEol } from '../utils/format';
import { createUniformLineEols, reconstructWithLineEols, splitPreservingEol, syncLineEols, toCm6Text } from '../utils/lineEol';
import { isFileDrag } from '../utils/dragDrop';
import { matchesShortcut } from '../utils/keybindings';
import { closeOpenSearchPanel, moveToSearchMatch, openFindPanel, openReplacePanel } from '../search/searchPanel';
import { calculateSplitRatio, createSynchronizedTransaction, type SplitDirection } from '../split/splitView';
import { createPaneLayout, findAdjacentPaneId, listPaneIds, removePane, splitPane, updateSplitRatio, type PaneId, type PaneLayoutNode, type PaneSplit } from '../split/paneLayout';
import { applyTabBarWheelScroll, revealElementInHorizontalScroller } from '../split/tabBarScroll';
import { calculatePaneDropPlacement, type PaneDropPlacement } from '../split/tabDrop';
import { SettingsModal } from '../settings/SettingsModal';
import { applyCssSnippets, getCssSnippetsReloadStatus } from '../settings/cssSnippets';
import { CONTEXT_MENU_ITEM_LABELS, createDefaultContextMenuSettings, isContextMenuSeparator, normalizeContextMenuSettings } from '../settings/contextMenuSettings';
import { createSessionSnapshot, isEmptySessionSnapshot, normalizeSessionSnapshot, prunePaneLayout, SESSION_SCHEMA_VERSION, type SessionSnapshot } from '../session/sessionState';
import {
	buildOutlineTree,
	collectFoldableOutlineFroms,
	collectOutlineItems,
	findActiveOutlineItemIndex,
	jumpToOutlineItem,
	preserveEditorFocusOnOutlineMouseDown,
	type OutlineItem,
	type OutlineTreeNode,
} from '../outline/outline';
import { renderExportHtml, type ExportImageRequest, type ExportMermaidResult } from '../export/renderExportHtml';
import { renderMermaidSource } from '../livePreview/mermaidWidget';

type TabRuntime = TabModel & {
	editorState: EditorState;
};

type PaneRuntime = {
	paneId: PaneId;
	tabIds: string[];
	activeTabId: string | null;
	editorStates: Map<string, EditorState>;
	viewModes: Map<string, ViewMode>;
};

type SaveFileResult = {
	success: boolean;
	filePath: string;
	encoding: EncodingKind;
	primaryEol: EolKind;
	eolMixed: boolean;
};

const DEFAULT_SETTINGS: AppSettings = {
	theme: 'system',
	editorFontFamily: '"Consolas", "BIZ UDゴシック", monospace',
	editorFontSize: 15,
	showLineNumbers: true,
	showEolMarkers: true,
	wordWrap: true,
	defaultViewMode: 'live-preview',
	tabSize: 4,
	largeFileThresholdMb: 2,
	loadRemoteImages: true,
	newFileEncoding: 'utf8',
	newFileEol: 'crlf',
	restoreSessionOnStartup: false,
	closeAppWhenLastTabClosed: false,
	externalChangeBehavior: 'auto-reload',
	instanceMode: 'single-instance',
	outline: {
		side: 'right'
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
		print: 'Ctrl+P'
	},
	search: {
		restoreCalloutFoldStateOnMove: false
	},
	contextMenu: createDefaultContextMenuSettings()
};

/**
 * アプリケーション全体を制御する
 */
export class AppController {
	private static readonly INITIAL_PANE_ID = 'pane-initial';

	private settings: AppSettings = DEFAULT_SETTINGS;

	private customDecorationRules: CompiledCustomDecorationRule[] = [];

	private rawCustomDecorations: CustomDecorationRule[] = [];

	private dataDirInfo: DataDirInfo = {
		dataDir: '',
		defaultDataDir: ''
	};

	private cssSnippets: CssSnippetsResponse = {
		directoryPath: '',
		snippets: []
	};

	private tabs: TabRuntime[] = [];

	private activeTabId: string | null = null;

	private editorView: EditorView | null = null;

	private updateDownloadToast: ToastHandle | null = null;

	private readonly editorViews = new Map<PaneId, EditorView>();

	private activePaneId: PaneId = AppController.INITIAL_PANE_ID;

	private paneLayout: PaneLayoutNode = createPaneLayout(AppController.INITIAL_PANE_ID);

	private readonly panes = new Map<PaneId, PaneRuntime>([[AppController.INITIAL_PANE_ID, {
		paneId: AppController.INITIAL_PANE_ID,
		tabIds: [],
		activeTabId: null,
		editorStates: new Map(),
		viewModes: new Map()
	}]]);

	private synchronizingSplitTransaction = false;

	private tabDragSourceId: string | null = null;

	private tabDragSourcePaneId: PaneId | null = null;

	private isSessionOwner = false;

	private readonly editorHostElement: HTMLElement;

	private readonly workspaceElement: HTMLElement;

	private readonly outlinePanelElement: HTMLElement;

	private readonly outlineListElement: HTMLElement;

	private readonly outlineEmptyElement: HTMLElement;

	private outlineVisible = false;

	private outlineItems: OutlineItem[] = [];

	private outlineCollapsedFroms = new Set<number>();

	private readonly statusElements: {
		cursor: HTMLElement;
		charCount: HTMLElement;
		encoding: HTMLElement;
		eol: HTMLElement;
		viewMode: HTMLElement;
		zoom: HTMLElement;
		largeFile: HTMLElement;
		version: HTMLElement;
	};

	/**
	 * AppController を初期化する
	 */
	public constructor() {
		this.editorHostElement   = document.getElementById('tmsMdeEditorHost') as HTMLElement;
		this.workspaceElement    = document.getElementById('tmsMdeWorkspace') as HTMLElement;
		this.outlinePanelElement = document.getElementById('tmsMdeOutlinePanel') as HTMLElement;
		this.outlineListElement  = document.getElementById('tmsMdeOutlineList') as HTMLElement;
		this.outlineEmptyElement = document.getElementById('tmsMdeOutlineEmpty') as HTMLElement;
		this.statusElements      = {
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

		onBridgeEvent('app:ready', (payload) => {
			void this.handleAppReady(payload as AppReadyPayload);
		});

		onBridgeEvent('app:openFiles', (payload) => {
			const files = (payload as { files?: string[] }).files ?? [];
			void this.openFilePaths(files);
		});

		onBridgeEvent('app:queryClose', () => {
			void this.handleQueryClose();
		});

		onBridgeEvent('ui:dismissContextMenus', () => {
			dismissContextMenus();
		});

		onBridgeEvent('menu:newFile', () => {
			void this.createNewTab();
		});

		onBridgeEvent('menu:openFile', () => {
			void this.openFileDialog();
		});

		onBridgeEvent('menu:save', () => {
			void this.saveActiveTab();
		});

		onBridgeEvent('menu:saveAs', () => {
			void this.saveAsActiveTab();
		});

		onBridgeEvent('menu:exportHtml', () => {
			void this.exportActiveTab('html');
		});

		onBridgeEvent('menu:exportPdf', () => {
			void this.exportActiveTab('pdf');
		});

		onBridgeEvent('menu:print', () => {
			void this.printActiveTab();
		});

		onBridgeEvent('menu:toggleViewMode', () => {
			this.toggleActiveTabViewMode();
		});

		onBridgeEvent('menu:toggleOutline', () => {
			this.toggleOutline();
		});

		onBridgeEvent('app:externalFileChanged', (payload) => {
			const externalChange = payload as { filePath?: string; kind?: 'changed' | 'deleted' | 'renamed' };
			if (externalChange.filePath) void this.handleExternalFileChanged(externalChange.filePath, externalChange.kind ?? 'changed');
		});
		onBridgeEvent('menu:reloadWithEncoding', () => {
			void this.reloadActiveFileWithEncoding();
		});

		onBridgeEvent('menu:splitHorizontal', () => {
			this.splitActiveView('horizontal');
		});

		onBridgeEvent('menu:splitVertical', () => {
			this.splitActiveView('vertical');
		});

		onBridgeEvent('menu:unsplit', () => {
			this.unsplitActiveView();
		});

		onBridgeEvent('menu:find', () => {
			this.openActiveSearchPanel('find');
		});

		onBridgeEvent('menu:replace', () => {
			this.openActiveSearchPanel('replace');
		});

		onBridgeEvent('menu:findNext', () => {
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'next');
			}
		});

		onBridgeEvent('menu:findPrevious', () => {
			if (this.editorView) {
				moveToSearchMatch(this.editorView, 'previous');
			}
		});

		onBridgeEvent('menu:openSettings', () => {
			void this.openSettings();
		});

		onBridgeEvent('menu:reloadCssSnippets', () => {
			void this.refreshCssSnippets(true);
		});

		onBridgeEvent('menu:openSnippetsFolder', () => {
			void this.openSnippetsFolder();
		});

		onBridgeEvent('app:receiveDetachedTab', (payload) => {
			this.receiveDetachedTab(payload as DetachedTabDropPayload);
		});

		onBridgeEvent('menu:checkForUpdates', () => {
			void this.checkForUpdates();
		});

		onBridgeEvent('update:available', (payload) => {
			const release = (payload as { release?: UpdateReleaseInfo }).release;
			if (release) this.showUpdateAvailableToast(release);
		});

		onBridgeEvent('update:downloadProgress', (payload) => {
			const progress = payload as UpdateDownloadProgress;
			const message  = `更新をダウンロード中です: ${progress.percent}%`;
			if (!this.updateDownloadToast) {
				this.updateDownloadToast = showActionToast(message, [{
					label  : 'キャンセル',
					/**
					 *
					 */
					onClick: () => void invokeBridge('update:cancelDownload')
				}]);
			} else {
				this.updateDownloadToast.updateMessage(message);
			}
		});

		onBridgeEvent('update:downloadCompleted', (payload) => {
			this.dismissUpdateDownloadToast();
			const version = (payload as { version?: string }).version ?? '';
			showActionToast(`バージョン ${version} の更新をダウンロードしました。`, [
				{ label: '今すぐ更新', /**
				 *
				 */
					onClick: () => void invokeBridge('update:applyNow') },
				{ label: '後で', /**
				 *
				 */
					onClick: () => undefined }
			]);
		});

		onBridgeEvent('update:error', (payload) => {
			this.dismissUpdateDownloadToast();
			showToast((payload as { message?: string }).message ?? '更新処理に失敗しました。');
		});
	}

	/**
	 * 手動で更新を確認する
	 * @returns {Promise<void>}
	 */
	private async checkForUpdates(): Promise<void> {
		try {
			const result = await invokeBridge<UpdateCheckResponse>('update:check');
			if (result.status === 'available' && result.release) {
				this.showUpdateAvailableToast(result.release);
				return;
			}
			showToast(result.status === 'not-available' ? '現在のバージョンは最新です。' : result.message ?? '更新を確認できませんでした。');
		} catch (error) {
			showToast(`更新を確認できませんでした: ${this.formatError(error)}`);
		}
	}

	/**
	 * 更新検出を操作付き Toast で通知する
	 * @param {UpdateReleaseInfo} release 更新情報
	 * @returns {void}
	 */
	private showUpdateAvailableToast(release: UpdateReleaseInfo): void {
		showActionToast(`新しいバージョン v${release.version} があります。`, [
			{ label: 'ダウンロード', /**
			 *
			 */
				onClick: () => void this.downloadUpdate() },
			{ label: 'このバージョンをスキップ', /**
			 *
			 */
				onClick: () => void invokeBridge('update:skipVersion', { version: release.version }) }
		]);
	}

	/**
	 * 検出済み更新をダウンロードする
	 * @returns {Promise<void>}
	 */
	private async downloadUpdate(): Promise<void> {
		try {
			const result = await invokeBridge<{ success: boolean; cancelled: boolean; message?: string }>('update:download');
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
	 * @returns {void}
	 */
	private dismissUpdateDownloadToast(): void {
		this.updateDownloadToast?.dismiss();
		this.updateDownloadToast = null;
	}

	/**
	 * アプリ起動イベントを処理する
	 * @param {AppReadyPayload} payload 起動情報
	 * @returns {Promise<void>}
	 */
	private async handleAppReady(payload: AppReadyPayload): Promise<void> {
		this.statusElements.version.textContent = `v${payload.version ?? 'unknown'}`;
		this.isSessionOwner                     = payload.isSessionOwner === true;

		if (payload.config?.settings) {
			this.settings = this.mergeSettingsWithDefaults(payload.config.settings);
		}

		this.applyOutlineSide();

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

	/** 別ウィンドウから引き渡されたタブ状態を復元する */
	private openDetachedTab(payload: DetachedTabPayload): void {
		const tab = this.createDetachedTabRuntime(payload);
		this.tabs.push(tab);
		this.addTabToPane(tab, this.activePaneId);
		this.activateTab(tab.tabId, this.activePaneId);
	}

	/** 引き渡しペイロードからタブ実行状態を生成する */
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

	/** 既存ウィンドウへ渡されたタブをドロップ位置へ配置する */
	private receiveDetachedTab(payload: DetachedTabDropPayload): void {
		const tab         = this.createDetachedTabRuntime(payload.tab);
		const target      = document.elementFromPoint(payload.clientX, payload.clientY);
		const element     = target instanceof HTMLElement ? target : null;
		const tabButton   = element?.closest<HTMLElement>('.tms-mde-tab');
		const tabBar      = element?.closest<HTMLElement>('.tms-mde-pane-tab-bar');
		const paneElement = element?.closest<HTMLElement>('.tms-mde-editor-pane');
		const paneId      = (tabButton?.dataset.paneId ?? tabBar?.dataset.paneId ?? paneElement?.dataset.paneId) as PaneId | undefined;

		this.tabs.push(tab);
		const targetPaneId = paneId && this.panes.has(paneId) ? paneId : this.activePaneId;
		this.addTabToPane(tab, targetPaneId);
		if (tabButton?.dataset.tabId) {
			const pane = this.panes.get(targetPaneId);
			if (pane) {
				pane.tabIds       = pane.tabIds.filter((tabId) => tabId !== tab.tabId);
				const targetIndex = pane.tabIds.indexOf(tabButton.dataset.tabId);
				pane.tabIds.splice(targetIndex >= 0 ? targetIndex : pane.tabIds.length, 0, tab.tabId);
			}
		}
		this.activateTab(tab.tabId, targetPaneId);
	}

	/**
	 * 設定モーダルを開く。
	 * @returns {Promise<void>}
	 */
	private async openSettings(): Promise<void> {
		if (document.querySelector('.tms-mde-settings-backdrop')) {
			return;
		}

		try {
			const config     = await invokeBridge<ConfigGetResponse>('config:get');
			this.dataDirInfo = config.dataDirInfo;
			this.cssSnippets = await invokeBridge<CssSnippetsResponse>('cssSnippets:list');
			const modal      = new SettingsModal({
				settings: config.config.settings,
				customDecorations: config.config.customDecorations,
				dataDirInfo: config.dataDirInfo,
				cssSnippets: this.cssSnippets,
				/**
				 *
				 */
				onSettingsApplied: (settings) => this.applySettings(settings),
				/**
				 *
				 */
				onCustomDecorationsApplied: (rules) => this.applyCustomDecorations(rules),
				/**
				 *
				 */
				onCssSnippetsApplied: (response) => {
					this.cssSnippets = response;
					applyCssSnippets(response);
				}
			});
			modal.open();
		} catch (error) {
			showErrorMessage(this.formatError(error));
		}
	}

	/**
	 * 保存済み設定を既存タブ・全ペインへ反映する。
	 * @param {AppSettings} settings 保存済み設定
	 * @returns {void}
	 */
	private applySettings(settings: AppSettings): void {
		this.persistActiveEditorState();

		const scrollPositions = new Map<PaneId, { left: number; top: number }>();
		this.editorViews.forEach((view, paneId) => {
			scrollPositions.set(paneId, {
				left: view.scrollDOM.scrollLeft,
				top: view.scrollDOM.scrollTop
			});
		});

		this.settings = this.mergeSettingsWithDefaults(settings);
		applyTheme(this.settings.theme);

		this.tabs.forEach((tab) => {
			tab.editorState = this.reconfigurePaneEditorState(tab, tab.editorState, tab.viewMode);
			this.panes.forEach((pane) => {
				const state = pane.editorStates.get(tab.tabId);
				if (state) pane.editorStates.set(tab.tabId, this.reconfigurePaneEditorState(tab, state, pane.viewModes.get(tab.tabId) ?? tab.viewMode));
			});
		});

		if (this.getActiveTab()) {
			this.mountActiveEditor();
			window.requestAnimationFrame(() => {
				scrollPositions.forEach((position, paneId) => {
					const view = this.editorViews.get(paneId);
					if (view) {
						view.scrollDOM.scrollLeft = position.left;
						view.scrollDOM.scrollTop  = position.top;
					}
				});
			});
		}

		this.applyOutlineSide();
		this.refreshStatusBar();
	}

	/**
	 * アウトラインパネルの左右配置を設定へ反映する。
	 * @returns {void}
	 */
	private applyOutlineSide(): void {
		if (!this.workspaceElement) {
			return;
		}

		this.workspaceElement.classList.toggle(
			'is-outline-left',
			this.settings.outline?.side === 'left',
		);
	}

	/**
	 * 保存済みカスタム装飾ルールを既存タブ・全ペインへ反映する。
	 * @param {CustomDecorationRule[]} rules 保存済みルール
	 * @returns {void}
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
	 * CSSスニペットを再読込し、Web UIへ適用する。
	 * @param {boolean} notify 完了通知を表示するか
	 * @returns {Promise<void>}
	 */
	private async refreshCssSnippets(notify: boolean): Promise<void> {
		try {
			this.cssSnippets = await invokeBridge<CssSnippetsResponse>('cssSnippets:list');
			applyCssSnippets(this.cssSnippets);
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
	 * CSSスニペットフォルダを開く。
	 * @returns {Promise<void>}
	 */
	private async openSnippetsFolder(): Promise<void> {
		try {
			await invokeBridge('cssSnippets:openFolder');
		} catch (error) {
			showErrorMessage(this.formatError(error));
		}
	}

	/**
	 * 欠落したネスト設定を既定値で補完する。
	 * @param {AppSettings} settings 設定
	 * @returns {AppSettings} 補完後設定
	 */
	private mergeSettingsWithDefaults(settings: AppSettings): AppSettings {
		return {
			...DEFAULT_SETTINGS,
			...settings,
			showEolMarkers: settings.showEolMarkers ?? true,
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
			contextMenu: normalizeContextMenuSettings(settings.contextMenu)
		};
	}

	/**
	 * 新規タブを作成する
	 * @returns {Promise<void>}
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
	 * @returns {Promise<void>}
	 */
	public async openFileDialog(): Promise<void> {
		try {
			const result = await invokeBridge<{ canceled: boolean; file?: TextFileInfo }>('file:openDialog');
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
	 * @param {string[]} filePaths ファイルパス一覧
	 * @returns {Promise<void>}
	 */
	public async openFilePaths(filePaths: string[]): Promise<void> {
		for (const filePath of filePaths) {
			try {
				const file = await invokeBridge<TextFileInfo>('file:open', { filePath });
				await this.openTextFileInfo(file);
			} catch (error) {
				showErrorMessage(this.formatError(error));
				await invokeBridge('recent:remove', { filePath });
			}
		}
	}

	/**
	 * 読み込み済みファイル情報からタブを開く
	 * @param {TextFileInfo} file ファイル情報
	 * @returns {Promise<void>}
	 */
	private async openTextFileInfo(file: TextFileInfo): Promise<void> {
		const existing = this.tabs.find((tab) => tab.filePath && tab.filePath.toLowerCase() === file.filePath.toLowerCase());

		if (existing) {
			const paneId = this.findPaneContainingTab(existing.tabId) ?? this.activePaneId;
			this.activateTab(existing.tabId, paneId);
			return;
		}

		const tab = this.createTabRuntimeFromTextFile(file);

		this.tabs.push(tab);
		this.addTabToPane(tab, this.activePaneId);
		this.activateTab(tab.tabId, this.activePaneId);
		await invokeBridge('recent:add', { filePath: file.filePath });
	}

	/** 保存済みセッションをディスク上の最新ファイル内容で復元する。 */
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
					const file              = await invokeBridge<TextFileInfo>('file:open', { filePath: savedTab.filePath });
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

	/** セッション内で最初に指定された表示モードを返す。 */
	private findSessionViewMode(session: SessionSnapshot, tabId: string): ViewMode {
		for (const pane of session.panes) {
			if (pane.tabIds.includes(tabId)) return pane.viewModes[tabId] ?? this.settings.defaultViewMode;
		}
		return this.settings.defaultViewMode;
	}

	/** ファイル読込結果をタブランタイムへ変換する。 */
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
	 * @param {string} tabId タブ ID
	 * @param {PaneId} [paneId] ペイン ID
	 * @returns {void}
	 */
	public activateTab(tabId: string, paneId: PaneId = this.activePaneId): void {
		const nextTab = this.tabs.find((tab) => tab.tabId === tabId);
		const pane    = this.panes.get(paneId);
		if (!nextTab || !pane) {
			return;
		}

		this.persistActiveEditorState();
		if (!pane.tabIds.includes(tabId)) this.addTabToPane(nextTab, paneId);
		pane.activeTabId  = tabId;
		this.activePaneId = paneId;
		this.activeTabId  = tabId;
		this.renderTabBar();
		this.mountActiveEditor();
		this.refreshStatusBar();
		void this.updateWindowTitle();
	}

	/**
	 * タブを閉じる
	 * @param {string} tabId タブ ID
	 * @param {PaneId} [paneId] ペイン ID
	 * @returns {Promise<boolean>} 閉じた場合 true
	 */
	public async closeTab(tabId: string, paneId: PaneId = this.activePaneId, skipConfirm = false): Promise<boolean> {
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
		if (occurrenceCount === 1) this.tabs = this.tabs.filter((entry) => entry.tabId !== tabId);

		if (this.tabs.length === 0) {
			if (this.settings.closeAppWhenLastTabClosed) {
				await this.persistSession();
				await invokeBridge('app:reportCloseReady', { allowClose: true });
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
	 * @returns {Promise<boolean>} 保存成功時 true
	 */
	public async saveActiveTab(): Promise<boolean> {
		if (!this.activeTabId) {
			return false;
		}

		return this.saveTab(this.activeTabId);
	}

	/**
	 * 名前を付けて保存する
	 * @returns {Promise<boolean>} 保存成功時 true
	 */
	public async saveAsActiveTab(): Promise<boolean> {
		const tab = this.getActiveTab();
		if (!tab) {
			return false;
		}

		this.persistActiveEditorState();

		try {
			const dialogResult = await invokeBridge<{ canceled: boolean; filePath?: string }>('file:saveAsDialog', {
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
	 * @param {'html' | 'pdf'} kind 出力種別
	 * @returns {Promise<void>}
	 */
	private async exportActiveTab(kind: 'html' | 'pdf'): Promise<void> {
		const tab = this.getActiveTab();
		if (!tab) {
			showToast('エクスポートするタブがありません。');
			return;
		}

		const preparing = showToast('エクスポートを準備しています', 0);
		try {
			const html = await this.buildActiveExportHtml();
			if (!html) {
				return;
			}

			const dialogResult = await invokeBridge<{ canceled: boolean; filePath?: string }>('file:exportDialog', {
				kind,
				suggestedName: suggestedExportFileName(tab, kind),
				filePath     : tab.filePath ?? undefined,
			});
			if (dialogResult.canceled || !dialogResult.filePath) {
				return;
			}

			if (kind === 'html') {
				const saved = await invokeBridge<{ success: boolean; message?: string }>('file:writeUtf8', {
					filePath: dialogResult.filePath,
					text    : html,
				});
				if (!saved.success) {
					throw new Error(saved.message ?? 'HTML の保存に失敗しました。');
				}

				showToast('HTML を保存しました。');
				return;
			}

			const printed = await invokeBridge<{ success: boolean; message?: string }>('export:printToPdf', {
				html,
				filePath: dialogResult.filePath,
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
	 * @returns {Promise<void>}
	 */
	private async printActiveTab(): Promise<void> {
		if (!this.getActiveTab()) {
			showToast('印刷するタブがありません。');
			return;
		}

		const preparing = showToast('印刷を準備しています', 0);
		try {
			const html = await this.buildActiveExportHtml();
			if (!html) {
				return;
			}

			const printed = await invokeBridge<{ success: boolean; message?: string }>('export:showPrintUI', { html });
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
	 * アクティブタブ本文から自己完結 HTML を生成する
	 * @returns {Promise<string | null>}
	 */
	private async buildActiveExportHtml(): Promise<string | null> {
		this.persistActiveEditorState();
		const tab = this.getActiveTab();
		if (!tab) {
			return null;
		}

		const snippets = this.cssSnippets.snippets
			.filter((snippet) => snippet.enabled && !snippet.error && snippet.cssText)
			.map((snippet) => snippet.cssText);

		return renderExportHtml({
			markdown         : tab.editorState.doc.toString(),
			title            : tab.title || '無題',
			filePath         : tab.filePath,
			theme            : resolveExportTheme(this.settings.theme),
			snippetsCss      : snippets,
			customDecorations: this.rawCustomDecorations,
			loadRemoteImages : this.settings.loadRemoteImages,
			outline          : this.settings.export.outline,
			resolveImage     : this.resolveExportImage.bind(this),
			renderMermaid    : this.renderExportMermaid.bind(this),
		});
	}

	/**
	 * エクスポート用に画像を Data URL へ解決する
	 * @param {ExportImageRequest} request 画像要求
	 * @returns {Promise<string | null>}
	 */
	private async resolveExportImage(request: ExportImageRequest): Promise<string | null> {
		if (request.kind === 'url') {
			return this.settings.loadRemoteImages || request.raw.startsWith('data:') ? request.raw : null;
		}

		try {
			const result = await invokeBridge<{ ok: boolean; dataUrl?: string }>('file:readImageAsDataUrl', {
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
	 * エクスポート用に Mermaid を SVG 化する
	 * @param {string} source ソース
	 * @param {'default' | 'dark'} theme テーマ
	 * @returns {Promise<ExportMermaidResult>}
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
	 * @param {string} tabId タブ ID
	 * @returns {Promise<boolean>} 保存成功時 true
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
	 * @param {string} tabId タブ ID
	 * @param {string} filePath 保存先
	 * @param {string} diskText ディスクへ書くテキスト（改行済み）
	 * @param {EncodingKind} encoding 文字コード
	 * @param {EolKind} eol 主要改行
	 * @param {Array<EolKind | null>} lineEols 行末マップ
	 * @param {boolean} [eolMixed] 混在フラグ
	 * @returns {Promise<boolean>} 成功時 true
	 */
	private async writeTab(tabId: string, filePath: string, diskText: string, encoding: EncodingKind, eol: EolKind, lineEols: Array<EolKind | null>, eolMixed?: boolean): Promise<boolean> {
		const tab = this.tabs.find((entry) => entry.tabId === tabId);
		if (!tab) {
			return false;
		}

		try {
			// 改行は diskText に既に反映済み。C# 側で再統一しない。
			const result = await invokeBridge<SaveFileResult>('file:save', {
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
			await invokeBridge('recent:add', { filePath: result.filePath });
			return true;
		} catch (error) {
			this.refreshStatusBar();
			showErrorMessage(this.formatError(error));
			return false;
		}
	}

	/**
	 * ウィンドウクローズ確認を処理する
	 * @returns {Promise<void>}
	 */
	private async handleQueryClose(): Promise<void> {
		this.persistActiveEditorState();

		const dirtyTabs = this.tabs.filter((tab) => tab.dirty);

		for (const tab of dirtyTabs) {
			const choice = await showCloseConfirmDialog(tab.title);
			if (choice === 'cancel') {
				await invokeBridge('app:reportCloseReady', { allowClose: false });
				return;
			}

			if (choice === 'save') {
				const saved = await this.saveTab(tab.tabId);
				if (!saved) {
					await invokeBridge('app:reportCloseReady', { allowClose: false });
					return;
				}
			}
		}

		await this.persistSession();
		await invokeBridge('app:reportCloseReady', { allowClose: true });
	}

	/** 主ウィンドウの保存可能なタブ・ペイン状態を session.json へ保存する。 */
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
			const result = await invokeBridge<{ success: boolean; message?: string }>('session:save', snapshot as unknown as Record<string, unknown>);
			if (!result.success) void writeLog('WARN', result.message ?? 'Session save failed.');
		} catch (error) {
			void writeLog('WARN', `Session save failed: ${this.formatError(error)}`);
		}
	}

	/**
	 * グローバルキーダウンを処理する
	 * @param {KeyboardEvent} event キーイベント
	 * @returns {Promise<void>}
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
	 * @param {string} filePath 変更されたファイルパス
	 * @returns {Promise<void>}
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
				/**
				 *
				 */
				onClick: () => showToast(`現在の編集内容を保持します: ${tab.title}`)
			}]);
			return;
		}
		if (tab.dirty || this.settings.externalChangeBehavior === 'confirm') {
			showActionToast(`外部で変更されました: ${tab.title}`, [
				{
					label  : '再読込（編集を破棄）',
					/**
					 *
					 */
					onClick: () => void this.reloadExternalFile(tab)
				},
				{
					label  : '無視',
					/**
					 *
					 */
					onClick: () => showToast(`現在の編集内容を保持します: ${tab.title}`)
				}
			]);
			return;
		}
		await this.reloadExternalFile(tab);
	}

	/**
	 * 外部変更されたファイルを読み直してタブへ反映する
	 * @param {TabRuntime} tab 再読込対象タブ
	 * @returns {Promise<void>}
	 */
	private async reloadExternalFile(tab: TabRuntime): Promise<void> {
		try {
			if (!tab.filePath) return;
			const file    = await invokeBridge<TextFileInfo>('file:open', { filePath: tab.filePath });
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
	 * @param {'find' | 'replace'} mode パネルモード
	 * @returns {void}
	 */
	private openActiveSearchPanel(mode: 'find' | 'replace'): void {
		if (!this.editorView) {
			return;
		}

		(mode === 'replace' ? openReplacePanel : openFindPanel)(this.editorView);
	}

	/**
	 * タブを切り替える
	 * @param {number} offset 移動量
	 * @returns {void}
	 */
	private switchTab(offset: number): void {
		const pane = this.panes.get(this.activePaneId);
		if (!pane?.activeTabId || pane.tabIds.length <= 1) {
			return;
		}

		const currentIndex = pane.tabIds.indexOf(pane.activeTabId);
		const nextIndex    = (currentIndex + offset + pane.tabIds.length) % pane.tabIds.length;
		this.activateTab(pane.tabIds[nextIndex], pane.paneId);
	}

	/**
	 * 文字コードメニューを処理する
	 * @returns {void}
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
	 * @returns {void}
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
	 * @param {Array<EolKind | null>} lineEols 行末マップ
	 * @returns {void}
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
			const file    = await invokeBridge<TextFileInfo>('file:openWithEncoding', { filePath: tab.filePath, encoding });
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

	/**
	 * アクティブタブの表示モードを切り替える
	 * @returns {void}
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
	}

	/**
	 * 表示モードをエディタへ反映する
	 * @param {ViewMode} viewMode 表示モード
	 * @returns {void}
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
	 * @param {SplitDirection} direction 分割方向
	 * @returns {void}
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
	 * @returns {void}
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

	/**
	 * タブバーを描画する
	 * @returns {void}
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

	/** ペインのタブを1件描画する */
	private renderPaneTab(tabBar: HTMLElement, pane: PaneRuntime, tab: TabRuntime): void {
		const button          = document.createElement('button');
		button.type           = 'button';
		button.tabIndex       = -1;
		button.className      = `tms-mde-tab${tab.tabId === pane.activeTabId ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}`;
		button.draggable      = true;
		button.dataset.tabId  = tab.tabId;
		button.dataset.paneId = pane.paneId;
		button.title          = tab.filePath ?? tab.title;

		const title       = document.createElement('span');
		title.className   = 'tms-mde-tab-title';
		title.textContent = tab.title;
		button.appendChild(title);

		if (tab.dirty) {
			const dot       = document.createElement('span');
			dot.className   = 'tms-mde-tab-dot';
			dot.textContent = '●';
			button.appendChild(dot);
		}

		const close     = document.createElement('span');
		close.className = 'tms-mde-tab-close';
		close.setAttribute('aria-label', '閉じる');
		close.textContent = '×';
		button.appendChild(close);

		button.addEventListener('click', (event) => {
			const target = event.target as HTMLElement;
			if (target.classList.contains('tms-mde-tab-close')) {
				void this.closeTab(tab.tabId, pane.paneId);
				return;
			}

			this.activateTab(tab.tabId, pane.paneId);
		});

		button.addEventListener('auxclick', (event) => {
			if (event.button === 1) {
				event.preventDefault();
				void this.closeTab(tab.tabId, pane.paneId);
			}
		});

		button.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.activePaneId = pane.paneId;
			this.activeTabId  = tab.tabId;
			this.showTabContextMenu(tab.tabId, event.clientX, event.clientY);
		});

		button.addEventListener('dragstart', (event) => {
			this.tabDragSourceId     = tab.tabId;
			this.tabDragSourcePaneId = pane.paneId;
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('application/x-tms-mde-tab', tab.tabId);
			}
		});
		button.addEventListener('dragend', (event) => {
			if (event.dataTransfer?.dropEffect === 'none') void this.detachTabToNewWindow(tab.tabId, pane.paneId, event.screenX, event.screenY);
			this.clearTabDropIndicators();
			this.tabDragSourceId     = null;
			this.tabDragSourcePaneId = null;
		});

		button.addEventListener('dragover', (event) => {
			if (!this.tabDragSourceId) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		});

		button.addEventListener('drop', (event) => {
			event.preventDefault();
			this.clearTabDropIndicators();
			if (this.tabDragSourceId && this.tabDragSourcePaneId) {
				this.moveOrReorderTab(this.tabDragSourceId, this.tabDragSourcePaneId, pane.paneId, tab.tabId);
			}
		});

		tabBar.appendChild(button);
	}

	/**
	 * Web / シェルのメニューを閉じる
	 * @returns {void}
	 */
	private dismissAllMenus(): void {
		dismissContextMenus();
		void invokeBridge('ui:dismissMenus');
	}

	/**
	 * タブコンテキストメニューを表示する
	 * @param {string} tabId タブ ID
	 * @param {number} x X 座標
	 * @param {number} y Y 座標
	 * @returns {void}
	 */
	private showTabContextMenu(tabId: string, x: number, y: number): void {
		dismissContextMenus();
		void invokeBridge('ui:dismissMenus');

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

	/**
	 * エディタコンテキストメニューを表示する
	 * @param {MouseEvent} event 右クリックイベント
	 * @returns {void}
	 */
	private showEditorContextMenu(event: MouseEvent): void {
		dismissContextMenus();
		void invokeBridge('ui:dismissMenus');

		const tab            = this.getActiveTab();
		const view           = this.editorView;
		const clickPosition  = view?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
		const checkboxAction = view && clickPosition !== null
			? buildToggleTaskMarkerTransaction(view.state, clickPosition)
			: null;
		const linkUrl        = view ? findMarkdownLinkUrlFromMouseEvent(view, event) : null;
		const hasSelection   = Boolean(view && view.state.selection.ranges.some((range) => !range.empty));
		const entries        = this.buildConfiguredContextMenuEntries(
			this.settings.contextMenu.editorOrder,
			this.settings.contextMenu.editorHidden,
			{
				undo           : { shortcut: 'Ctrl+Z', disabled: !view || undoDepth(view.state) === 0 },
				redo           : { shortcut: 'Ctrl+Y', disabled: !view || redoDepth(view.state) === 0 },
				cut            : { shortcut: 'Ctrl+X', disabled: !view || view.state.readOnly || !hasSelection },
				copy           : { shortcut: 'Ctrl+C', disabled: !hasSelection },
				paste          : { shortcut: 'Ctrl+V', disabled: !view || view.state.readOnly },
				selectAll      : { shortcut: 'Ctrl+A', disabled: !view || view.state.doc.length === 0 },
				find           : { shortcut: this.settings.keybindings.find, disabled: !view },
				replace        : { shortcut: this.settings.keybindings.replace, disabled: !view || view.state.readOnly },
				toggleCheckbox : { shortcut: this.settings.keybindings.toggleCheckbox, hidden: !checkboxAction },
				openLink       : { hidden: !linkUrl || !isSupportedExternalLinkUrl(linkUrl) },
				toggleViewMode : { shortcut: this.settings.keybindings.toggleViewMode, disabled: !tab || tab.largeFile },
				toggleOutline  : { shortcut: this.settings.keybindings.toggleOutline },
				splitHorizontal: { shortcut: this.settings.keybindings.splitHorizontal, disabled: !tab },
				splitVertical  : { shortcut: this.settings.keybindings.splitVertical, disabled: !tab },
				unsplit        : { shortcut: this.settings.keybindings.unsplit, disabled: this.panes.size <= 1 },
			}
		);

		showContextMenuAtPoint(event.clientX, event.clientY, entries, (action) => {
			void this.handleEditorContextAction(action, clickPosition, linkUrl);
		});
	}

	/**
	 * 保存設定の順序・表示状態へ実行時状態を重ね、描画項目を生成する。
	 * @param {string[]} order 項目順
	 * @param {string[]} hiddenItems 非表示項目ID
	 * @param {Record<string, Omit<ContextMenuEntry, 'id' | 'label'>>} overrides 実行時状態
	 * @returns {ContextMenuEntry[]} 描画項目
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
	 * エディタの右クリックコマンドを実行する。
	 * @param {string} action コマンドID
	 * @param {number | null} clickPosition 右クリックした文書位置
	 * @param {string | null} linkUrl 右クリックしたリンクURL
	 * @returns {Promise<void>}
	 */
	private async handleEditorContextAction(action: string, clickPosition: number | null, linkUrl: string | null): Promise<void> {
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
				await invokeBridge('clipboard:writeText', { text });
				if (action === 'cut') {
					view.dispatch({ ...view.state.replaceSelection(''), userEvent: 'delete.cut' });
				}
				view.focus();
				return;
			}

			if (action === 'paste') {
				const text = await invokeBridge<string>('clipboard:readText');
				if (text.length > 0) {
					view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.paste' });
				}
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

			if (action === 'toggleCheckbox' && clickPosition !== null) {
				const spec = buildToggleTaskMarkerTransaction(view.state, Math.min(clickPosition, view.state.doc.length));
				if (spec) {
					view.dispatch(spec);
				}
				view.focus();
				return;
			}

			if (action === 'openLink' && linkUrl && isSupportedExternalLinkUrl(linkUrl)) {
				await invokeBridge('shell:openExternal', { url: linkUrl });
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
	 * @param {string} tabId タブ ID
	 * @param {string} action アクション ID
	 * @returns {Promise<void>}
	 */
	private async handleTabContextAction(tabId: string, action: string): Promise<void> {
		const tab  = this.tabs.find((entry) => entry.tabId === tabId);
		const pane = this.panes.get(this.activePaneId);
		if (!tab || !pane) {
			return;
		}

		if (action === 'toggleViewMode') {
			this.activateTab(tabId);
			this.toggleActiveTabViewMode();
			return;
		}

		if (action === 'toggleOutline') {
			this.toggleOutline();
			return;
		}

		if (action === 'splitHorizontal' || action === 'splitVertical') {
			this.activateTab(tabId);
			this.splitActiveView(action === 'splitHorizontal' ? 'horizontal' : 'vertical');
			return;
		}

		if (action === 'unsplit') {
			this.activateTab(tabId);
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
			await invokeBridge('clipboard:writeText', { text: tab.filePath ?? '' });
			return;
		}

		if (action === 'showInFolder' && tab.filePath) {
			await invokeBridge('shell:showInFolder', { filePath: tab.filePath });
		}
	}

	/** タブを同一ペイン内で並べ替えるか、別ペインへ移動する */
	private moveOrReorderTab(sourceTabId: string, sourcePaneId: PaneId, targetPaneId: PaneId, targetTabId?: string): void {
		const sourcePane = this.panes.get(sourcePaneId);
		const targetPane = this.panes.get(targetPaneId);
		if (!sourcePane || !targetPane) return;
		const sourceIndex = sourcePane.tabIds.indexOf(sourceTabId);
		if (sourceIndex < 0) return;

		sourcePane.tabIds.splice(sourceIndex, 1);
		const existingIndex = targetPane.tabIds.indexOf(sourceTabId);
		if (existingIndex >= 0) targetPane.tabIds.splice(existingIndex, 1);
		const targetIndex = targetTabId ? targetPane.tabIds.indexOf(targetTabId) : -1;
		targetPane.tabIds.splice(targetIndex >= 0 ? targetIndex : targetPane.tabIds.length, 0, sourceTabId);
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

	/** タブを指定ペインのコンテンツ領域へ分割配置する */
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
	}

	/** ウィンドウ外へドロップされたタブを新しいプロセスへ引き渡す */
	private async detachTabToNewWindow(tabId: string, paneId: PaneId, screenX: number, screenY: number): Promise<void> {
		const tab = this.tabs.find((entry) => entry.tabId === tabId);
		if (!tab) return;
		this.persistActiveEditorState();
		try {
			const result = await invokeBridge<{ detached: boolean }>('window:detachTab', {
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
			if (result.detached) await this.closeTab(tabId, paneId, true);
		} catch (error) {
			showErrorMessage(`タブを別ウィンドウへ移動できませんでした: ${this.formatError(error)}`);
		}
	}

	/**
	 * アクティブエディタをマウントする
	 * @returns {void}
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
		if (!document.querySelector('.tms-mde-dialog-backdrop')) {
			this.editorViews.get(this.activePaneId)?.focus();
		}
	}

	/** 分割ツリーをDOMへ変換する */
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

	/** エディタペインとペイン固有タブバーを生成する */
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
		});
		tabBar.addEventListener('drop', (event) => {
			event.preventDefault();
			this.clearTabDropIndicators();
			if (this.tabDragSourceId && this.tabDragSourcePaneId) this.moveOrReorderTab(this.tabDragSourceId, this.tabDragSourcePaneId, paneId);
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

	/** ペインへEditorViewをマウントする */
	private mountPaneEditor(paneId: PaneId, host: HTMLElement, tab: TabRuntime, state: EditorState): void {
		const view = mountEditorView(host, state, (transaction, sourceView) => this.dispatchEditorTransaction(transaction, sourceView));
		this.editorViews.set(paneId, view);
		this.applyDocumentContextToEditor(view, tab.filePath);
		view.dom.addEventListener('focusin', () => this.activatePane(paneId));
	}

	/**
	 * ペイン間で本文変更だけを同期する
	 * @param {Transaction} transaction 同期元トランザクション
	 * @param {EditorView} sourceView 同期元ビュー
	 * @returns {void}
	 */
	private dispatchEditorTransaction(transaction: Transaction, sourceView: EditorView): void {
		sourceView.update([transaction]);
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
	 * @param {PaneId} paneId ペイン ID
	 * @returns {void}
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
	}

	/**
	 * 分割境界バーを生成する
	 * @param {SplitDirection} direction 分割方向
	 * @returns {HTMLElement} 境界バー
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
		 * @param {PointerEvent} event ポインターイベント
		 * @returns {void}
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
	 * @param {PaneSplit} split 分割ノード
	 * @param {HTMLElement} container 分割コンテナー
	 * @param {number} clientX X 座標
	 * @param {number} clientY Y 座標
	 * @returns {void}
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
	 * @param {PaneSplit} split 分割ノード
	 * @param {HTMLElement} container 分割コンテナー
	 * @returns {void}
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

	/**
	 * 画像解決用のドキュメント文脈をエディタへ反映する
	 * @param {EditorView} view 対象ビュー
	 * @param {string | null} filePath ファイルパス
	 * @returns {void}
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
	 * @returns {void}
	 */
	private persistActiveEditorState(): void {
		this.editorViews.forEach((view, paneId) => {
			const pane  = this.panes.get(paneId);
			const tabId = pane?.activeTabId;
			if (!pane || !tabId) return;
			pane.editorStates.set(tabId, view.state);
			const tab = this.tabs.find((entry) => entry.tabId === tabId);
			if (tab) tab.editorState = view.state;
		});
	}

	/**
	 * ステータスバーの表示倍率を更新する
	 * @param {number} zoom 倍率
	 * @returns {void}
	 */
	private updateUiZoomStatus(zoom: number): void {
		const isDefault = zoom === 1;

		this.statusElements.zoom.textContent = formatUiZoomPercent(zoom);
		this.statusElements.zoom.classList.toggle('tms-mde-status-static', isDefault);
		this.statusElements.zoom.setAttribute('aria-label', isDefault ? '表示倍率' : '表示倍率（クリックで100%に戻す）');
	}

	/**
	 * エディタ本文の表示倍率を反映する
	 * @returns {void}
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
	 * @returns {void}
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
	 * @returns {Promise<void>}
	 */
	private async updateWindowTitle(): Promise<void> {
		const tab = this.getActiveTab();
		if (!tab) {
			return;
		}

		await invokeBridge('window:setTitle', {
			title: buildWindowTitle(tab.title, tab.dirty, tab.filePath)
		});
	}

	/**
	 * ドキュメント変更を処理する
	 * @param {EditorView} view 変更元ビュー
	 * @returns {void}
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

		tab.lineEols = syncLineEols(tab.lineEols, previousCm6, currentText, tab.eol);
		tab.dirty    = currentText !== tab.savedText;
		this.renderTabBar();
		this.refreshStatusBar();
		if (view === this.editorView) {
			this.renderOutline();
		}
		void this.updateWindowTitle();

		if (this.settings.showEolMarkers) {
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
	 * @param {EditorView} view 対象ビュー
	 * @returns {PaneId | null} ペイン ID
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
	 * @param {EditorView} view 対象ビュー
	 * @returns {void}
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
		if (view === this.editorView) {
			this.refreshStatusBar();
			this.updateOutlineActiveItem();
		}
	}

	/** アウトラインパネルの表示 / 非表示を切り替える。 */
	private toggleOutline(): void {
		this.setOutlineVisible(!this.outlineVisible);
	}

	/** アウトラインパネルの表示状態を切り替える。 */
	private setOutlineVisible(visible: boolean): void {
		this.outlineVisible             = visible;
		this.outlinePanelElement.hidden = !visible;
		if (visible) this.renderOutline();
	}

	/** アクティブペインの見出し一覧を描画する。 */
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
	 * @param {OutlineTreeNode} node ノード
	 * @returns {HTMLElement} ノード要素
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
	 * @param {OutlineTreeNode[]} tree 現在のツリー
	 * @returns {void}
	 */
	private pruneOutlineCollapsedFroms(tree: OutlineTreeNode[]): void {
		const valid = new Set(collectFoldableOutlineFroms(tree));
		for (const from of [...this.outlineCollapsedFroms]) {
			if (!valid.has(from)) this.outlineCollapsedFroms.delete(from);
		}
	}

	/**
	 * 子を持つ見出しの開閉を切り替える
	 * @param {number} from 見出し位置
	 * @returns {void}
	 */
	private toggleOutlineFold(from: number): void {
		if (this.outlineCollapsedFroms.has(from)) this.outlineCollapsedFroms.delete(from);
		else this.outlineCollapsedFroms.add(from);
		this.renderOutline();
	}

	/** アウトラインをすべて展開する。 */
	private expandAllOutline(): void {
		this.outlineCollapsedFroms.clear();
		this.renderOutline();
	}

	/** 子を持つ見出しをすべて折りたたむ。子自身の開閉状態は維持する。 */
	private collapseAllOutline(): void {
		this.outlineItems          = this.editorView ? collectOutlineItems(this.editorView.state) : [];
		this.outlineCollapsedFroms = new Set(
			collectFoldableOutlineFroms(buildOutlineTree(this.outlineItems)),
		);
		this.renderOutline();
	}

	/** キャレット位置に対応する見出しを強調する。 */
	private updateOutlineActiveItem(): void {
		if (!this.outlineVisible || !this.editorView) return;

		const activeIndex = findActiveOutlineItemIndex(this.outlineItems, this.editorView.state.selection.main.head);
		this.outlineListElement.querySelectorAll<HTMLElement>('.tms-mde-outline-item').forEach((element) => {
			element.classList.toggle('is-active', Number(element.dataset.outlineIndex) === activeIndex);
		});
	}

	/** 選択した見出しへキャレットを移動する。スクロールは補正プラグインが行う。 */
	private jumpToOutlineItem(item: OutlineItem): void {
		if (!this.editorView) return;

		jumpToOutlineItem(this.editorView, item);
	}

	/**
	 * 追加ペイン用の EditorState を生成する
	 * @param {TabRuntime} tab 対象タブ
	 * @param {string} text 初期本文
	 * @param {ViewMode} viewMode 初期表示モード
	 * @returns {EditorState} エディタ状態
	 */
	private createPaneEditorState(tab: TabRuntime, text: string, viewMode: ViewMode): EditorState {
		return createEditorState({
			text,
			settings: this.settings,
			viewMode,
			filePath: tab.filePath,
			lineEols: tab.lineEols,
			customDecorations: this.customDecorationRules,
			/** 本文変更を処理する */
			onDocChange: (view) => this.handleDocumentChange(view),
			/** 選択変更を処理する */
			onSelectionChange: (view) => this.handleSelectionChange(view)
		});
	}

	/**
	 * 既存 EditorState を新しい設定で再構成する。
	 * @param {TabRuntime} tab 対象タブ
	 * @param {EditorState} state 現在の状態
	 * @param {ViewMode} viewMode ペインの表示モード
	 * @returns {EditorState} 再構成後の状態
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
			onSelectionChange: (view) => this.handleSelectionChange(view)
		});
	}

	/**
	 * タブランタイムを生成する
	 * @param {object} options 生成オプション
	 * @returns {TabRuntime} タブ
	 */
	private createTabRuntime(options: { filePath: string | null; text: string; encoding: EncodingKind; eol: EolKind; eolMixed: boolean; largeFile: boolean; viewMode: ViewMode; lineEols: Array<EolKind | null> }): TabRuntime {
		const tabId       = crypto.randomUUID();
		const editorState = createEditorState({
			text: options.text,
			settings: this.settings,
			viewMode: options.viewMode,
			filePath: options.filePath,
			lineEols: options.lineEols,
			customDecorations: this.customDecorationRules,
			/**
			 * ドキュメント変更時
			 * @returns {void}
			 */
			onDocChange: (view) => {
				this.handleDocumentChange(view);
			},
			/**
			 * 選択変更時
			 * @returns {void}
			 */
			onSelectionChange: (view) => {
				this.handleSelectionChange(view);
			}
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
	 * @returns {TabRuntime | null} タブ
	 */
	private getActiveTab(): TabRuntime | null {
		if (!this.activeTabId) {
			return null;
		}

		return this.tabs.find((tab) => tab.tabId === this.activeTabId) ?? null;
	}

	/** タブをペインへ登録し、ペイン固有の表示状態を初期化する */
	private addTabToPane(tab: TabRuntime, paneId: PaneId): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		if (!pane.tabIds.includes(tab.tabId)) pane.tabIds.push(tab.tabId);
		if (!pane.editorStates.has(tab.tabId)) pane.editorStates.set(tab.tabId, this.createPaneEditorState(tab, tab.editorState.doc.toString(), tab.viewMode));
		if (!pane.viewModes.has(tab.tabId)) pane.viewModes.set(tab.tabId, tab.viewMode);
	}

	/** 同じ文書を表示する全ペインへ本文置換を反映する */
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

	/** 指定タブを含む先頭のペインを返す */
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
	 * @param {string} value 設定値
	 * @returns {EncodingKind} 文字コード
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
	 * @param {string} value 設定値
	 * @returns {EolKind} 改行コード
	 */
	private parseDefaultEol(value: string): EolKind {
		return value === 'lf' ? 'lf' : 'crlf';
	}

	/**
	 * エラーを整形する
	 * @param {unknown} error エラー
	 * @returns {string} メッセージ
	 */
	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * エクスポート既定ファイル名を作る
 * @param {TabRuntime} tab タブ
 * @param {'html' | 'pdf'} ext 拡張子
 * @returns {string}
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
 * @param {string} theme 設定値
 * @returns {'light' | 'dark'}
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
