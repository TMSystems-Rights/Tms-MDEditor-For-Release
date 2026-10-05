namespace TmsMdEditor.Services;

/// <summary>構造化ログの出力元を識別するカテゴリ名。</summary>
internal static class LogCategory
{
	/// <summary>アプリケーションシェル、ウィンドウ、および WebView2。</summary>
	public const string Shell = "shell";
	/// <summary>アプリケーション設定の読み書きと移行。</summary>
	public const string Config = "config";
	/// <summary>ファイルおよび画像の読み書き。</summary>
	public const string File = "file";
	/// <summary>HTML、PDF、および印刷処理。</summary>
	public const string Export = "export";
	/// <summary>ノートごとのカーソル位置とスクロール位置。</summary>
	public const string NoteViewPosition = "noteViewPosition";
	/// <summary>更新確認、ダウンロード、および適用。</summary>
	public const string Update = "update";
	/// <summary>データ保存先を決定するブートストラップ設定。</summary>
	public const string Bootstrap = "bootstrap";
	/// <summary>クリップボードの読み書きと貼り付け変換。</summary>
	public const string Clipboard = "clipboard";
	/// <summary>単一インスタンス制御とプロセス間通信。</summary>
	public const string Instance = "instance";
	/// <summary>タブとペインのセッション保存および復元。</summary>
	public const string Session = "session";
	/// <summary>Web 層とネイティブ層のブリッジ通信。</summary>
	public const string Bridge = "bridge";
	/// <summary>CSS スニペットの探索と読み込み。</summary>
	public const string CssSnippets = "css-snippets";
	/// <summary>通常の処理経路で捕捉されなかった例外。</summary>
	public const string Unhandled = "unhandled";
	/// <summary>ファイルの外部変更監視。</summary>
	public const string Watcher = "watcher";
}

/// <summary>構造化ログの追加データで使用するプロパティ名。</summary>
internal static class LogProperty
{
	/// <summary>例外などによって発生したエラー内容。</summary>
	public const string Error = "error";
	/// <summary>処理対象または出力先のファイルパス。</summary>
	public const string FilePath = "filePath";
	/// <summary>設定やセッションなどを保存するデータディレクトリ。</summary>
	public const string DataDir = "dataDir";
	/// <summary>読み書きしたデータのバイト数。</summary>
	public const string Bytes = "bytes";
	/// <summary>移行またはコピー処理の変更前の値。</summary>
	public const string From = "from";
	/// <summary>移行またはコピー処理の変更後の値。</summary>
	public const string To = "to";
	/// <summary>現在の動作条件によって採用されなかった値。</summary>
	public const string Ignored = "ignored";
	/// <summary>ファイルの読み書きに使用した文字コード。</summary>
	public const string Encoding = "encoding";
	/// <summary>ファイル内で主に使用されている改行コード。</summary>
	public const string PrimaryEol = "primaryEol";
	/// <summary>複数種類の改行コードが混在しているかを示す値。</summary>
	public const string EolMixed = "eolMixed";
	/// <summary>保存時に指定された改行コードの統一方法。</summary>
	public const string UnifyEol = "unifyEol";
	/// <summary>処理対象として解決されたファイルパス。</summary>
	public const string ResolvedPath = "resolvedPath";
	/// <summary>画像などの入力として指定されたパスまたは URL。</summary>
	public const string Path = "path";
	/// <summary>相対パスの解決基準となるドキュメントパス。</summary>
	public const string DocumentPath = "documentPath";
	/// <summary>入力として指定された埋め込みデータ。</summary>
	public const string Embed = "embed";
	/// <summary>処理対象となったファイル名またはファイルパス。</summary>
	public const string File = "file";
	/// <summary>Web 層の配布ファイルを読み込んだディレクトリ。</summary>
	public const string WebDistPath = "webDistPath";
	/// <summary>WebView2 がローカルコンテンツへ割り当てた仮想ホスト名。</summary>
	public const string VirtualHost = "virtualHost";
	/// <summary>処理に失敗したブリッジメソッド名。</summary>
	public const string Method = "method";
	/// <summary>データ移行先として指定された新しいディレクトリ。</summary>
	public const string NewDir = "newDir";
	/// <summary>未処理例外が発生したイベントまたは処理経路。</summary>
	public const string Source = "source";
	/// <summary>未処理例外の型、メッセージ、およびスタックトレース。</summary>
	public const string Exception = "exception";
	/// <summary>WebView2 のナビゲーション失敗理由。</summary>
	public const string WebErrorStatus = "webErrorStatus";
}
