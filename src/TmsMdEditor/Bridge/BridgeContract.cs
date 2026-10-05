namespace TmsMdEditor.Bridge;

/// <summary>
/// Web 層から呼び出せるブリッジメソッド名。
/// src/web/src/bridge.ts の BRIDGE_METHOD と同じ値を定義する。
/// </summary>
internal static class BridgeMethod
{
	/// <summary>Web 層とネイティブ層の疎通を確認し、応答時刻とメッセージを返す。</summary>
	public const string Ping                      = "ping";
	/// <summary>Web 層で発生したログをネイティブ側のログへ転送する。</summary>
	public const string LogWrite                  = "log:write";
	/// <summary>現在の設定、データ保存先、および動作環境を取得する。</summary>
	public const string ConfigGet                 = "config:get";
	/// <summary>指定された設定項目またはカスタム装飾を更新する。</summary>
	public const string ConfigUpdate              = "config:update";
	/// <summary>指定された設定項目を既定値へ戻す。</summary>
	public const string ConfigResetItem           = "config:resetItem";
	/// <summary>データ保存先を除く設定全体を既定値へ戻す。</summary>
	public const string ConfigResetAll            = "config:resetAll";
	/// <summary>現在および既定のデータ保存先情報を取得する。</summary>
	public const string ConfigGetDataDir           = "config:getDataDir";
	/// <summary>データ保存先を変更し、既存データを新しい保存先へ移行する。</summary>
	public const string ConfigChangeDataDir        = "config:changeDataDir";
	/// <summary>CSS スニペットの配置場所と有効化状態を取得する。</summary>
	public const string CssSnippetsList            = "cssSnippets:list";
	/// <summary>CSS スニペットの保存フォルダーをエクスプローラーで開く。</summary>
	public const string CssSnippetsOpenFolder      = "cssSnippets:openFolder";
	/// <summary>指定されたパスのテキストファイルを自動判定した文字コードで開く。</summary>
	public const string FileOpen                   = "file:open";
	/// <summary>指定されたパスのテキストファイルを明示された文字コードで開く。</summary>
	public const string FileOpenWithEncoding       = "file:openWithEncoding";
	/// <summary>ファイル選択ダイアログを表示し、選択されたテキストファイルを開く。</summary>
	public const string FileOpenDialog             = "file:openDialog";
	/// <summary>テキストを指定されたパス、文字コード、および改行設定で保存する。</summary>
	public const string FileSave                   = "file:save";
	/// <summary>名前を付けて保存ダイアログを表示し、選択された保存先を返す。</summary>
	public const string FileSaveAsDialog           = "file:saveAsDialog";
	/// <summary>HTML または PDF のエクスポート先を選択するダイアログを表示する。</summary>
	public const string FileExportDialog           = "file:exportDialog";
	/// <summary>生成済みテキストを UTF-8 のファイルとして書き込む。</summary>
	public const string FileWriteUtf8              = "file:writeUtf8";
	/// <summary>ローカルまたは埋め込み画像を読み込み、Data URL として返す。</summary>
	public const string FileReadImageAsDataUrl     = "file:readImageAsDataUrl";
	/// <summary>WebView2 の追加オブジェクトとして渡されたドロップファイルを受け取る。</summary>
	public const string FileDrop                   = "file:drop";
	/// <summary>生成済み HTML を指定された PDF ファイルへ印刷する。</summary>
	public const string ExportPrintToPdf           = "export:printToPdf";
	/// <summary>生成済み HTML を対象に Windows の印刷画面を表示する。</summary>
	public const string ExportShowPrintUi          = "export:showPrintUI";
	/// <summary>最近使用したファイルの一覧を取得する。</summary>
	public const string RecentList                 = "recent:list";
	/// <summary>指定されたファイルを最近使用したファイルへ追加する。</summary>
	public const string RecentAdd                  = "recent:add";
	/// <summary>指定されたファイルを最近使用したファイルから削除する。</summary>
	public const string RecentRemove               = "recent:remove";
	/// <summary>ネイティブウィンドウのタイトルを現在のタブ情報に合わせて更新する。</summary>
	public const string WindowSetTitle             = "window:setTitle";
	/// <summary>指定されたタブを別のネイティブウィンドウへ分離する。</summary>
	public const string WindowDetachTab            = "window:detachTab";
	/// <summary>指定されたファイルをエクスプローラー上で選択表示する。</summary>
	public const string ShellShowInFolder          = "shell:showInFolder";
	/// <summary>指定された URL を設定済みの外部ブラウザーで開く。</summary>
	public const string ShellOpenExternal          = "shell:openExternal";
	/// <summary>フォルダー選択ダイアログを表示し、選択されたパスを返す。</summary>
	public const string ShellPickFolder            = "shell:pickFolder";
	/// <summary>未保存タブの確認結果を報告し、ネイティブウィンドウを閉じてよいか通知する。</summary>
	public const string AppReportCloseReady        = "app:reportCloseReady";
	/// <summary>開いているタブとペイン構成を次回起動時の復元用に保存する。</summary>
	public const string SessionSave                = "session:save";
	/// <summary>ノートごとのカーソル位置とスクロール位置を保存する。</summary>
	public const string NoteViewPositionsSave      = "noteViewPositions:save";
	/// <summary>ネイティブ側で開いているメニューを閉じる。</summary>
	public const string UiDismissMenus             = "ui:dismissMenus";
	/// <summary>クリップボードからプレーンテキストを読み取る。</summary>
	public const string ClipboardReadText          = "clipboard:readText";
	/// <summary>指定されたテキストをクリップボードへ書き込む。</summary>
	public const string ClipboardWriteText         = "clipboard:writeText";
	/// <summary>クリップボード内容を判定し、エディタへ挿入する Markdown に変換する。</summary>
	public const string ClipboardPasteForEditor    = "clipboard:pasteForEditor";
	/// <summary>利用可能な新しいリリースがあるか確認する。</summary>
	public const string UpdateCheck                = "update:check";
	/// <summary>確認済みリリースのインストーラーを検証しながらダウンロードする。</summary>
	public const string UpdateDownload             = "update:download";
	/// <summary>進行中の更新インストーラーのダウンロードを中止する。</summary>
	public const string UpdateCancelDownload       = "update:cancelDownload";
	/// <summary>指定された更新バージョンを以後の自動通知対象から除外する。</summary>
	public const string UpdateSkipVersion          = "update:skipVersion";
	/// <summary>アプリ終了後にダウンロード済みインストーラーを起動する。</summary>
	public const string UpdateApplyNow             = "update:applyNow";
	/// <summary>ポータブル版などが更新を取得するための公式ページを開く。</summary>
	public const string UpdateOpenOfficialPage     = "update:openOfficialPage";
}

/// <summary>
/// C# 層から Web 層へ通知するブリッジイベント名。
/// src/web/src/bridge.ts の BRIDGE_EVENT と同じ値を定義する。
/// </summary>
internal static class BridgeEventName
{
	/// <summary>Web 層の初期化に必要な設定、起動引数、および復元情報を通知する。</summary>
	public const string AppReady              = "app:ready";
	/// <summary>起動後に追加で受け取ったファイルを開くよう Web 層へ通知する。</summary>
	public const string AppOpenFiles          = "app:openFiles";
	/// <summary>ウィンドウを閉じる前に、未保存タブの確認を Web 層へ要求する。</summary>
	public const string AppQueryClose         = "app:queryClose";
	/// <summary>監視中のファイルが外部で変更、削除、または改名されたことを通知する。</summary>
	public const string AppExternalFileChanged = "app:externalFileChanged";
	/// <summary>別ウィンドウから移動されたタブとドロップ位置を通知する。</summary>
	public const string AppReceiveDetachedTab = "app:receiveDetachedTab";
	/// <summary>ネイティブメニューの操作開始時に Web 側のコンテキストメニューを閉じるよう通知する。</summary>
	public const string UiDismissContextMenus = "ui:dismissContextMenus";
	/// <summary>新しい無題タブを作成するよう通知する。</summary>
	public const string MenuNewFile           = "menu:newFile";
	/// <summary>ファイルを開くダイアログを表示するよう通知する。</summary>
	public const string MenuOpenFile          = "menu:openFile";
	/// <summary>現在のタブを上書き保存するよう通知する。</summary>
	public const string MenuSave              = "menu:save";
	/// <summary>現在のタブを名前を付けて保存するよう通知する。</summary>
	public const string MenuSaveAs            = "menu:saveAs";
	/// <summary>現在のタブを HTML としてエクスポートするよう通知する。</summary>
	public const string MenuExportHtml        = "menu:exportHtml";
	/// <summary>現在のタブを PDF としてエクスポートするよう通知する。</summary>
	public const string MenuExportPdf         = "menu:exportPdf";
	/// <summary>現在のタブの印刷画面を表示するよう通知する。</summary>
	public const string MenuPrint             = "menu:print";
	/// <summary>現在のファイルを選択した文字コードで再読み込みするよう通知する。</summary>
	public const string MenuReloadWithEncoding = "menu:reloadWithEncoding";
	/// <summary>現在のエディタで検索パネルを開くよう通知する。</summary>
	public const string MenuFind              = "menu:find";
	/// <summary>現在のエディタで置換パネルを開くよう通知する。</summary>
	public const string MenuReplace           = "menu:replace";
	/// <summary>現在の検索条件に一致する次の位置へ移動するよう通知する。</summary>
	public const string MenuFindNext          = "menu:findNext";
	/// <summary>現在の検索条件に一致する前の位置へ移動するよう通知する。</summary>
	public const string MenuFindPrevious      = "menu:findPrevious";
	/// <summary>現在のタブのソース表示とライブプレビューを切り替えるよう通知する。</summary>
	public const string MenuToggleViewMode    = "menu:toggleViewMode";
	/// <summary>アウトラインの表示と非表示を切り替えるよう通知する。</summary>
	public const string MenuToggleOutline     = "menu:toggleOutline";
	/// <summary>現在のペインを上下に分割するよう通知する。</summary>
	public const string MenuSplitHorizontal   = "menu:splitHorizontal";
	/// <summary>現在のペインを左右に分割するよう通知する。</summary>
	public const string MenuSplitVertical     = "menu:splitVertical";
	/// <summary>現在の分割ペインを一つに戻すよう通知する。</summary>
	public const string MenuUnsplit           = "menu:unsplit";
	/// <summary>設定画面を開くよう通知する。</summary>
	public const string MenuOpenSettings      = "menu:openSettings";
	/// <summary>CSS スニペットをディスクから再読み込みするよう通知する。</summary>
	public const string MenuReloadCssSnippets = "menu:reloadCssSnippets";
	/// <summary>CSS スニペットの保存フォルダーを開くよう通知する。</summary>
	public const string MenuOpenSnippetsFolder = "menu:openSnippetsFolder";
	/// <summary>利用可能な更新を手動で確認するよう通知する。</summary>
	public const string MenuCheckForUpdates   = "menu:checkForUpdates";
	/// <summary>起動時の確認で新しいリリースが見つかったことを通知する。</summary>
	public const string UpdateAvailable       = "update:available";
	/// <summary>更新インストーラーのダウンロード済み割合を通知する。</summary>
	public const string UpdateDownloadProgress = "update:downloadProgress";
	/// <summary>更新インストーラーのダウンロードと検証が完了したことを通知する。</summary>
	public const string UpdateDownloadCompleted = "update:downloadCompleted";
	/// <summary>バックグラウンド更新処理で発生したエラーを通知する。</summary>
	public const string UpdateError           = "update:error";
}

/// <summary>ブリッジ要求で参照する JSON プロパティ名。</summary>
internal static class BridgeProperty
{
	/// <summary>要求と応答を対応付ける一意な要求 ID。</summary>
	public const string Id                = "id";
	/// <summary>ブリッジルーターが実行するメソッド名。</summary>
	public const string Method            = "method";
	/// <summary>ブリッジメソッドへ渡すパラメーターオブジェクト。</summary>
	public const string Params            = "params";
	/// <summary>印刷またはエクスポート対象となる完成済み HTML。</summary>
	public const string Html              = "html";
	/// <summary>読み込み、保存、またはシェル操作の対象となるファイルパス。</summary>
	public const string FilePath          = "filePath";
	/// <summary>ログ、エラー、または疎通確認で受け渡すメッセージ。</summary>
	public const string Message           = "message";
	/// <summary>Web 層から転送するログの重大度。</summary>
	public const string Level             = "level";
	/// <summary>転送ログを発生させた機能またはコンポーネント名。</summary>
	public const string Source            = "source";
	/// <summary>未保存タブの確認後にウィンドウを閉じてよいかを示す値。</summary>
	public const string AllowClose        = "allowClose";
	/// <summary>保存、クリップボード、または貼り付け処理で受け渡すテキスト。</summary>
	public const string Text              = "text";
	/// <summary>クリップボード貼り付けなどで選択された処理モード。</summary>
	public const string Mode              = "mode";
	/// <summary>既存設定へ部分的に適用する設定オブジェクト。</summary>
	public const string Settings          = "settings";
	/// <summary>保存または置換するカスタム装飾ルールの配列。</summary>
	public const string CustomDecorations = "customDecorations";
	/// <summary>位置とサイズを含むネイティブウィンドウ設定。</summary>
	public const string Window            = "window";
	/// <summary>既定値へ戻す対象を表す設定項目のキー。</summary>
	public const string ItemKey           = "itemKey";
	/// <summary>設定やセッションなどを保存するデータディレクトリのパス。</summary>
	public const string DataDir           = "dataDir";
	/// <summary>ファイルの読み書きに使用する文字コード。</summary>
	public const string Encoding          = "encoding";
	/// <summary>保存時に統一する改行コード。指定がなければ既存の改行を維持する。</summary>
	public const string UnifyEol          = "unifyEol";
	/// <summary>読み込む画像を指す Markdown 上のパスまたは URL。</summary>
	public const string Path              = "path";
	/// <summary>相対画像パスの解決基準となる編集中ドキュメントのパス。</summary>
	public const string DocumentPath      = "documentPath";
	/// <summary>Data URL などとして Markdown 内へ埋め込まれた画像データ。</summary>
	public const string Embed             = "embed";
	/// <summary>エクスポートするファイル形式を表す識別子。</summary>
	public const string Kind              = "kind";
	/// <summary>保存ダイアログへ初期表示する推奨ファイル名。</summary>
	public const string SuggestedName     = "suggestedName";
	/// <summary>外部ブラウザーで開く HTTP または HTTPS の URL。</summary>
	public const string Url               = "url";
	/// <summary>ネイティブウィンドウへ表示するタイトル。</summary>
	public const string Title             = "title";
	/// <summary>別ウィンドウへ引き渡すタブの内容と表示状態。</summary>
	public const string Tab               = "tab";
	/// <summary>更新通知のスキップ対象となるリリースバージョン。</summary>
	public const string Version           = "version";
}
