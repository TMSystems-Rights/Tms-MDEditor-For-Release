using System.Security.Cryptography;
using System.Text;

namespace TmsMdEditor.Services;

/// <summary>
/// ポータブル判定・保存先・更新方式の純関数
/// </summary>
internal static class PortableMode
{
	/// <summary>ポータブル判定ファイル名</summary>
	public const string MarkerFileName = "portable-mode.json";

	/// <summary>ポータブル版 AppUserModelID</summary>
	public const string PortableAppUserModelId = "jp.tm-systems.tms-mdeditor.portable";

	/// <summary>インストーラ版 AppUserModelID</summary>
	public const string InstallerAppUserModelId = "jp.tm-systems.tms-mdeditor";

	/// <summary>Debug 用 AppUserModelID</summary>
	public const string DevAppUserModelId = "jp.tm-systems.tms-mdeditor.dev";

	/// <summary>
	/// exe と同じフォルダを返す
	/// </summary>
	/// <param name="execPath">実行ファイルパス</param>
	/// <returns>exe ディレクトリ</returns>
	public static string ResolveExeDir(string execPath)
	{
		string fullPath = Path.GetFullPath(execPath);
		string? directory = Path.GetDirectoryName(fullPath);
		if (string.IsNullOrWhiteSpace(directory))
		{
			throw new InvalidOperationException("実行ファイルのディレクトリを解決できません。");
		}

		return directory;
	}

	/// <summary>
	/// ポータブル判定ファイルのパスを返す
	/// </summary>
	/// <param name="execPath">実行ファイルパス</param>
	/// <returns>判定ファイルパス</returns>
	public static string ResolveMarkerPath(string execPath)
	{
		return Path.Combine(ResolveExeDir(execPath), MarkerFileName);
	}

	/// <summary>
	/// ポータブルモードか判定する。cwd は見ない。
	/// ファイルがあれば JSON の成否に関わらずポータブルとする。
	/// </summary>
	/// <param name="execPath">実行ファイルパス</param>
	/// <param name="existsFn">存在判定</param>
	/// <returns>ポータブルなら true</returns>
	public static bool DetectPortableMode(string execPath, Func<string, bool>? existsFn = null)
	{
		Func<string, bool> exists = existsFn ?? File.Exists;
		return exists(ResolveMarkerPath(execPath));
	}

	/// <summary>
	/// ポータブル版の保存先パスを解決する。dataDir は userData と同じ（平坦化）。
	/// </summary>
	/// <param name="exeDir">exe ディレクトリ</param>
	/// <returns>保存先</returns>
	public static PortableDataPaths ResolvePortableDataPaths(string exeDir)
	{
		string userData = Path.Combine(exeDir, "data");

		return new PortableDataPaths
		{
			ExeDir         = exeDir,
			UserData       = userData,
			DataDir        = userData,
			Logs           = Path.Combine(userData, "logs"),
			Temp           = Path.Combine(userData, "temp"),
			WebView2       = Path.Combine(userData, "webview2"),
			WebView2Print  = Path.Combine(userData, "webview2-print"),
			Backups        = Path.Combine(userData, "backups"),
			Snippets       = Path.Combine(userData, "snippets"),
		};
	}

	/// <summary>
	/// 既定 dataDir を解決する
	/// </summary>
	/// <param name="userData">userData / AppDataRoot</param>
	/// <param name="isPortable">ポータブルなら true</param>
	/// <returns>dataDir</returns>
	public static string ResolveDefaultDataDir(string userData, bool isPortable)
	{
		return isPortable ? userData : Path.Combine(userData, "data");
	}

	/// <summary>
	/// dataDir が平坦配置か判定する
	/// </summary>
	/// <param name="dataDir">dataDir</param>
	/// <param name="userData">userData</param>
	/// <returns>dataDir が userData と同じなら true</returns>
	public static bool IsFlattenedDataDir(string dataDir, string userData)
	{
		return Path.GetFullPath(dataDir).Equals(Path.GetFullPath(userData), StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// 更新確認の実装方式を決める
	/// </summary>
	/// <param name="isPortable">ポータブルなら true</param>
	/// <returns>更新確認方式</returns>
	public static UpdateCheckMode ResolveUpdateCheckMode(bool isPortable)
	{
		return isPortable ? UpdateCheckMode.GithubReleaseTagOnly : UpdateCheckMode.InstallerDownload;
	}

	/// <summary>
	/// AppUserModelID を解決する
	/// </summary>
	/// <param name="isPortable">ポータブルなら true</param>
	/// <param name="isDebug">Debug ビルドなら true</param>
	/// <returns>AppUserModelID</returns>
	public static string ResolveAppUserModelId(bool isPortable, bool isDebug)
	{
		if (isPortable)
		{
			return PortableAppUserModelId;
		}

		return isDebug ? DevAppUserModelId : InstallerAppUserModelId;
	}

	/// <summary>
	/// 単一インスタンスの Mutex / Pipe スコープを解決する
	/// </summary>
	/// <param name="isPortable">ポータブルなら true</param>
	/// <param name="exeDir">ポータブル時の exe ディレクトリ</param>
	/// <param name="appDataFolderName">インストーラ / Debug 時の AppData フォルダ名</param>
	/// <returns>スコープ</returns>
	public static string ResolveInstanceScope(bool isPortable, string? exeDir, string appDataFolderName)
	{
		if (isPortable)
		{
			string normalized = Path.GetFullPath(string.IsNullOrWhiteSpace(exeDir) ? "." : exeDir)
				.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
				.ToUpperInvariant();
			byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
			return "portable-" + Convert.ToHexString(hash)[..16].ToLowerInvariant();
		}

		return string.Equals(appDataFolderName, "tms-mdeditor-dev", StringComparison.OrdinalIgnoreCase)
			? "dev-v1"
			: "prod-v1";
	}

	/// <summary>
	/// ディレクトリへ書き込めるか探針する。失敗しても他場所へ逃がさない。
	/// </summary>
	/// <param name="directory">探針対象</param>
	/// <returns>結果</returns>
	public static WritableProbeResult ProbeWritableDirectory(string directory)
	{
		string probeName = $".write-probe-{Environment.ProcessId}-{DateTime.UtcNow.Ticks}";
		string probePath = Path.Combine(directory, probeName);

		try
		{
			Directory.CreateDirectory(directory);
			File.WriteAllText(probePath, "ok");
			File.Delete(probePath);
			return new WritableProbeResult { Ok = true };
		}
		catch (Exception ex)
		{
			try
			{
				if (File.Exists(probePath))
				{
					File.Delete(probePath);
				}
			}
			catch
			{
				// 探針ファイルの後始末に失敗しても、書き込み不可の判定を優先する
			}

			return new WritableProbeResult
			{
				Ok    = false,
				Error = ex.Message,
			};
		}
	}
}

/// <summary>
/// ポータブル版の保存先パス
/// </summary>
internal sealed class PortableDataPaths
{
	public string ExeDir { get; init; } = string.Empty;

	public string UserData { get; init; } = string.Empty;

	public string DataDir { get; init; } = string.Empty;

	public string Logs { get; init; } = string.Empty;

	public string Temp { get; init; } = string.Empty;

	public string WebView2 { get; init; } = string.Empty;

	public string WebView2Print { get; init; } = string.Empty;

	public string Backups { get; init; } = string.Empty;

	public string Snippets { get; init; } = string.Empty;
}

/// <summary>
/// 書き込み探針結果
/// </summary>
internal sealed class WritableProbeResult
{
	public bool Ok { get; init; }

	public string? Error { get; init; }
}

/// <summary>
/// 更新確認の実装方式
/// </summary>
internal enum UpdateCheckMode
{
	InstallerDownload,
	GithubReleaseTagOnly,
}
