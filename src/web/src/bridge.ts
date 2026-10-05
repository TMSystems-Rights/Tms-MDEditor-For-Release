type BridgeResponse<T> = {
	id?: string;
	result?: T;
	error?: { message: string };
};

type BridgeEvent = {
	event: string;
	payload?: unknown;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
};

type BridgeEventHandler = (payload: unknown) => void;

/** Web 層から呼び出せるブリッジメソッド名。C# 側の BridgeMethod と同じ値を定義する。 */
export const BRIDGE_METHOD = {
	ping                  : 'ping',
	logWrite              : 'log:write',
	configGet             : 'config:get',
	configUpdate          : 'config:update',
	configResetItem       : 'config:resetItem',
	configResetAll        : 'config:resetAll',
	configGetDataDir      : 'config:getDataDir',
	configChangeDataDir   : 'config:changeDataDir',
	cssSnippetsList       : 'cssSnippets:list',
	cssSnippetsOpenFolder : 'cssSnippets:openFolder',
	fileOpen              : 'file:open',
	fileOpenWithEncoding  : 'file:openWithEncoding',
	fileOpenDialog        : 'file:openDialog',
	fileSave              : 'file:save',
	fileSaveAsDialog      : 'file:saveAsDialog',
	fileExportDialog      : 'file:exportDialog',
	fileWriteUtf8         : 'file:writeUtf8',
	fileReadImageAsDataUrl: 'file:readImageAsDataUrl',
	fileDrop              : 'file:drop',
	exportPrintToPdf      : 'export:printToPdf',
	exportShowPrintUi     : 'export:showPrintUI',
	recentList            : 'recent:list',
	recentAdd             : 'recent:add',
	recentRemove          : 'recent:remove',
	windowSetTitle        : 'window:setTitle',
	windowDetachTab       : 'window:detachTab',
	shellShowInFolder     : 'shell:showInFolder',
	shellOpenExternal     : 'shell:openExternal',
	shellPickFolder       : 'shell:pickFolder',
	appReportCloseReady   : 'app:reportCloseReady',
	sessionSave           : 'session:save',
	noteViewPositionsSave : 'noteViewPositions:save',
	uiDismissMenus        : 'ui:dismissMenus',
	clipboardReadText     : 'clipboard:readText',
	clipboardWriteText    : 'clipboard:writeText',
	clipboardPasteForEditor: 'clipboard:pasteForEditor',
	updateCheck           : 'update:check',
	updateDownload        : 'update:download',
	updateCancelDownload  : 'update:cancelDownload',
	updateSkipVersion     : 'update:skipVersion',
	updateApplyNow        : 'update:applyNow',
	updateOpenOfficialPage: 'update:openOfficialPage',
} as const;

/** C# 層から Web 層へ通知されるブリッジイベント名。C# 側の BridgeEventName と同じ値を定義する。 */
export const BRIDGE_EVENT = {
	appReady              : 'app:ready',
	appOpenFiles          : 'app:openFiles',
	appQueryClose         : 'app:queryClose',
	appExternalFileChanged: 'app:externalFileChanged',
	appReceiveDetachedTab : 'app:receiveDetachedTab',
	uiDismissContextMenus : 'ui:dismissContextMenus',
	menuNewFile           : 'menu:newFile',
	menuOpenFile          : 'menu:openFile',
	menuSave              : 'menu:save',
	menuSaveAs            : 'menu:saveAs',
	menuExportHtml        : 'menu:exportHtml',
	menuExportPdf         : 'menu:exportPdf',
	menuPrint             : 'menu:print',
	menuReloadWithEncoding: 'menu:reloadWithEncoding',
	menuFind              : 'menu:find',
	menuReplace           : 'menu:replace',
	menuFindNext          : 'menu:findNext',
	menuFindPrevious      : 'menu:findPrevious',
	menuToggleViewMode    : 'menu:toggleViewMode',
	menuToggleOutline     : 'menu:toggleOutline',
	menuSplitHorizontal   : 'menu:splitHorizontal',
	menuSplitVertical     : 'menu:splitVertical',
	menuUnsplit           : 'menu:unsplit',
	menuOpenSettings      : 'menu:openSettings',
	menuReloadCssSnippets : 'menu:reloadCssSnippets',
	menuOpenSnippetsFolder: 'menu:openSnippetsFolder',
	menuCheckForUpdates   : 'menu:checkForUpdates',
	updateAvailable       : 'update:available',
	updateDownloadProgress: 'update:downloadProgress',
	updateDownloadCompleted: 'update:downloadCompleted',
	updateError           : 'update:error',
} as const;

export type BridgeMethodName = typeof BRIDGE_METHOD[keyof typeof BRIDGE_METHOD];
export type BridgeEventName = typeof BRIDGE_EVENT[keyof typeof BRIDGE_EVENT];

const pendingRequests     = new Map<string, PendingRequest>();
const bridgeEventHandlers = new Map<string, BridgeEventHandler[]>();

/**
 * WebView2 からのメッセージを受信する
 * @returns {void}
 */
function initializeBridgeListener(): void {
	if (typeof window === 'undefined' || !window.chrome?.webview) {
		return;
	}

	window.chrome.webview.addEventListener('message', (event: MessageEvent<string | BridgeResponse<unknown> | BridgeEvent>) => {
		const data = typeof event.data === 'string' ? JSON.parse(event.data) as BridgeResponse<unknown> | BridgeEvent : event.data;

		if ('event' in data) {
			handleBridgeEvent(data);
			return;
		}

		if (!data.id) {
			return;
		}

		const pending = pendingRequests.get(data.id);
		if (!pending) {
			return;
		}

		pendingRequests.delete(data.id);

		if (data.error) {
			pending.reject(new Error(data.error.message));
			return;
		}

		pending.resolve(data.result);
	});
}

/**
 * C# 層イベントを購読する
 * @param {string} eventName イベント名
 * @param {BridgeEventHandler} handler ハンドラ
 * @returns {void}
 */
export function onBridgeEvent(eventName: BridgeEventName, handler: BridgeEventHandler): void {
	const handlers = bridgeEventHandlers.get(eventName) ?? [];
	handlers.push(handler);
	bridgeEventHandlers.set(eventName, handlers);
}

/**
 * C# 層へイベント通知を処理する
 * @param {BridgeEvent} eventData イベントデータ
 * @returns {void}
 */
function handleBridgeEvent(eventData: BridgeEvent): void {
	if (eventData.event === BRIDGE_EVENT.appReady) {
		document.dispatchEvent(new CustomEvent('tms-mde-app-ready', { detail: eventData.payload }));
	}

	const handlers = bridgeEventHandlers.get(eventData.event) ?? [];
	handlers.forEach((handler) => handler(eventData.payload));
}

/**
 * C# 層へ JSON-RPC 風要求を送信する
 * @template T
 * @param {string} method メソッド名
 * @param {Record<string, unknown>} [params] パラメータ
 * @returns {Promise<T>} 応答
 */
export async function invokeBridge<T>(method: BridgeMethodName, params?: Record<string, unknown>): Promise<T> {
	if (!window.chrome?.webview) {
		throw new Error('WebView2 bridge is not available.');
	}

	const id = crypto.randomUUID();

	return new Promise<T>((resolve, reject) => {
		pendingRequests.set(id, {
			/** 応答ペイロードを呼び出し元が期待する型へ戻して完了させる。 */
			resolve: (value) => resolve(value as T),
			reject,
		});

		const message = params === undefined
			? { id, method }
			: { id, method, params };
		window.chrome!.webview!.postMessage(message);
	});
}

/**
 * Web 層ログを C# 層へ転送する
 * @param {'DEBUG' | 'INFO' | 'WARN' | 'ERROR'} level ログレベル
 * @param {string} message メッセージ
 * @returns {Promise<void>}
 */
export async function writeLog(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
	await invokeBridge(BRIDGE_METHOD.logWrite, {
		level,
		source : 'web',
		message,
	});
}

/**
 * ドロップされた File 一覧を C# へ渡し、パス解決させる
 * （WebView2 では JS の File.path が使えないため AdditionalObjects を使う）
 * @param {FileList | File[]} files ファイル一覧
 * @returns {void}
 */
export function postDroppedFiles(files: FileList | File[]): void {
	if (!window.chrome?.webview?.postMessageWithAdditionalObjects) {
		throw new Error('WebView2 postMessageWithAdditionalObjects is not available.');
	}

	const fileArray = Array.from(files);
	if (fileArray.length === 0) {
		return;
	}

	window.chrome.webview.postMessageWithAdditionalObjects(
		{ method: BRIDGE_METHOD.fileDrop },
		fileArray,
	);
}

initializeBridgeListener();

declare global {
	interface Window {
		chrome?: {
			webview?: {
				postMessage: (message: unknown) => void;
				postMessageWithAdditionalObjects?: (message: unknown, additionalObjects: File[]) => void;
				addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
			};
		};
	}
}

export {};
