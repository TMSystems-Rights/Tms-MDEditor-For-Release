// ==============================================
// ポータブル判定と保存先の計算
// ==============================================

// 実行ファイルの場所だけを見て、cwd は見ない
// 実際の切り替えとプロセス終了は PortableRuntime が行い、ここはパスと更新方式を返す

using System.Security.Cryptography;
using System.Text;

namespace TmsMdEditor.Services;

/// <summary>
/// 判定ファイル、保存先、AppUserModelID、単一インスタンスの範囲を、状態を持たずに計算する
/// 書き込み探針だけがファイルを作り、失敗しても別の場所へは切り替えない
/// </summary>
internal static class PortableMode
{
	// ==============================================
	// 配布形態の識別子
	// ==============================================

	/// <summary>
	/// exe と同じフォルダに置く判定ファイル名。中身が JSON でなくても、ファイルがあればポータブルとする
	/// </summary>
	public const string MarkerFileName = "portable-mode.json";

	/// <summary>
	/// ポータブル版の AppUserModelID。インストーラ版とタスクバーで分けて表示するために使う
	/// </summary>
	public const string PortableAppUserModelId = "jp.tm-systems.tms-mdeditor.portable";

	/// <summary>
	/// インストーラ版の AppUserModelID。Debug でもポータブルでもないときに使う
	/// </summary>
	public const string InstallerAppUserModelId = "jp.tm-systems.tms-mdeditor";

	/// <summary>
	/// Debug ビルドの AppUserModelID。ポータブルのときは使わない
	/// </summary>
	public const string DevAppUserModelId = "jp.tm-systems.tms-mdeditor.dev";

	// ==============================================
	// パスとインスタンス範囲
	// ==============================================

	/// <summary>
	/// 実行ファイルの絶対パスから、そのディレクトリを返す
	/// </summary>
	/// <param name="execPath">実行ファイルのパス。相対パスはカレントから絶対パスにする</param>
	/// <returns>exe のあるディレクトリ</returns>
	/// <exception cref="InvalidOperationException"><paramref name="execPath"/> のディレクトリを決められない</exception>
	public static string ResolveExeDir(string execPath)
	{
		// 相対パスを絶対パスにした実行ファイル
		string fullPath = Path.GetFullPath(execPath);
		// exe のディレクトリ。ルートだけのパスでは空や null になり得る
		string? directory = Path.GetDirectoryName(fullPath);
		// ディレクトリを決められないパスはポータブル判定へ進まず失敗にする
		if (string.IsNullOrWhiteSpace(directory))
		{
			throw new InvalidOperationException("実行ファイルのディレクトリを解決できません。");
		}

		return directory;
	}

	/// <summary>
	/// 判定ファイルの絶対パスを返す。ファイルの有無は見ない
	/// </summary>
	/// <param name="execPath">実行ファイルのパス。ディレクトリ解決に失敗すると例外になる</param>
	/// <returns>exe 隣の portable-mode.json</returns>
	public static string ResolveMarkerPath(string execPath)
	{
		return Path.Combine(ResolveExeDir(execPath), MarkerFileName);
	}

	/// <summary>
	/// ポータブルモードかを返す。カレントディレクトリは見ない
	/// ファイルがあれば JSON の成否に関わらずポータブルとする
	/// </summary>
	/// <param name="execPath">実行ファイルのパス。判定ファイルは exe 隣だけを見る</param>
	/// <param name="existsFn">存在判定。null なら File.Exists。テストがファイルシステムを避けるために渡す</param>
	/// <returns>判定ファイルがあれば true</returns>
	public static bool DetectPortableMode(string execPath, Func<string, bool>? existsFn = null)
	{
		// 存在判定。テストが null を渡したときは File.Exists。戻りは常に非 null
		Func<string, bool> exists = existsFn ?? File.Exists;
		return exists(ResolveMarkerPath(execPath));
	}

	/// <summary>
	/// ポータブル版の保存先を返す。dataDir は userData と同じ平坦配置で、フォルダはまだ作らない
	/// </summary>
	/// <param name="exeDir">exe のディレクトリ。data フォルダの親になる</param>
	/// <returns>exe 隣の data と、その配下のログ、一時、WebView2、バックアップ、スニペット</returns>
	public static PortableDataPaths ResolvePortableDataPaths(string exeDir)
	{
		// exe 隣の data。dataDir もログもこの配下で、まだ作らない
		string userData = Path.Combine(exeDir, "data");

		// ポータブルの保存先一式。平坦配置なので DataDir は UserData と同じ
		return new PortableDataPaths
		{
			// 判定に使った exe のディレクトリ。保存先そのものではない
			ExeDir         = exeDir,
			// ユーザーデータルート
			UserData       = userData,
			// 設定上の dataDir。userData と重ねない
			DataDir        = userData,
			// 日次ログ
			Logs           = Path.Combine(userData, "logs"),
			// 一時ファイル
			Temp           = Path.Combine(userData, "temp"),
			// 編集用 WebView2。インストーラの LocalAppData とは別
			WebView2       = Path.Combine(userData, "webview2"),
			// 印刷用。編集用と混ぜない
			WebView2Print  = Path.Combine(userData, "webview2-print"),
			// 設定バックアップ
			Backups        = Path.Combine(userData, "backups"),
			// CSS スニペット
			Snippets       = Path.Combine(userData, "snippets"),
		};
	}

	/// <summary>
	/// 既定の dataDir を返す。ポータブルは userData そのもの、それ以外は userData 配下の data
	/// </summary>
	/// <param name="userData">ポータブルの data、またはインストーラの AppData ルート</param>
	/// <param name="isPortable">ポータブルなら true。true のときサブフォルダ data は重ねない</param>
	/// <returns>既定 dataDir。フォルダは作らない</returns>
	public static string ResolveDefaultDataDir(string userData, bool isPortable)
	{
		return isPortable ? userData : Path.Combine(userData, "data");
	}

	/// <summary>
	/// dataDir が userData と同じ平坦配置かを返す。比較前に両方を絶対パスにする
	/// </summary>
	/// <param name="dataDir">設定上の dataDir</param>
	/// <param name="userData">比較する userData。ポータブルでは data フォルダ</param>
	/// <returns>大文字小文字を無視して同じディレクトリなら true</returns>
	public static bool IsFlattenedDataDir(string dataDir, string userData)
	{
		return Path.GetFullPath(dataDir).Equals(Path.GetFullPath(userData), StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// 更新確認で資産のダウンロードまで行うかを返す。ポータブルはタグの比較だけにする
	/// </summary>
	/// <param name="isPortable">ポータブルなら true</param>
	/// <returns>ポータブルならタグ比較のみ、それ以外はインストーラのダウンロード</returns>
	public static UpdateCheckMode ResolveUpdateCheckMode(bool isPortable)
	{
		return isPortable ? UpdateCheckMode.GithubReleaseTagOnly : UpdateCheckMode.InstallerDownload;
	}

	/// <summary>
	/// タスクバーで配布形態を分ける AppUserModelID を返す。ポータブルを Debug より優先する
	/// </summary>
	/// <param name="isPortable">ポータブルなら true。true のとき Debug かは見ない</param>
	/// <param name="isDebug">Debug ビルドなら true。ポータブルでないときだけ使う</param>
	/// <returns>ポータブル、Debug、インストーラのいずれかの AppUserModelID</returns>
	public static string ResolveAppUserModelId(bool isPortable, bool isDebug)
	{
		// ポータブルは Debug より優先し、開発用 ID は使わない
		if (isPortable)
		{
			return PortableAppUserModelId;
		}

		return isDebug ? DevAppUserModelId : InstallerAppUserModelId;
	}

	/// <summary>
	/// 単一インスタンスの Mutex と名前付きパイプを分ける範囲を返す
	/// </summary>
	/// <param name="isPortable">ポータブルなら true。true のときは exe ディレクトリのハッシュを使う</param>
	/// <param name="exeDir">ポータブル時の exe ディレクトリ。null や空白はカレントディレクトリとして扱う</param>
	/// <param name="appDataFolderName">インストーラまたは Debug の AppData フォルダ名。dev フォルダなら開発用の範囲にする</param>
	/// <returns>Mutex 名とパイプ名の接尾辞。ポータブルは portable- と SHA-256 の先頭 16 桁</returns>
	public static string ResolveInstanceScope(bool isPortable, string? exeDir, string appDataFolderName)
	{
		// ポータブルは exe の場所で範囲を分ける。インストーラのフォルダ名では入らない
		if (isPortable)
		{
			// 比較用の絶対パス。null や空白の exeDir はカレント、末尾の区切りは除き、大文字に揃える
			string normalized = Path.GetFullPath(string.IsNullOrWhiteSpace(exeDir) ? "." : exeDir)
				.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
				.ToUpperInvariant();
			// パスの SHA-256。先頭 16 桁だけを範囲名に使う
			byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
			return "portable-" + Convert.ToHexString(hash)[..16].ToLowerInvariant();
		}

		return string.Equals(appDataFolderName, "tms-mdeditor-dev", StringComparison.OrdinalIgnoreCase)
			? "dev-v1"
			: "prod-v1";
	}

	// ==============================================
	// 書き込み探針
	// ==============================================

	/// <summary>
	/// ディレクトリへ探針ファイルを書いて削除できるかを調べる。失敗しても他の場所へは切り替えない
	/// </summary>
	/// <param name="directory">探針するディレクトリ。無ければ作る</param>
	/// <returns>作成と削除までできれば成功。失敗時は例外メッセージを入れる</returns>
	public static WritableProbeResult ProbeWritableDirectory(string directory)
	{
		// 他プロセスと衝突しない探針ファイル名。プロセス ID と UTC のティック
		string probeName = $".write-probe-{Environment.ProcessId}-{DateTime.UtcNow.Ticks}";
		// 探針ファイルのフルパス。失敗時の後始末もこのパス
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
				// 残った探針ファイルがあるときだけ消す。最初から無ければ入らない
				if (File.Exists(probePath))
				{
					File.Delete(probePath);
				}
			}
			catch
			{
				// 探針ファイルの後始末に失敗しても、書き込み不可の判定を優先する
			}

			// 書き込み不可。別の場所へは切り替えない
			return new WritableProbeResult
			{
				// 探針は失敗
				Ok    = false,
				// 呼び出し元がダイアログへ出す例外メッセージ
				Error = ex.Message,
			};
		}
	}
}

/// <summary>
/// ポータブル版で使うディレクトリ一式。作成はせず、パスの計算結果だけを持つ
/// </summary>
internal sealed class PortableDataPaths
{
	/// <summary>
	/// ポータブル exe のディレクトリ。data の親であり、保存先そのものではない
	/// </summary>
	public string ExeDir { get; init; } = string.Empty;

	/// <summary>
	/// exe 隣の data。ポータブルのユーザーデータルート
	/// </summary>
	public string UserData { get; init; } = string.Empty;

	/// <summary>
	/// 設定上の dataDir。ポータブルでは <see cref="UserData"/> と同じ平坦配置
	/// </summary>
	public string DataDir { get; init; } = string.Empty;

	/// <summary>
	/// 日次ログを置く data 配下の logs
	/// </summary>
	public string Logs { get; init; } = string.Empty;

	/// <summary>
	/// ポータブル時の一時ファイル用 data 配下の temp
	/// </summary>
	public string Temp { get; init; } = string.Empty;

	/// <summary>
	/// 編集用 WebView2 のユーザーデータ。インストーラ版の LocalAppData とは別パス
	/// </summary>
	public string WebView2 { get; init; } = string.Empty;

	/// <summary>
	/// 印刷用 WebView2 のユーザーデータ。編集用とはフォルダを分ける
	/// </summary>
	public string WebView2Print { get; init; } = string.Empty;

	/// <summary>
	/// 設定バックアップを置く data 配下の backups
	/// </summary>
	public string Backups { get; init; } = string.Empty;

	/// <summary>
	/// CSS スニペットを置く data 配下の snippets
	/// </summary>
	public string Snippets { get; init; } = string.Empty;
}

/// <summary>
/// 書き込み探針の成否。失敗しても保存先は変えない
/// </summary>
internal sealed class WritableProbeResult
{
	/// <summary>
	/// 探針ファイルの作成と削除までできたとき true
	/// </summary>
	public bool Ok { get; init; }

	/// <summary>
	/// 失敗時の例外メッセージ。成功時は null
	/// </summary>
	public string? Error { get; init; }
}

/// <summary>
/// 更新確認で、インストーラ資産まで取るか、タグの比較で終えるか
/// </summary>
internal enum UpdateCheckMode
{
	/// <summary>
	/// インストーラ資産の有無とダウンロードまで行う。ポータブル以外
	/// </summary>
	InstallerDownload,

	/// <summary>
	/// Release の tag だけを比較し、資産は要求しない。ポータブル用
	/// </summary>
	GithubReleaseTagOnly,
}
