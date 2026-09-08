export type EncodingKind = 'utf8' | 'utf8Bom' | 'utf16Le' | 'utf16Be' | 'cp932';

export type EolKind = 'crlf' | 'lf' | 'cr';

export type ViewMode = 'source' | 'live-preview';

export type OutlineSide = 'left' | 'right';

/**
 * キーバインド設定（config.json settings.keybindings）
 */
export type KeybindingsSettings = {
	newFile: string;
	openFile: string;
	save: string;
	saveAs: string;
	closeTab: string;
	nextTab: string;
	prevTab: string;
	find: string;
	replace: string;
	findNext: string;
	findPrev: string;
	toggleViewMode: string;
	toggleOutline: string;
	splitHorizontal: string;
	splitVertical: string;
	unsplit: string;
	toggleCheckbox: string;
	exportHtml: string;
	exportPdf: string;
	print: string;
};

/**
 * アプリ画面のアウトライン配置（config.json settings.outline）
 */
export type OutlineSettings = {
	side: OutlineSide;
};

/**
 * HTML 出力のアウトライン（config.json settings.export.outline）
 * side は互換のため残す。位置は出力 HTML 内の切り替えで決まる。
 */
export type ExportOutlineSettings = {
	enabled: boolean;
	side: OutlineSide;
};

/**
 * エクスポート設定（config.json settings.export）
 * style は互換のため残す。印刷向けクリーン文書は未提供で、値は出力に使わない。
 */
export type ExportSettings = {
	style: 'live-preview' | 'clean';
	outline: ExportOutlineSettings;
};

/**
 * 検索・置換設定（config.json settings.search）
 */
export type SearchSettings = {
	restoreCalloutFoldStateOnMove: boolean;
};

export type ImageBorderSettings = {
	width: number;
	color: string;
	hoverWidth: number;
	hoverColor: string;
};

export type UpdateSettings = {
	checkOnStartup: boolean;
	skippedVersion: string;
	lastCheckedAt: string;
};

export type UpdateReleaseInfo = {
	version: string;
	tagName: string;
	releaseUrl: string;
	installerName: string;
	installerAssetId: number;
	installerSize: number;
	sha256?: string;
};

export type UpdateCheckResponse = {
	status: 'available' | 'not-available' | 'error';
	currentVersion: string;
	release?: UpdateReleaseInfo;
	message?: string;
	mode?: 'installer' | 'portable';
};

export type UpdateDownloadProgress = {
	downloadedBytes: number;
	totalBytes: number;
	percent: number;
};

export type CssSnippetsSettings = {
	enabled: string[];
};

export type ExternalBrowserSettings = {
	mode: 'default' | 'custom';
	customCommand: string;
};

export type ContextMenuSettings = {
	editorOrder: string[];
	editorHidden: string[];
	tabOrder: string[];
	tabHidden: string[];
};

export type AppSettings = {
	theme: 'system' | 'dark' | 'light';
	editorFontFamily: string;
	codeFontFamily: string;
	editorFontSize: number;
	showLineNumbers: boolean;
	showEolMarkers: boolean;
	wordWrap: boolean;
	defaultViewMode: ViewMode;
	tabSize: number;
	largeFileThresholdMb: number;
	loadRemoteImages: boolean;
	attachmentFolder: string;
	imageBorder: ImageBorderSettings;
	newFileEncoding: string;
	newFileEol: string;
	externalChangeBehavior: 'auto-reload' | 'confirm';
	instanceMode: 'single-instance' | 'new-window';
	restoreSessionOnStartup: boolean;
	closeAppWhenLastTabClosed: boolean;
	outline: OutlineSettings;
	export: ExportSettings;
	externalBrowser: ExternalBrowserSettings;
	update: UpdateSettings;
	cssSnippets: CssSnippetsSettings;
	keybindings: KeybindingsSettings;
	search: SearchSettings;
	contextMenu: ContextMenuSettings;
};

export type DataDirInfo = {
	dataDir: string;
	defaultDataDir: string;
	isPortable?: boolean;
};

export type ConfigDocument = {
	settings: AppSettings;
	customDecorations: CustomDecorationRule[];
};

export type ConfigGetResponse = {
	config: ConfigDocument;
	dataDirInfo: DataDirInfo;
	isPortable?: boolean;
	defaultAttachmentFolder?: string;
};

export type PasteForEditorResult = {
	ok: boolean;
	kind?: 'image' | 'text' | 'empty';
	text?: string;
	error?: string;
};

export type PickFolderResult = {
	canceled: boolean;
	path?: string;
};

export type SaveConfigResponse = {
	success: boolean;
	config?: ConfigDocument;
	message?: string;
};

export type MigrateDataDirResponse = {
	success: boolean;
	dataDir?: string;
	message?: string;
};

export type CssSnippetInfo = {
	name: string;
	enabled: boolean;
	cssText: string;
	error?: string;
};

export type CssSnippetsResponse = {
	directoryPath: string;
	error?: string;
	snippets: CssSnippetInfo[];
};

/**
 * カスタム装飾ルール（config.json の customDecorations）
 */
export type CustomDecorationRule = {
	name: string;
	enabled?: boolean;
	pattern: string;
	hideDelimiters?: boolean;
	cssClass: string;
};

export type TextFileInfo = {
	filePath: string;
	text: string;
	encoding: EncodingKind;
	primaryEol: EolKind;
	eolMixed: boolean;
	fileSizeBytes: number;
};

export type TabModel = {
	tabId: string;
	title: string;
	filePath: string | null;
	encoding: EncodingKind;
	eol: EolKind;
	eolMixed: boolean;
	dirty: boolean;
	savedText: string;
	viewMode: ViewMode;
	largeFile: boolean;
	/** 行ごとの元改行（CM6 は LF 正規化するため別管理） */
	lineEols: Array<EolKind | null>;
};

export type AppReadyPayload = {
	version?: string;
	isPortable?: boolean;
	args?: string[];
	files?: string[];
	detachedTab?: DetachedTabPayload | null;
	isSessionOwner?: boolean;
	session?: unknown;
	sessionLoadMessage?: string;
	config?: {
		dataDir?: string;
		defaultDataDir?: string;
		isPortable?: boolean;
		theme?: string;
		loadMessage?: string;
		settings?: AppSettings;
		customDecorations?: CustomDecorationRule[];
	};
};

export type DetachedTabPayload = {
	title: string;
	filePath: string | null;
	text: string;
	savedText: string;
	encoding: EncodingKind;
	eol: EolKind;
	eolMixed: boolean;
	dirty: boolean;
	largeFile: boolean;
	viewMode: ViewMode;
	lineEols: Array<EolKind | null>;
};

export type DetachedTabDropPayload = {
	tab: DetachedTabPayload;
	clientX: number;
	clientY: number;
};

export type EolMixedChoice = 'crlf' | 'lf' | 'keep' | 'cancel';

export type CloseChoice = 'save' | 'discard' | 'cancel';

export type SaveAsOptions = {
	encoding: EncodingKind;
	eol: EolKind;
};
