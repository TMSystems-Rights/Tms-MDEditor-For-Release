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
export function onBridgeEvent(eventName: string, handler: BridgeEventHandler): void {
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
	if (eventData.event === 'app:ready') {
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
export async function invokeBridge<T>(method: string, params?: Record<string, unknown>): Promise<T> {
	if (!window.chrome?.webview) {
		throw new Error('WebView2 bridge is not available.');
	}

	const id = crypto.randomUUID();

	return new Promise<T>((resolve, reject) => {
		pendingRequests.set(id, {
			/**
			 *
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
 * Web 層ログを C# 層へ転送する
 * @param {'DEBUG' | 'INFO' | 'WARN' | 'ERROR'} level ログレベル
 * @param {string} message メッセージ
 * @returns {Promise<void>}
 */
export async function writeLog(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
	await invokeBridge('log:write', {
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
		{ method: 'file:drop' },
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
