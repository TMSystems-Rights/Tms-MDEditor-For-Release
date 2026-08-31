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

	/// <summary>
	/// テスト用に AppData ルートを上書きする
	/// </summary>
	/// <param name="appDataRoot">上書きパス。null で解除</param>
	public static void SetOverrideAppDataRoot(string? appDataRoot)
	{
		_overrideAppDataRoot = appDataRoot;
	}

	/// <summary>
	/// AppData ルート（ブートストラップ設定・ログの固定位置）
	/// </summary>
	public static string AppDataRoot =>
		_overrideAppDataRoot
		?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), GetAppFolderName());

	/// <summary>
	/// ブートストラップ設定ファイルのパス
	/// </summary>
	public static string BootstrapConfigPath => Path.Combine(AppDataRoot, "app-config.json");

	/// <summary>
	/// 既定 dataDir
	/// </summary>
	public static string DefaultDataDir => Path.Combine(AppDataRoot, DataDirName);

	/// <summary>
	/// ログディレクトリ（dataDir 外の固定位置）
	/// </summary>
	public static string LogsDirectory => Path.Combine(AppDataRoot, "logs");

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
