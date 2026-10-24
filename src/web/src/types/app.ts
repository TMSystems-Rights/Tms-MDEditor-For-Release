/**
 * Web 層と C# ブリッジが共有する設定とファイルの形
 * 保存と画面更新は持たず、境界の型だけを置く
 * @file
 */

/**
 * 開いたファイルと保存で使う文字コード
 * 設定の自由文字列とは別に、タブが実行時に持つのはこの 5 種
 */
export type EncodingKind = 'utf8' | 'utf8Bom' | 'utf16Le' | 'utf16Be' | 'cp932';

/**
 * 改行の種類
 * 混在する文書では主要な 1 種だけを表し、行ごとの違いは別のマップが持つ
 */
export type EolKind = 'crlf' | 'lf' | 'cr';

/**
 * エディタの表示
 * `source` は Markdown のソース、`live-preview` は装飾した編集面
 */
export type ViewMode = 'source' | 'live-preview';

/**
 * アウトラインを置く側
 * `left` は本文の左、`right` は本文の右
 */
export type OutlineSide = 'left' | 'right';

/**
 * キーバインド設定（config.json settings.keybindings）
 * 値は `Ctrl+S` のような文字列。未設定の穴は埋め済みの設定だけをここに載せる
 */
export type KeybindingsSettings = {
	/** 新規タブ。`+` 区切りのショートカット */
	newFile: string;
	/** ファイルを開く */
	openFile: string;
	/** 上書き保存 */
	save: string;
	/** 名前を付けて保存 */
	saveAs: string;
	/** アクティブタブを閉じる */
	closeTab: string;
	/** 次のタブへ移る */
	nextTab: string;
	/** 前のタブへ移る */
	prevTab: string;
	/** 検索パネルを開く */
	find: string;
	/** 置換パネルを開く */
	replace: string;
	/** 次の検索一致へ移る */
	findNext: string;
	/** 前の検索一致へ移る */
	findPrev: string;
	/** ソースとライブプレビューを切り替える */
	toggleViewMode: string;
	/** アウトラインの表示を切り替える */
	toggleOutline: string;
	/** 上下に分割する */
	splitHorizontal: string;
	/** 左右に分割する */
	splitVertical: string;
	/** 分割を解除する */
	unsplit: string;
	/** チェックボックスを切り替える */
	toggleCheckbox: string;
	/** HTML で書き出す */
	exportHtml: string;
	/** PDF で書き出す */
	exportPdf: string;
	/** 印刷する */
	print: string;
	/** 書式を除いて貼り付ける */
	pastePlain: string;
};

/**
 * アプリ画面のアウトライン配置（config.json settings.outline）
 * 書き出し HTML の目次とは別の設定
 */
export type OutlineSettings = {
	/** 起動時にアウトラインを出しているか */
	visible: boolean;
	/** 本文の左か右か */
	side: OutlineSide;
	/** 幅。単位は CSS ピクセル */
	width: number;
};

/**
 * HTML 出力のアウトライン（config.json settings.export.outline）
 * side は互換のため残す。位置は出力 HTML 内の切り替えで決まる
 */
export type ExportOutlineSettings = {
	/** 書き出しに目次を含めるか */
	enabled: boolean;
	/** 互換のために残す配置。出力位置の決定には使わない */
	side: OutlineSide;
};

/**
 * エクスポート設定（config.json settings.export）
 * style は互換のため残す。印刷向けクリーン文書は未提供で、値は出力に使わない
 */
export type ExportSettings = {
	/** 互換のために残す出力様式。現在の HTML 生成では読まない */
	style: 'live-preview' | 'clean';
	/** 書き出しの目次 */
	outline: ExportOutlineSettings;
};

/**
 * 検索・置換設定（config.json settings.search）
 * パネルの開閉状態は含まない
 */
export type SearchSettings = {
	/** 検索移動で開いたコールアウトを、移動後に元の折りたたみへ戻すか */
	restoreCalloutFoldStateOnMove: boolean;
};

/**
 * 画像の枠線
 * ホバー色が空のときはテーマのアクセント色を使う
 */
export type ImageBorderSettings = {
	/** 通常時の太さ。単位は px。0〜8 */
	width: number;
	/** 通常時の色。`#RGB` または `#RRGGBB` または `#RRGGBBAA` */
	color: string;
	/** ホバー時の太さ。単位は px。0〜16 */
	hoverWidth: number;
	/** ホバー時の色。空文字はアクセント色 */
	hoverColor: string;
};

/**
 * 更新確認の設定
 * ダウンロード中の進捗は含まない
 */
export type UpdateSettings = {
	/** 起動時に更新を確認するか */
	checkOnStartup: boolean;
	/** ユーザーが飛ばした版。未設定は空文字 */
	skippedVersion: string;
	/** 最後に確認した時刻の文字列。未確認は空文字 */
	lastCheckedAt: string;
};

/**
 * 配布元から得た 1 件のリリース
 * インストーラ資産を指し、ポータブル ZIP は含まない
 */
export type UpdateReleaseInfo = {
	/** リリースの版。`v` を除いた番号 */
	version: string;
	/** GitHub のタグ名。`v` を含む */
	tagName: string;
	/** リリースページの URL */
	releaseUrl: string;
	/** インストーラ資産のファイル名 */
	installerName: string;
	/** GitHub 上の資産 ID */
	installerAssetId: number;
	/** インストーラの大きさ。単位はバイト */
	installerSize: number;
	/** インストーラの SHA-256。改ざん検知が無い応答では未設定 */
	sha256?: string;
};

/**
 * 更新確認の応答
 * 新版が無いときと失敗のときは `release` を欠く
 */
export type UpdateCheckResponse = {
	/** 新版があるか、無いか、確認に失敗したか */
	status: 'available' | 'not-available' | 'error';
	/** いま動いている版 */
	currentVersion: string;
	/** 見つかったリリース。無いときと失敗時は未設定 */
	release?: UpdateReleaseInfo;
	/** 失敗や補足の文言。成功で不要なときは未設定 */
	message?: string;
	/** この起動がインストーラ版かポータブル版か。不明なときは未設定 */
	mode?: 'installer' | 'portable';
};

/**
 * 更新ダウンロードの進捗
 * 総量が未知のときは `totalBytes` が 0 になり、`percent` も 0 のことがある
 */
export type UpdateDownloadProgress = {
	/** 受信済みの大きさ。単位はバイト */
	downloadedBytes: number;
	/** 全体の大きさ。単位はバイト。未知は 0 */
	totalBytes: number;
	/** 完了割合。0〜100 */
	percent: number;
};

/**
 * 有効にする CSS スニペット
 * 中身はファイル名で、CSS 本文は持たない
 */
export type CssSnippetsSettings = {
	/** 有効なスニペットのファイル名 */
	enabled: string[];
};

/**
 * 外部リンクを開くブラウザ
 * `custom` のときだけコマンド文字列を使う
 */
export type ExternalBrowserSettings = {
	/** OS の既定ブラウザか、指定コマンドか */
	mode: 'default' | 'custom';
	/** カスタム時の起動コマンド。既定モードでは空でもよい */
	customCommand: string;
};

/**
 * 右クリックメニューの並びと非表示
 * エディタとタブで別の配列を持つ
 */
export type ContextMenuSettings = {
	/** エディタメニューの項目 ID。上から表示する */
	editorOrder: string[];
	/** エディタメニューで隠す項目 ID */
	editorHidden: string[];
	/** タブメニューの項目 ID。上から表示する */
	tabOrder: string[];
	/** タブメニューで隠す項目 ID */
	tabHidden: string[];
};

/**
 * アプリ設定の全体
 * config.json の settings に対応し、装飾ルール本体は含まない
 */
export type AppSettings = {
	/** 明暗。`system` は OS に追従する */
	theme: 'system' | 'dark' | 'light';
	/** 本文フォント。CSS の font-family */
	editorFontFamily: string;
	/** コード用フォント。空に近い値は注入時に既定へ戻す */
	codeFontFamily: string;
	/** 本文フォントサイズ。単位は px */
	editorFontSize: number;
	/** 行番号を出すか */
	showLineNumbers: boolean;
	/** 改行記号を出すか */
	showEolMarkers: boolean;
	/** 行を折り返すか */
	wordWrap: boolean;
	/** 新しいタブの初期表示 */
	defaultViewMode: ViewMode;
	/** タブ幅。単位は半角文字数 */
	tabSize: number;
	/** 大ファイルとみなす下限。単位は MiB */
	largeFileThresholdMb: number;
	/** ライブプレビューで遠隔画像を読み込むか */
	loadRemoteImages: boolean;
	/** 貼り付け画像の保存先フォルダ。空は既定の場所 */
	attachmentFolder: string;
	/** 画像枠線 */
	imageBorder: ImageBorderSettings;
	/** 新規ファイルの文字コード。既知の `EncodingKind` 文字列 */
	newFileEncoding: string;
	/** 新規ファイルの改行。既知の `EolKind` 文字列 */
	newFileEol: string;
	/** ディスク上の変更を自動で読み直すか、確認するか */
	externalChangeBehavior: 'auto-reload' | 'confirm';
	/** ファイルを既存ウィンドウで開くか、新しいウィンドウで開くか */
	instanceMode: 'single-instance' | 'new-window';
	/** 起動時に前回のファイルタブを戻すか */
	restoreSessionOnStartup: boolean;
	/** 最後のタブを閉じたときアプリも終了するか */
	closeAppWhenLastTabClosed: boolean;
	/** 画面のアウトライン */
	outline: OutlineSettings;
	/** 書き出し */
	export: ExportSettings;
	/** 外部リンクのブラウザ */
	externalBrowser: ExternalBrowserSettings;
	/** 更新確認 */
	update: UpdateSettings;
	/** 有効な CSS スニペット名 */
	cssSnippets: CssSnippetsSettings;
	/** キーボードショートカット */
	keybindings: KeybindingsSettings;
	/** 検索移動の振る舞い */
	search: SearchSettings;
	/** 右クリックメニュー */
	contextMenu: ContextMenuSettings;
};

/**
 * 設定とログを置くデータディレクトリ
 * ポータブル起動かどうかは応答側で欠けることがある
 */
export type DataDirInfo = {
	/** 現在使っているディレクトリ */
	dataDir: string;
	/** インストール形態ごとの既定ディレクトリ */
	defaultDataDir: string;
	/** ポータブル起動か。古い応答では未設定 */
	isPortable?: boolean;
};

/**
 * 保存する設定文書
 * 画面設定とカスタム装飾を 1 つにまとめる
 */
export type ConfigDocument = {
	/** 画面と動作の設定 */
	settings: AppSettings;
	/** カスタム装飾ルール。無効なものも含む */
	customDecorations: CustomDecorationRule[];
};

/**
 * 設定取得の応答
 * 文書本体に加え、データディレクトリと添付フォルダの既定を返す
 */
export type ConfigGetResponse = {
	/** 読み込んだ設定文書 */
	config: ConfigDocument;
	/** データディレクトリの場所 */
	dataDirInfo: DataDirInfo;
	/** ポータブル起動か。不明なときは未設定 */
	isPortable?: boolean;
	/** 添付フォルダを空にしたときの既定パス。不明なときは未設定 */
	defaultAttachmentFolder?: string;
};

/**
 * エディタ向け貼り付けの結果
 * 画像、テキスト、表、空のどれかを `kind` で区別する
 */
export type PasteForEditorResult = {
	/** C# 側が貼り付け内容を読めたか */
	ok: boolean;
	/** 読んだ種類。失敗時は未設定 */
	kind?: 'image' | 'text' | 'table' | 'empty';
	/** 挿入する文字列。画像や空では未設定 */
	text?: string;
	/** 失敗の説明。成功時は未設定 */
	error?: string;
};

/**
 * フォルダ選択ダイアログの結果
 * キャンセル時は `path` を欠く
 */
export type PickFolderResult = {
	/** ユーザーがキャンセルしたか */
	canceled: boolean;
	/** 選んだフォルダ。キャンセル時は未設定 */
	path?: string;
};

/**
 * 設定保存の応答
 * 失敗時は `config` を欠き、`message` に理由を入れる
 */
export type SaveConfigResponse = {
	/** 保存できたか */
	success: boolean;
	/** 保存後の文書。失敗時は未設定 */
	config?: ConfigDocument;
	/** 失敗や補足の文言。不要なときは未設定 */
	message?: string;
};

/**
 * データディレクトリ移動の応答
 * 失敗時は移動後のパスを欠く
 */
export type MigrateDataDirResponse = {
	/** 移動できたか */
	success: boolean;
	/** 移動後のディレクトリ。失敗時は未設定 */
	dataDir?: string;
	/** 失敗や補足の文言。不要なときは未設定 */
	message?: string;
};

/**
 * 1 つの CSS スニペットファイル
 * 読み込みに失敗したときは `error` があり、`cssText` は空になりうる
 */
export type CssSnippetInfo = {
	/** ファイル名。有効一覧と突き合わせる */
	name: string;
	/** 設定で有効になっているか */
	enabled: boolean;
	/** ファイルの CSS。読み込み失敗時は空 */
	cssText: string;
	/** 読み込み失敗の説明。成功時は未設定 */
	error?: string;
};

/**
 * CSS スニペット一覧の応答
 * フォルダ自体が読めないときは `error` があり、`snippets` は空になりうる
 */
export type CssSnippetsResponse = {
	/** スニペットフォルダのパス */
	directoryPath: string;
	/** フォルダを読めなかった理由。成功時は未設定 */
	error?: string;
	/** 見つけたファイル。失敗時は空 */
	snippets: CssSnippetInfo[];
};

/**
 * カスタム装飾ルール（config.json の customDecorations）
 * 無効なルールも配列に残し、エディタへは適用時に除く
 */
export type CustomDecorationRule = {
	/** 設定画面に出す名前 */
	name: string;
	/** このルールを適用するか。未設定は有効として正規化する */
	enabled?: boolean;
	/** 装飾する範囲の正規表現 */
	pattern: string;
	/** 一致の両端の区切りを表示から隠すか。未設定は隠さない */
	hideDelimiters?: boolean;
	/** 一致範囲へ付ける CSS クラス */
	cssClass: string;
};

/**
 * ディスクから読んだテキストファイル
 * タブの編集状態は含まず、読み取り結果だけを持つ
 */
export type TextFileInfo = {
	/** 読んだファイルのパス */
	filePath: string;
	/** デコードした全文 */
	text: string;
	/** 判定した文字コード */
	encoding: EncodingKind;
	/** 最も多かった改行 */
	primaryEol: EolKind;
	/** 改行が混在しているか */
	eolMixed: boolean;
	/** ファイルサイズ。単位はバイト */
	fileSizeBytes: number;
};

/**
 * 開いている 1 タブの編集状態
 * エディタの `EditorState` は含めず、保存と比較に必要な値だけを持つ
 */
export type TabModel = {
	/** ウィンドウ内でタブを指す ID */
	tabId: string;
	/** タブに出す名前。未保存は `無題` */
	title: string;
	/** 保存先パス。未保存は null */
	filePath: string | null;
	/** 保存と再読込に使う文字コード */
	encoding: EncodingKind;
	/** 主要な改行。混在時も代表の 1 種 */
	eol: EolKind;
	/** 行ごとの改行が混在しているか */
	eolMixed: boolean;
	/** 未保存の変更があるか */
	dirty: boolean;
	/** 最後に保存した、または開いたときの全文。変更比較の基準 */
	savedText: string;
	/** このタブの表示モード */
	viewMode: ViewMode;
	/** 大ファイルとして重い機能を抑えているか */
	largeFile: boolean;
	/** 行ごとの元改行（CM6 は LF 正規化するため別管理） */
	lineEols: Array<EolKind | null>;
};

/**
 * C# から起動完了で渡される情報
 * 設定の読み込みに失敗しても、説明文だけを載せて起動を続ける
 */
export type AppReadyPayload = {
	/** アプリの版。不明なときは未設定 */
	version?: string;
	/** ポータブル起動か。不明なときは未設定 */
	isPortable?: boolean;
	/** 起動引数。ファイル以外を含むことがある */
	args?: string[];
	/** 起動時に開くファイルパス */
	files?: string[];
	/** 別ウィンドウから切り離したタブ。通常起動は null または未設定 */
	detachedTab?: DetachedTabPayload | null;
	/** このウィンドウがセッションの保存元か。不明なときは未設定 */
	isSessionOwner?: boolean;
	/** 復元するセッション JSON。空や壊れた値は呼び出し側が判定する */
	session?: unknown;
	/** セッションを読めなかった説明。成功時は未設定 */
	sessionLoadMessage?: string;
	/** ノートごとの表示位置 JSON。形式の検証は受け側が行う */
	noteViewPositions?: unknown;
	/** 起動時に読んだ設定。失敗時は説明だけが入る */
	config?: {
		/** 現在のデータディレクトリ。読めないときは未設定 */
		dataDir?: string;
		/** 既定のデータディレクトリ。読めないときは未設定 */
		defaultDataDir?: string;
		/** ポータブル起動か。不明なときは未設定 */
		isPortable?: boolean;
		/** 初期テーマ。設定が無いときは未設定 */
		theme?: string;
		/** 設定を読めなかった説明。成功時は未設定 */
		loadMessage?: string;
		/** 画面設定。読み込み失敗時は未設定 */
		settings?: AppSettings;
		/** カスタム装飾。読み込み失敗時は未設定 */
		customDecorations?: CustomDecorationRule[];
	};
};

/**
 * 別ウィンドウへ渡すタブの中身
 * エディタのビューは含めず、開き直せる状態だけを持つ
 */
export type DetachedTabPayload = {
	/** タブに出す名前 */
	title: string;
	/** 保存先パス。未保存は null */
	filePath: string | null;
	/** 切り離した時点の本文 */
	text: string;
	/** 最後に保存した全文。未保存判定の基準 */
	savedText: string;
	/** 文字コード */
	encoding: EncodingKind;
	/** 主要な改行 */
	eol: EolKind;
	/** 改行が混在しているか */
	eolMixed: boolean;
	/** 未保存の変更があるか */
	dirty: boolean;
	/** 大ファイルとして扱っているか */
	largeFile: boolean;
	/** 表示モード */
	viewMode: ViewMode;
	/** 行ごとの元改行 */
	lineEols: Array<EolKind | null>;
};

/**
 * 切り離したタブをドロップした位置つきの通知
 * 座標は受け側ウィンドウのビューポート
 */
export type DetachedTabDropPayload = {
	/** 渡されたタブ */
	tab: DetachedTabPayload;
	/** ドロップ位置のビューポート X */
	clientX: number;
	/** ドロップ位置のビューポート Y */
	clientY: number;
};

/**
 * 改行混在ダイアログの選択
 * `keep` は混ぜたまま保存し、`cancel` は保存しない
 */
export type EolMixedChoice = 'crlf' | 'lf' | 'keep' | 'cancel';

/**
 * 未保存のタブを閉じるときの選択
 * `discard` は変更を捨て、`cancel` は閉じない
 */
export type CloseChoice = 'save' | 'discard' | 'cancel';

/**
 * 名前を付けて保存するときの文字コードと改行
 * パスはダイアログの外で決める
 */
export type SaveAsOptions = {
	/** 保存に使う文字コード */
	encoding: EncodingKind;
	/** 保存に使う改行。混在は統一済みの 1 種 */
	eol: EolKind;
};
