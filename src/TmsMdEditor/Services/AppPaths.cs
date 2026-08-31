namespace TmsMdEditor.Services;

/// <summary>
/// アプリケーションの固定パスを解決する
/// </summary>
internal static class AppPaths
{
	private const string ProdAppFolder = "tms-mdeditor";
	private const string DevAppFolder  = "tms-mdeditor-dev";
	private const string DataDirName   = "data";

	private static string? _overrideAppDataRoot;
	private static bool _portableActive;
	private static string? _portableExeDir;

	/// <summary>
	/// テスト用に AppData ルートを上書きする
	/// </summary>
	/// <param name="appDataRoot">上書きパス。null で解除</param>
	public static void SetOverrideAppDataRoot(string? appDataRoot)
	{
		_overrideAppDataRoot = appDataRoot;
	}

	/// <summary>
	/// ポータブル実行として保存先を exe 隣の data へ切り替える
	/// </summary>
	/// <param name="exeDir">exe ディレクトリ</param>
	public static void EnablePortable(string exeDir)
	{
		_portableActive = true;
		_portableExeDir = Path.GetFullPath(exeDir);
	}

	/// <summary>
	/// ポータブル切替を解除する（テスト用）
	/// </summary>
	public static void ResetPortable()
	{
		_portableActive = false;
		_portableExeDir = null;
	}

	/// <summary>
	/// ポータブル実行中か
	/// </summary>
	public static bool IsPortable => _portableActive;

	/// <summary>
	/// ポータブル exe ディレクトリ
	/// </summary>
	public static string? PortableExeDir => _portableExeDir;

	/// <summary>
	/// AppData ルート（ブートストラップ設定・ログの固定位置。ポータブルでは exe 隣の data）
	/// </summary>
	public static string AppDataRoot
	{
		get
		{
			if (_overrideAppDataRoot is not null)
			{
				return _overrideAppDataRoot;
			}

			if (_portableActive && !string.IsNullOrWhiteSpace(_portableExeDir))
			{
				return Path.Combine(_portableExeDir, DataDirName);
			}

			return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), GetAppFolderName());
		}
	}

	/// <summary>
	/// ブートストラップ設定ファイルのパス
	/// </summary>
	public static string BootstrapConfigPath => Path.Combine(AppDataRoot, "app-config.json");

	/// <summary>
	/// 既定 dataDir。ポータブルでは AppDataRoot と同じ（平坦化）
	/// </summary>
	public static string DefaultDataDir => PortableMode.ResolveDefaultDataDir(AppDataRoot, _portableActive);

	/// <summary>
	/// ログディレクトリ
	/// </summary>
	public static string LogsDirectory => Path.Combine(AppDataRoot, "logs");

	/// <summary>
	/// WebView2 のユーザーデータフォルダ
	/// </summary>
	public static string WebView2UserDataDirectory =>
		_portableActive
			? Path.Combine(AppDataRoot, "webview2")
			: Path.Combine(
				Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
				GetAppFolderName(),
				"webview2");

	/// <summary>
	/// 印刷用 WebView2 のユーザーデータフォルダ
	/// </summary>
	public static string WebView2PrintUserDataDirectory =>
		_portableActive
			? Path.Combine(AppDataRoot, "webview2-print")
			: Path.Combine(
				Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
				GetAppFolderName(),
				"webview2-print");

	/// <summary>
	/// アプリ一時ファイル用ディレクトリ
	/// </summary>
	public static string TempDirectory =>
		_portableActive
			? Path.Combine(AppDataRoot, "temp")
			: Path.GetTempPath();

	/// <summary>
	/// タブ切り離しの一時ファイルディレクトリ
	/// </summary>
	public static string TabTransferDirectory =>
		_portableActive
			? Path.Combine(TempDirectory, "tab-transfers")
			: Path.Combine(TempDirectory, "TmsMdEditor", "tab-transfers");

	/// <summary>
	/// WebView2 のアプリ資産用仮想ホスト名。
	/// Debug と Release で分ける。同一ホストだとインストール版と Debug を同時起動したとき、
	/// 言語チャンクや CSS の読み込みが干渉してハイライトや配色が欠ける。
	/// </summary>
	public static string WebViewVirtualHost =>
#if DEBUG
		"app-dev.tms-mdeditor";
#else
		"app.tms-mdeditor";
#endif

	/// <summary>
	/// dataDir 内 config.json のパス
	/// </summary>
	/// <param name="dataDir">dataDir</param>
	/// <returns>config.json パス</returns>
	public static string GetConfigPath(string dataDir) => Path.Combine(dataDir, "config.json");

	/// <summary>
	/// dataDir 内 session.json のパス
	/// </summary>
	/// <param name="dataDir">dataDir</param>
	/// <returns>session.json パス</returns>
	public static string GetSessionPath(string dataDir) => Path.Combine(dataDir, "session.json");

	/// <summary>
	/// dataDir 内 backups フォルダのパス
	/// </summary>
	/// <param name="dataDir">dataDir</param>
	/// <returns>backups パス</returns>
	public static string GetBackupDirectory(string dataDir) => Path.Combine(dataDir, "backups");

	/// <summary>
	/// dataDir 内 snippets フォルダのパス
	/// </summary>
	/// <param name="dataDir">dataDir</param>
	/// <returns>snippets パス</returns>
	public static string GetSnippetsDirectory(string dataDir) => Path.Combine(dataDir, "snippets");

	/// <summary>
	/// アプリフォルダ名を取得する
	/// </summary>
	/// <returns>フォルダ名</returns>
	private static string GetAppFolderName()
	{
#if DEBUG
		return DevAppFolder;
#else
		return ProdAppFolder;
#endif
	}
}
