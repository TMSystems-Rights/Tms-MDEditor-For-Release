// ==============================================
// 起動直後のポータブル切り替え
// ==============================================

// Logger より前に 1 回だけ呼ぶ。ポータブルと決めた保存先はプロセスが終わるまで保持し、書き込めなければ起動を中止する

namespace TmsMdEditor.Services;

/// <summary>
/// 判定ファイルがあるとき、保存先を exe 隣の data へ切り替え、必要なサブフォルダを作る
/// 書き込めないメディアではメッセージを出してプロセスを終了し、別のユーザーフォルダへは逃がさない
/// </summary>
internal static class PortableRuntime
{
	/// <summary>
	/// このプロセスがポータブルとして起動したか。ApplyIfNeeded かテスト用の有効化が true にする
	/// </summary>
	private static bool _portableActive;

	/// <summary>
	/// ポータブル exe のディレクトリ。未適用、またはテストで解除したあとは null
	/// </summary>
	private static string? _portableExeDir;

	/// <summary>
	/// ポータブルとして保存先を切り替え済みか。未適用のときは false
	/// </summary>
	public static bool IsPortable => _portableActive;

	/// <summary>
	/// ポータブル exe のディレクトリ。未適用のときは null
	/// </summary>
	public static string? ExeDir => _portableExeDir;

	/// <summary>
	/// 判定ファイルがあれば保存先を切り替える。Logger、ブートストラップ、単一インスタンスより前に呼ぶ
	/// </summary>
	/// <returns>ポータブルとして適用したら true。判定ファイルが無ければ false。書き込めないときはプロセスを終了する</returns>
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
	/// テストからポータブル状態を適用する。書き込み探針とプロセス終了は行わない
	/// </summary>
	/// <param name="exeDir">ポータブル exe のディレクトリ。サブフォルダをこの配下の data に作る</param>
	public static void EnableForTests(string exeDir)
	{
		PortableDataPaths paths = PortableMode.ResolvePortableDataPaths(exeDir);
		EnsurePortableSubdirectories(paths);
		AppPaths.EnablePortable(exeDir);
		_portableActive = true;
		_portableExeDir = Path.GetFullPath(exeDir);
	}

	/// <summary>
	/// テスト用のポータブル状態を解除し、AppPaths の切り替えも戻す
	/// </summary>
	public static void ResetForTests()
	{
		_portableActive = false;
		_portableExeDir = null;
		AppPaths.ResetPortable();
	}

	/// <summary>
	/// 現プロセスの実行ファイルパスを返す。ProcessPath が空のときだけ WinForms のパスを使う
	/// </summary>
	/// <returns>実行ファイルのパス。相対のままのことがある</returns>
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
	/// ポータブル用の data 配下フォルダを、既にあってもそのまま作る
	/// </summary>
	/// <param name="paths">作成する保存先。ExeDir 自体は作らない</param>
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
	/// 書き込めない展開先であることを表示し、終了コード 1 でプロセスを終了する
	/// </summary>
	/// <param name="detail">ダイアログへ出す失敗理由。空にはしない</param>
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
