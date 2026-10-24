/**
 * WebView2 経由で C# と JSON の要求・イベントをやり取りする
 * 画面状態は持たず、未完了の要求とイベント購読だけをモジュールに残す
 * @file
 */
type BridgeResponse<T> = {
	/** 要求と応答を結びつける ID。イベント通知では未設定 */
	id?: string;
	/** 成功時の戻り値。失敗時は未設定 */
	result?: T;
	/** 失敗時の説明。成功時は未設定 */
	error?: {
		/** C# が返した失敗の説明 */
		message: string;
	};
};

/**
 * C# から届くイベント通知
 * 要求への応答とは `event` の有無で区別する
 */
type BridgeEvent = {
	/** イベント名。`BRIDGE_EVENT` のいずれか */
	event: string;
	/** イベント固有の本文。無いイベントは未設定 */
	payload?: unknown;
};

/**
 * 応答待ちの 1 要求
 * ID をキーに保持し、応答が来たらマップから外す
 */
type PendingRequest = {
	/**
	 * 成功応答を返す
	 * @param value - C# が返した result
	 */
	resolve: (value: unknown) => void;
	/**
	 * 失敗応答を返す
	 * @param reason - C# のエラー、または中断理由
	 */
	reject: (reason?: unknown) => void;
};

/**
 * C# イベントの購読関数
 * 同じイベントに複数登録でき、届いた順に呼ぶ
 */
type BridgeEventHandler = (payload: unknown) => void;

/**
 * Web 層から呼び出せるブリッジメソッド名
 * C# 側の BridgeMethod と同じ値で、実行中には変えない
 */
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
	fileResolveLocalImage : 'file:resolveLocalImage',
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
	uiUpdateTableMenuState: 'ui:updateTableMenuState',
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

/**
 * C# 層から Web 層へ通知されるブリッジイベント名
 * C# 側の BridgeEventName と同じ値で、実行中には変えない
 */
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
	menuTableAction       : 'menu:tableAction',
	menuReloadWithEncoding: 'menu:reloadWithEncoding',
	menuFind              : 'menu:find',
	menuReplace           : 'menu:replace',
	menuFindNext          : 'menu:findNext',
	menuFindPrevious      : 'menu:findPrevious',
	menuToggleViewMode    : 'menu:toggleViewMode',
	menuToggleOutline     : 'menu:toggleOutline',
	menuCollapseAllHeadings: 'menu:collapseAllHeadings',
	menuExpandAllHeadings : 'menu:expandAllHeadings',
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

/** `BRIDGE_METHOD` の値。要求のメソッド名に使う */
export type BridgeMethodName = typeof BRIDGE_METHOD[keyof typeof BRIDGE_METHOD];

/** `BRIDGE_EVENT` の値。購読するイベント名に使う */
export type BridgeEventName = typeof BRIDGE_EVENT[keyof typeof BRIDGE_EVENT];

/** 要求 ID から、まだ応答が来ていない Promise の完了関数。応答後は削除する */
const pendingRequests     = new Map<string, PendingRequest>();

/** イベント名から購読関数。登録順に呼ぶ */
const bridgeEventHandlers = new Map<string, BridgeEventHandler[]>();

/**
 * WebView2 からのメッセージを受信する
 * ブリッジが無い環境では何もしない。文字列の JSON が壊れているときは `SyntaxError` がリスナーから出る
 * @throws {SyntaxError} 文字列メッセージが JSON でない
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
 * C# 層のイベントを購読する
 * 解除機能は無く、同じハンドラを重ねて登録できる
 * @param eventName - 購読するイベント名
 * @param handler - ペイロードを受け取る関数。ペイロードの形はイベントごとに異なる
 */
export function onBridgeEvent(eventName: BridgeEventName, handler: BridgeEventHandler): void {
	const handlers = bridgeEventHandlers.get(eventName) ?? [];
	handlers.push(handler);
	bridgeEventHandlers.set(eventName, handlers);
}

/**
 * C# から届いたイベントを購読側へ渡す
 * `app:ready` のときは文書イベント `tms-mde-app-ready` も出す
 * @param eventData - 受信したイベント名とペイロード
 */
function handleBridgeEvent(eventData: BridgeEvent): void {
	if (eventData.event === BRIDGE_EVENT.appReady) {
		document.dispatchEvent(new CustomEvent('tms-mde-app-ready', { detail: eventData.payload }));
	}

	const handlers = bridgeEventHandlers.get(eventData.event) ?? [];
	handlers.forEach((handler) => handler(eventData.payload));
}

/**
 * C# 層へ JSON-RPC 風の要求を送る
 * ブリッジが無いときは同期的に失敗する。C# がエラーを返したときは Promise を reject する。応答が来ない要求は待ち続ける
 * @param method - 呼び出すメソッド名
 * @param params - メソッド引数。省略するとメッセージに `params` を含めない
 * @returns C# の `result` で解決する Promise
 * @throws {Error} WebView2 ブリッジが無い
 * @throws {Error} C# がエラー応答を返したとき、そのメッセージで reject する
 */
export async function invokeBridge<T>(method: BridgeMethodName, params?: Record<string, unknown>): Promise<T> {
	if (!window.chrome?.webview) {
		throw new Error('WebView2 bridge is not available.');
	}

	const id = crypto.randomUUID();

	return new Promise<T>((resolve, reject) => {
		pendingRequests.set(id, {
			/**
			 * 応答の result を、呼び出し元が期待する型として完了させる
			 * 実行時の形は検証しない
			 * @param value - C# が返した result。エラー時はこの関数を呼ばない
			 */
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
 * Web 層のログを C# 層へ転送する
 * ブリッジが無いときは同期的に失敗し、C# がエラーを返したときは Promise を reject する
 * @param level - ログレベル。`DEBUG` から `ERROR` までの 4 段階
 * @param message - ログ本文。整形は呼び出し側が行う
 * @returns C# がログを受け付けたときに解決する Promise
 * @throws {Error} WebView2 ブリッジが無い
 * @throws {Error} C# がエラー応答を返したとき、そのメッセージで reject する
 */
export async function writeLog(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
	await invokeBridge(BRIDGE_METHOD.logWrite, {
		level,
		source : 'web',
		message,
	});
}

/**
 * ドロップされた File 一覧を C# へ渡し、パスを解決させる
 * WebView2 では JS の File.path が使えないため AdditionalObjects を使う。空の一覧は送らない
 * @param files - ドロップされたファイル。0 件なら何もしない
 * @throws {Error} `postMessageWithAdditionalObjects` が無い
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
	/**
	 * WebView2 が window に足すホストオブジェクト
	 * ブラウザ単体では未設定
	 */
	interface Window {
		/**
		 * WebView2 のホスト
		 * ブリッジが無い環境では未設定
		 */
		chrome?: {
			/**
			 * WebView2 のメッセージング
			 * ホストオブジェクトが無いときは未設定
			 */
			webview?: {
				/**
				 * C# へ JSON メッセージを送る
				 * @param message - 要求オブジェクト
				 */
				postMessage: (message: unknown) => void;
				/**
				 * C# へメッセージと File オブジェクトを一緒に送る
				 * 古いホストでは未設定
				 * @param message - 要求オブジェクト
				 * @param additionalObjects - 一緒に渡すファイル
				 */
				postMessageWithAdditionalObjects?: (message: unknown, additionalObjects: File[]) => void;
				/**
				 * C# からのメッセージを受ける
				 * @param type - 購読する種類。このホストでは `message` だけ
				 * @param listener - 受信したメッセージイベント
				 */
				addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
			};
		};
	}
}

export {};
