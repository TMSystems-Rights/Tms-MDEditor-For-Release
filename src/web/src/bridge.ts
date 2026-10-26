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

// prettier-ignore
/**
 * Web 層から呼び出せるブリッジメソッド名
 * C# 側の BridgeMethod と同じ値で、実行中には変えない
 */
// prettier-ignore
export const BRIDGE_METHOD = {
	// 疎通確認の要求名。応答に時刻とメッセージが載る
	ping                  : 'ping',
	// Web 層のログをネイティブのログへ渡す要求名
	logWrite              : 'log:write',
	// 設定、データ保存先、動作環境を読む要求名
	configGet             : 'config:get',
	// 指定した設定項目かカスタム装飾を更新する要求名
	configUpdate          : 'config:update',
	// 指定した設定項目だけを既定値へ戻す要求名
	configResetItem       : 'config:resetItem',
	// データ保存先を除き、設定全体を既定値へ戻す要求名
	configResetAll        : 'config:resetAll',
	// 現在と既定のデータ保存先を読む要求名
	configGetDataDir      : 'config:getDataDir',
	// データ保存先を変え、既存データを移す要求名
	configChangeDataDir   : 'config:changeDataDir',
	// CSS スニペットの場所と有効状態を読む要求名
	cssSnippetsList       : 'cssSnippets:list',
	// スニペットの保存フォルダをエクスプローラーで開く要求名
	cssSnippetsOpenFolder : 'cssSnippets:openFolder',
	// パスを指定し、文字コードは自動判定でテキストを開く要求名
	fileOpen              : 'file:open',
	// パスと文字コードを指定してテキストを開く要求名
	fileOpenWithEncoding  : 'file:openWithEncoding',
	// ファイル選択ダイアログを出して、選ばれたテキストを開く要求名
	fileOpenDialog        : 'file:openDialog',
	// パス、文字コード、改行を指定してテキストを保存する要求名
	fileSave              : 'file:save',
	// 名前を付けて保存ダイアログを出し、選ばれた保存先を返す要求名。本文は書かない
	fileSaveAsDialog      : 'file:saveAsDialog',
	// HTML か PDF の書き出し先を選ぶダイアログの要求名
	fileExportDialog      : 'file:exportDialog',
	// 生成済みテキストを UTF-8 でファイルへ書く要求名
	fileWriteUtf8         : 'file:writeUtf8',
	// ローカルか埋め込み画像を Data URL で読む要求名
	fileReadImageAsDataUrl: 'file:readImageAsDataUrl',
	// ローカルか埋め込み画像の絶対パスを解決する要求名。バイトは返さない
	fileResolveLocalImage : 'file:resolveLocalImage',
	// ドロップされた File を追加オブジェクトとして受け取る要求名
	fileDrop              : 'file:drop',
	// 生成済み HTML を指定の PDF へ印刷する要求名
	exportPrintToPdf      : 'export:printToPdf',
	// 生成済み HTML に対して Windows の印刷画面を出す要求名
	exportShowPrintUi     : 'export:showPrintUI',
	// 最近使ったファイル一覧を読む要求名
	recentList            : 'recent:list',
	// 指定ファイルを最近使った一覧へ足す要求名
	recentAdd             : 'recent:add',
	// 指定ファイルを最近使った一覧から外す要求名
	recentRemove          : 'recent:remove',
	// ネイティブウィンドウのタイトルを現在のタブに合わせる要求名
	windowSetTitle        : 'window:setTitle',
	// 指定タブを別のネイティブウィンドウへ分離する要求名
	windowDetachTab       : 'window:detachTab',
	// 指定ファイルをエクスプローラーで選択表示する要求名
	shellShowInFolder     : 'shell:showInFolder',
	// URL を設定済みの外部ブラウザで開く要求名
	shellOpenExternal     : 'shell:openExternal',
	// フォルダ選択ダイアログを出し、選ばれたパスを返す要求名
	shellPickFolder       : 'shell:pickFolder',
	// 未保存の確認結果を返し、ネイティブウィンドウを閉じてよいか知らせる要求名
	appReportCloseReady   : 'app:reportCloseReady',
	// 開いているタブとペインを、次回起動の復元用に保存する要求名
	sessionSave           : 'session:save',
	// ノートごとのカーソル位置とスクロール位置を保存する要求名
	noteViewPositionsSave : 'noteViewPositions:save',
	// ネイティブ側で開いているメニューを閉じる要求名
	uiDismissMenus        : 'ui:dismissMenus',
	// Web 側の表選択を、ネイティブのテーブルメニューの活性へ反映する要求名
	uiUpdateTableMenuState: 'ui:updateTableMenuState',
	// クリップボードからプレーンテキストを読む要求名
	clipboardReadText     : 'clipboard:readText',
	// 指定テキストをクリップボードへ書く要求名
	clipboardWriteText    : 'clipboard:writeText',
	// クリップボードの中身を判定し、エディタへ入れる Markdown にする要求名
	clipboardPasteForEditor: 'clipboard:pasteForEditor',
	// 新しいリリースがあるか確認する要求名
	updateCheck           : 'update:check',
	// 確認済みリリースのインストーラを検証しながら落とす要求名
	updateDownload        : 'update:download',
	// 進行中のインストーラのダウンロードを中止する要求名
	updateCancelDownload  : 'update:cancelDownload',
	// 指定した版を、以後の自動通知から外す要求名
	updateSkipVersion     : 'update:skipVersion',
	// 終了後に、取得済みインストーラを起動する要求名
	updateApplyNow        : 'update:applyNow',
	// ポータブル版などが更新を取る公式ページを開く要求名
	updateOpenOfficialPage: 'update:openOfficialPage',
} as const;

// prettier-ignore
/**
 * C# 層から Web 層へ通知されるブリッジイベント名
 * C# 側の BridgeEventName と同じ値で、実行中には変えない
 */
// prettier-ignore
export const BRIDGE_EVENT = {
	// 起動に必要な設定、引数、復元情報を渡す通知名。受信側は文書イベントも出す
	appReady              : 'app:ready',
	// 起動後に追加で受け取ったファイルを開かせる通知名
	appOpenFiles          : 'app:openFiles',
	// ウィンドウを閉じる前に、未保存タブの確認を求める通知名
	appQueryClose         : 'app:queryClose',
	// 監視中のファイルが外部で変更、削除、または改名された通知名
	appExternalFileChanged: 'app:externalFileChanged',
	// 別ウィンドウから移されたタブとドロップ位置の通知名
	appReceiveDetachedTab : 'app:receiveDetachedTab',
	// ネイティブメニューの操作開始時に、Web 側のコンテキストメニューを閉じさせる通知名
	uiDismissContextMenus : 'ui:dismissContextMenus',
	// 新しい無題タブを作らせる通知名
	menuNewFile           : 'menu:newFile',
	// ファイルを開くダイアログを出させる通知名
	menuOpenFile          : 'menu:openFile',
	// 現在のタブを上書き保存させる通知名
	menuSave              : 'menu:save',
	// 現在のタブを名前を付けて保存させる通知名
	menuSaveAs            : 'menu:saveAs',
	// 現在のタブを HTML として書き出させる通知名
	menuExportHtml        : 'menu:exportHtml',
	// 現在のタブを PDF として書き出させる通知名
	menuExportPdf         : 'menu:exportPdf',
	// 現在のタブの印刷画面を出させる通知名
	menuPrint             : 'menu:print',
	// 上部テーブルメニューで選ばれた操作を Web 側へ渡す通知名
	menuTableAction       : 'menu:tableAction',
	// 現在のファイルを、選んだ文字コードで読み直させる通知名
	menuReloadWithEncoding: 'menu:reloadWithEncoding',
	// 検索パネルを開かせる通知名
	menuFind              : 'menu:find',
	// 置換パネルを開かせる通知名
	menuReplace           : 'menu:replace',
	// 今の検索条件の次の一致へ移らせる通知名
	menuFindNext          : 'menu:findNext',
	// 今の検索条件の前の一致へ移らせる通知名
	menuFindPrevious      : 'menu:findPrevious',
	// ソース表示とライブプレビューを切り替えさせる通知名
	menuToggleViewMode    : 'menu:toggleViewMode',
	// アウトラインの表示を切り替えさせる通知名
	menuToggleOutline     : 'menu:toggleOutline',
	// 見出しをすべて折りたたみさせる通知名
	menuCollapseAllHeadings: 'menu:collapseAllHeadings',
	// 見出しをすべて展開させる通知名
	menuExpandAllHeadings : 'menu:expandAllHeadings',
	// 現在のペインを上下に分割させる通知名
	menuSplitHorizontal   : 'menu:splitHorizontal',
	// 現在のペインを左右に分割させる通知名
	menuSplitVertical     : 'menu:splitVertical',
	// 現在の分割ペインを一つに戻させる通知名
	menuUnsplit           : 'menu:unsplit',
	// 設定画面を開かせる通知名
	menuOpenSettings      : 'menu:openSettings',
	// CSS スニペットをディスクから読み直させる通知名
	menuReloadCssSnippets : 'menu:reloadCssSnippets',
	// CSS スニペットの保存フォルダを開かせる通知名
	menuOpenSnippetsFolder: 'menu:openSnippetsFolder',
	// 更新を手動で確認させる通知名
	menuCheckForUpdates   : 'menu:checkForUpdates',
	// 起動時の確認で新しいリリースが見つかった通知名
	updateAvailable       : 'update:available',
	// 更新インストーラのダウンロード済み割合の通知名
	updateDownloadProgress: 'update:downloadProgress',
	// 更新インストーラのダウンロードと検証が終わった通知名
	updateDownloadCompleted: 'update:downloadCompleted',
	// バックグラウンドの更新処理で起きたエラーの通知名
	updateError           : 'update:error',
} as const;

// prettier-ignore
/** `BRIDGE_METHOD` の値。要求のメソッド名に使う */
export type BridgeMethodName = typeof BRIDGE_METHOD[keyof typeof BRIDGE_METHOD];

// prettier-ignore
/** `BRIDGE_EVENT` の値。購読するイベント名に使う */
export type BridgeEventName = typeof BRIDGE_EVENT[keyof typeof BRIDGE_EVENT];

// prettier-ignore
/** 要求 ID から、まだ応答が来ていない Promise の完了関数。応答後は削除する */
// prettier-ignore
const pendingRequests     = new Map<string, PendingRequest>();

/** イベント名から購読関数。登録順に呼ぶ */
const bridgeEventHandlers = new Map<string, BridgeEventHandler[]>();

/**
 * WebView2 からのメッセージを受信する
 * ブリッジが無い環境では何もしない。文字列の JSON が壊れているときは `SyntaxError` がリスナーから出る
 * @throws {SyntaxError} 文字列メッセージが JSON でない
 */
// prettier-ignore
function initializeBridgeListener(): void {
	// window が無い、または WebView2 が無いときは受信を登録しない。どちらか一方だけでも中断する
	if (typeof window === 'undefined' || !window.chrome?.webview) {
		return;
	}

	// C# からのメッセージを、イベント通知と要求の応答に振り分ける。JSON が壊れていれば SyntaxError がそのまま出る
	window.chrome.webview.addEventListener('message', (event: MessageEvent<string | BridgeResponse<unknown> | BridgeEvent>) => {
		// 受信した JSON。文字列のときはパースし、オブジェクトならそのまま使う。壊れた文字列はここで例外になる
		const data = typeof event.data === 'string' ? JSON.parse(event.data) as BridgeResponse<unknown> | BridgeEvent : event.data;

		// event を持つ通知は要求の応答ではないので購読側へ渡す。応答の処理には入らない
		if ('event' in data) {
			handleBridgeEvent(data);
			return;
		}

		// 応答 ID が無いメッセージは待っている要求と結び付かないので捨てる。イベントは上で戻っている
		if (!data.id) {
			return;
		}

		// この ID で待っている完了関数。未知の ID や応答済みは undefined で、二重には解決しない
		const pending = pendingRequests.get(data.id);
		// 待ちが無い ID は何もしない。応答済みの再送を二重に解決しない
		if (!pending) {
			return;
		}

		pendingRequests.delete(data.id);

		// C# が error を返したときは result を使わず Promise を失敗させる
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
	// このイベントの購読一覧。未登録のときは空配列から始め、今回の関数を加える
	const handlers = bridgeEventHandlers.get(eventName) ?? [];
	handlers.push(handler);
	bridgeEventHandlers.set(eventName, handlers);
}

/**
 * C# から届いたイベントを購読側へ渡す
 * `app:ready` のときは文書イベント `tms-mde-app-ready` も出す
 * @param eventData - 受信したイベント名とペイロード
 */
// prettier-ignore
function handleBridgeEvent(eventData: BridgeEvent): void {
	// 起動完了のときだけ文書へ tms-mde-app-ready を出す。他のイベントは購読関数だけを呼ぶ
	if (eventData.event === BRIDGE_EVENT.appReady) {
		document.dispatchEvent(new CustomEvent('tms-mde-app-ready',
			// 文書イベントに載せる起動情報。ブリッジ購読へ渡す payload と同じ
			{
				// C# の payload。未設定のときは undefined
				detail: eventData.payload
			}
		));
	}

	// このイベント名の購読関数。未登録のときは空配列で、誰も呼ばない
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
// prettier-ignore
export async function invokeBridge<T>(method: BridgeMethodName, params?: Record<string, unknown>): Promise<T> {
	// WebView2 が無いときは要求を送らずに失敗させる。ブラウザ単体では C# を呼べない
	if (!window.chrome?.webview) {
		throw new Error('WebView2 bridge is not available.');
	}

	// この要求と応答を結ぶ ID。応答が来ないまま残ると待ち続ける
	const id = crypto.randomUUID();

	return new Promise<T>((resolve, reject) => {
		// postMessage より先に登録する。応答が先に届いても待ちを取り逃さない
		pendingRequests.set(id, {
			// 成功時の result を、呼び出し元の型として Promise を解決する。形の検証はしない
			/**
			 * 応答の result を、呼び出し元が期待する型として完了させる
			 * 実行時の形は検証しない
			 * @param value - C# が返した result。エラー時はこの関数を呼ばない
			 */
			resolve: (value) => resolve(value as T),
			// 失敗応答で Promise を拒否する。Error の組み立ては応答受信側
			reject,
		});

		// C# へ送る要求。params が undefined のときはキーを載せない。null や空オブジェクトは省略しない
		const message = params === undefined
			? {
				// 応答を結びつける ID
				id,
				// 呼び出すメソッド名
				method
			}
			: {
				// 応答を結びつける ID。params の有無では変えない
				id,
				// 呼び出すメソッド名
				method,
				// メソッド引数。この分岐では undefined ではない
				params
			};
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
// prettier-ignore
export async function writeLog(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
	await invokeBridge(BRIDGE_METHOD.logWrite, {
		// ログレベル。DEBUG、INFO、WARN、ERROR のいずれか
		level,
		// 出力元。Web 層からの転送は web 固定
		source : 'web',
		// 呼び出し側が整形した本文。この関数では変えない
		message,
	});
}

/**
 * ドロップされた File 一覧を C# へ渡し、パスを解決させる
 * WebView2 では JS の File.path が使えないため AdditionalObjects を使う。空の一覧は送らない
 * @param files - ドロップされたファイル。0 件なら何もしない
 * @throws {Error} `postMessageWithAdditionalObjects` が無い
 */
// prettier-ignore
export function postDroppedFiles(files: FileList | File[]): void {
	// File を一緒に送る API が無いホストでは送らずに失敗させる。通常の postMessage ではパスが取れない
	if (!window.chrome?.webview?.postMessageWithAdditionalObjects) {
		throw new Error('WebView2 postMessageWithAdditionalObjects is not available.');
	}

	// ドロップされた File の配列。0 件なら C# へは送らない
	const fileArray = Array.from(files);
	// ファイルが 0 件のときは空の通知を送らない。パス解決する対象が無い
	if (fileArray.length === 0) {
		return;
	}

	window.chrome.webview.postMessageWithAdditionalObjects(
		// ドロップ解決の通知。要求 ID は無く、応答は待たない
		{
			// C# の file:drop。パスは第二引数の File から取る
			method: BRIDGE_METHOD.fileDrop
		},
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
