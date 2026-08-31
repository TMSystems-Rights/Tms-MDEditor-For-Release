namespace TmsMdEditor.Services;

/// <summary>
/// 起動最初期のポータブル判定と保存先切り替え
/// </summary>
internal static class PortableRuntime
{
	private static bool _portableActive;
	private static string? _portableExeDir;

	/// <summary>
	/// ポータブル実行中か返す
	/// </summary>
	public static bool IsPortable => _portableActive;

	/// <summary>
	/// ポータブル exe ディレクトリを返す
	/// </summary>
	public static string? ExeDir => _portableExeDir;

	/// <summary>
	/// 判定ファイルがあれば起動最初期に保存先を切り替える。
	/// Logger / Bootstrap / 単一インスタンスより前に呼ぶ。
	/// </summary>
	/// <returns>ポータブルとして適用したら true</returns>
	public static bool ApplyIfNeeded()
	{
		string execPath = ResolveExecPath();
		if (!PortableMode.DetectPortableMode(execPath))
		{
			return false;
		}

		string exeDir = PortableMode.ResolveExeDir(execPath);
		PortableDataPaths paths = PortableMode.ResolvePortableDataPaths(exeDir);
		WritableProbeResult probe = PortableMode.ProbeWritableDirectory(paths.UserData);
		if (!probe.Ok)
		{
			ExitBecauseDataDirIsNotWritable(probe.Error ?? "data フォルダへ書き込めません。");
			return false;
		}

		EnsurePortableSubdirectories(paths);
		AppPaths.EnablePortable(exeDir);
		_portableActive = true;
		_portableExeDir = exeDir;
		return true;
	}

	/// <summary>
	/// テスト用にポータブル状態を適用する（終了しない）
	/// </summary>
	/// <param name="exeDir">exe ディレクトリ</param>
	public static void EnableForTests(string exeDir)
	{
		PortableDataPaths paths = PortableMode.ResolvePortableDataPaths(exeDir);
		EnsurePortableSubdirectories(paths);
		AppPaths.EnablePortable(exeDir);
		_portableActive = true;
		_portableExeDir = Path.GetFullPath(exeDir);
	}

	/// <summary>
	/// テスト用にポータブル状態を解除する
	/// </summary>
	public static void ResetForTests()
	{
		_portableActive = false;
		_portableExeDir = null;
		AppPaths.ResetPortable();
	}

	/// <summary>
	/// 現プロセスの実行ファイルパスを返す
	/// </summary>
	/// <returns>exe パス</returns>
	public static string ResolveExecPath()
	{
		string? processPath = Environment.ProcessPath;
		if (!string.IsNullOrWhiteSpace(processPath))
		{
			return processPath;
		}

		return Application.ExecutablePath;
	}

	/// <summary>
	/// ポータブル用サブディレクトリを作成する
	/// </summary>
	/// <param name="paths">保存先</param>
	private static void EnsurePortableSubdirectories(PortableDataPaths paths)
	{
		string[] directories =
		[
			paths.UserData,
			paths.Logs,
			paths.Temp,
			paths.WebView2,
			paths.WebView2Print,
			paths.Backups,
			paths.Snippets,
		];

		foreach (string directory in directories)
		{
			Directory.CreateDirectory(directory);
		}
	}

	/// <summary>
	/// 書き込み不可時のエラーを表示して終了する
	/// </summary>
	/// <param name="detail">詳細</param>
	private static void ExitBecauseDataDirIsNotWritable(string detail)
	{
		MessageBox.Show(
			string.Join(Environment.NewLine, [
				"展開先へ書き込めないため、TMS-MDEditor を起動できません。",
				string.Empty,
				detail,
				string.Empty,
				"読み取り専用メディアや書き込み権限のないフォルダでは使用できません。",
				"設定やログを顧客端末のユーザーフォルダへ退避することはありません。",
			]),
			"TMS-MDEditor",
			MessageBoxButtons.OK,
			MessageBoxIcon.Error);
		Environment.Exit(1);
	}
}
