// ==============================================
// 設定とログのパスを計算して返す
// ==============================================

// プロセス内の静的な切り替え状態だけを持つ
// 呼び出し元はパスを受け取るだけで、フォルダ作成とファイルの中身は各ストアが行う

namespace TmsMdEditor.Services;

/// <summary>
/// ブートストラップ、dataDir、ログ、WebView2、一時ファイルの絶対パスを、今の実行形態から決める
/// ポータブル切替の前に読むとインストーラの AppData を返す。フォルダは作らない
/// </summary>
internal static class AppPaths
{
	// ==============================================
	// 実行形態の上書き
	// ==============================================

	/// <summary>
	/// Release の AppData フォルダ名。Debug と同時起動しても設定が混ざらないように分ける
	/// </summary>
	private const string ProdAppFolder = "tms-mdeditor";

	/// <summary>
	/// Debug の AppData フォルダ名。単一インスタンスの範囲もこの名前で開発用になる
	/// </summary>
	private const string DevAppFolder  = "tms-mdeditor-dev";

	/// <summary>
	/// ポータブル時に exe 隣へ作る data フォルダ名。インストーラの既定 dataDir の末尾にも使う
	/// </summary>
	private const string DataDirName   = "data";

	/// <summary>
	/// テストが差し替える AppData ルート。null のときは実環境のパスを使う。プロセス内で共有する
	/// </summary>
	private static string? _overrideAppDataRoot;

	/// <summary>
	/// ポータブルとして保存先を exe 隣へ寄せるか。EnablePortable から ResetPortable まで true
	/// </summary>
	private static bool _portableActive;

	/// <summary>
	/// ポータブル exe のディレクトリ。未切り替え、または解除後は null
	/// </summary>
	private static string? _portableExeDir;

	/// <summary>
	/// テスト用に AppData ルートを差し替える。null で実環境へ戻す。ポータブル判定自体は変えない
	/// </summary>
	/// <param name="appDataRoot">上書きするルート。null で解除する</param>
	public static void SetOverrideAppDataRoot(string? appDataRoot)
	{
		_overrideAppDataRoot = appDataRoot;
	}

	/// <summary>
	/// 以後のパス解決を、exe 隣の data を AppData ルートとするポータブル配置へ切り替える
	/// </summary>
	/// <param name="exeDir">exe のディレクトリ。絶対パスにして保持する</param>
	public static void EnablePortable(string exeDir)
	{
		_portableActive = true;
		_portableExeDir = Path.GetFullPath(exeDir);
	}

	/// <summary>
	/// ポータブル切替を解除する。テストが実環境のパス解決へ戻すときに使う
	/// </summary>
	public static void ResetPortable()
	{
		_portableActive = false;
		_portableExeDir = null;
	}

	/// <summary>
	/// ポータブル切替が有効か。未呼び出しのときは false
	/// </summary>
	public static bool IsPortable => _portableActive;

	/// <summary>
	/// ポータブル exe のディレクトリ。未切り替えのときは null
	/// </summary>
	public static string? PortableExeDir => _portableExeDir;

	// ==============================================
	// 解決するパス
	// ==============================================

	/// <summary>
	/// ブートストラップ設定とログの固定位置。テスト上書き、ポータブルの data、AppData の順で決める
	/// </summary>
	public static string AppDataRoot
	{
		get
		{
			// テストが差し替えたルートがあるときは実環境もポータブルも見ない
			if (_overrideAppDataRoot is not null)
			{
				return _overrideAppDataRoot;
			}

			// ポータブル切替済みで、exe ディレクトリが空白でないときだけ data を返す。どちらかが欠けても入らない
			if (_portableActive && !string.IsNullOrWhiteSpace(_portableExeDir))
			{
				return Path.Combine(_portableExeDir, DataDirName);
			}

			return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), GetAppFolderName());
		}
	}

	/// <summary>
	/// ブートストラップ設定 app-config.json の絶対パス。dataDir の config.json とは別ファイル
	/// </summary>
	public static string BootstrapConfigPath => Path.Combine(AppDataRoot, "app-config.json");

	/// <summary>
	/// 既定 dataDir。ポータブルでは AppDataRoot と同じ平坦配置、それ以外は AppDataRoot 配下の data
	/// </summary>
	public static string DefaultDataDir => PortableMode.ResolveDefaultDataDir(AppDataRoot, _portableActive);

	/// <summary>
	/// 日次ログのディレクトリ。AppDataRoot 配下の logs で、dataDir の移動先には付いていかない
	/// </summary>
	public static string LogsDirectory => Path.Combine(AppDataRoot, "logs");

	/// <summary>
	/// 編集用 WebView2 のユーザーデータ。ポータブルは data 配下、それ以外は LocalAppData 配下
	/// </summary>
	public static string WebView2UserDataDirectory =>
		_portableActive
			? Path.Combine(AppDataRoot, "webview2")
			: Path.Combine(
				Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
				GetAppFolderName(),
				"webview2");

	/// <summary>
	/// 印刷用 WebView2 のユーザーデータ。編集用とはフォルダを分け、同時にプロファイルが混ざらないようにする
	/// </summary>
	public static string WebView2PrintUserDataDirectory =>
		_portableActive
			? Path.Combine(AppDataRoot, "webview2-print")
			: Path.Combine(
				Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
				GetAppFolderName(),
				"webview2-print");

	/// <summary>
	/// アプリの一時ディレクトリ。ポータブルは data 配下の temp、それ以外は OS の一時ディレクトリ
	/// </summary>
	public static string TempDirectory =>
		_portableActive
			? Path.Combine(AppDataRoot, "temp")
			: Path.GetTempPath();

	/// <summary>
	/// タブ切り離しの状態ファイルを置くディレクトリ。ポータブルは temp 配下、それ以外は OS 一時配下の TmsMdEditor
	/// </summary>
	public static string TabTransferDirectory =>
		_portableActive
			? Path.Combine(TempDirectory, "tab-transfers")
			: Path.Combine(TempDirectory, "TmsMdEditor", "tab-transfers");

	/// <summary>
	/// WebView2 のアプリ資産用仮想ホスト名
	/// Debug と Release で分ける。同一ホストだとインストール版と Debug を同時起動したとき、
	/// 言語チャンクや CSS の読み込みが干渉してハイライトや配色が欠ける
	/// </summary>
	public static string WebViewVirtualHost =>
#if DEBUG
		"app-dev.tms-mdeditor";
#else
		"app.tms-mdeditor";
#endif

	/// <summary>
	/// dataDir 内 config.json の絶対パスを返す。フォルダの有無は見ない
	/// </summary>
	/// <param name="dataDir">設定を置く dataDir</param>
	/// <returns>config.json の絶対パスとは限らない結合結果</returns>
	public static string GetConfigPath(string dataDir) => Path.Combine(dataDir, "config.json");

	/// <summary>
	/// dataDir 内 session.json のパスを返す。セッションの中身は検証しない
	/// </summary>
	/// <param name="dataDir">セッションを置く dataDir</param>
	/// <returns>session.json の結合パス</returns>
	public static string GetSessionPath(string dataDir) => Path.Combine(dataDir, "session.json");

	/// <summary>
	/// dataDir 内 note-view-positions.json のパスを返す
	/// </summary>
	/// <param name="dataDir">表示位置を置く dataDir</param>
	/// <returns>note-view-positions.json の結合パス</returns>
	public static string GetNoteViewPositionsPath(string dataDir) => Path.Combine(dataDir, "note-view-positions.json");

	/// <summary>
	/// dataDir 内 backups フォルダのパスを返す。フォルダは作らない
	/// </summary>
	/// <param name="dataDir">バックアップの親になる dataDir</param>
	/// <returns>backups の結合パス</returns>
	public static string GetBackupDirectory(string dataDir) => Path.Combine(dataDir, "backups");

	/// <summary>
	/// dataDir 内 snippets フォルダのパスを返す。フォルダは作らない
	/// </summary>
	/// <param name="dataDir">スニペットの親になる dataDir</param>
	/// <returns>snippets の結合パス</returns>
	public static string GetSnippetsDirectory(string dataDir) => Path.Combine(dataDir, "snippets");

	/// <summary>
	/// AppData 配下で使うフォルダ名を返す。Debug と Release で分け、同時起動の設定を混ぜない
	/// </summary>
	/// <returns>Debug なら tms-mdeditor-dev、それ以外は tms-mdeditor</returns>
	private static string GetAppFolderName()
	{
#if DEBUG
		return DevAppFolder;
#else
		return ProdAppFolder;
#endif
	}
}
