// ==============================================
// マーカーでポータブル判定とパスを分ける
// ==============================================

// マーカーの有無でポータブルを判定し、data、更新確認、アプリ ID、書き込み失敗時の扱いを版ごとに固定する

using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリを exe の位置にして、ポータブル判定とパス解決を検証する
/// プロセスのポータブル状態は各テストの前後で戻す
/// </summary>
public sealed class PortableModeTests : IDisposable
{
	/// <summary>
	/// exe やマーカーを置く一時ルート。テストごとに作り、Dispose で削除する
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// ポータブル状態を戻し、空の一時ディレクトリを作る
	/// </summary>
	public PortableModeTests()
	{
		PortableRuntime.ResetForTests();
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-portable-{Guid.NewGuid():N}");
		Directory.CreateDirectory(_tempRoot);
	}

	/// <summary>
	/// ポータブル状態を戻し、一時ディレクトリが残っていれば削除する
	/// </summary>
	public void Dispose()
	{
		PortableRuntime.ResetForTests();
		if (Directory.Exists(_tempRoot))
		{
			Directory.Delete(_tempRoot, recursive: true);
		}
	}

	/// <summary>
	/// マーカーが exe の隣にあるときだけポータブルとし、カレントディレクトリの位置では判定しない
	/// </summary>
	[Fact]
	public void DetectPortableMode_uses_exec_path_not_cwd()
	{
		string exeDir = Path.Combine(_tempRoot, "app");
		Directory.CreateDirectory(exeDir);
		string execPath = Path.Combine(exeDir, "TmsMdEditor.exe");
		File.WriteAllText(Path.Combine(exeDir, PortableMode.MarkerFileName), "{ not-json");
		string otherDir = Path.Combine(_tempRoot, "other");
		Directory.CreateDirectory(otherDir);
		string previous = Environment.CurrentDirectory;
		try
		{
			Environment.CurrentDirectory = otherDir;
			Assert.True(PortableMode.DetectPortableMode(execPath));
			Assert.False(PortableMode.DetectPortableMode(Path.Combine(otherDir, "TmsMdEditor.exe")));
		}
		finally
		{
			Environment.CurrentDirectory = previous;
		}
	}

	/// <summary>
	/// マーカーの中身が JSON でなくても、ファイルがあればポータブルとする
	/// </summary>
	[Fact]
	public void DetectPortableMode_treats_broken_json_as_portable()
	{
		string execPath = Path.Combine(_tempRoot, "TmsMdEditor.exe");
		File.WriteAllText(PortableMode.ResolveMarkerPath(execPath), "broken");
		Assert.True(PortableMode.DetectPortableMode(execPath));
	}

	/// <summary>
	/// マーカーが無い exe はポータブルにしない
	/// </summary>
	[Fact]
	public void DetectPortableMode_is_false_without_marker()
	{
		string execPath = Path.Combine(_tempRoot, "plain", "TmsMdEditor.exe");
		Directory.CreateDirectory(Path.GetDirectoryName(execPath)!);
		Assert.False(PortableMode.DetectPortableMode(execPath));
	}

	/// <summary>
	/// ポータブルの data は exe の隣の data で、その中に data を重ねない
	/// </summary>
	[Fact]
	public void ResolvePortableDataPaths_flattens_data_dir()
	{
		string exeDir = Path.Combine(_tempRoot, "TMS-MDEditor");
		PortableDataPaths paths = PortableMode.ResolvePortableDataPaths(exeDir);

		Assert.Equal(Path.Combine(exeDir, "data"), paths.DataDir);
		Assert.Equal(paths.UserData, paths.DataDir);
		Assert.True(PortableMode.IsFlattenedDataDir(paths.DataDir, paths.UserData));
		Assert.False(paths.DataDir.EndsWith(Path.Combine("data", "data"), StringComparison.OrdinalIgnoreCase));
		Assert.Equal(Path.Combine(exeDir, "data", "logs"), paths.Logs);
		Assert.Equal(Path.Combine(exeDir, "data", "webview2"), paths.WebView2);
		Assert.Equal(Path.Combine(exeDir, "data", "temp"), paths.Temp);
	}

	/// <summary>
	/// インストーラ版は userData の下の data、ポータブル版は userData そのものを data にする
	/// </summary>
	[Fact]
	public void ResolveDefaultDataDir_keeps_installer_nested_layout()
	{
		string userData = Path.Combine(_tempRoot, "tms-mdeditor");
		Assert.Equal(Path.Combine(userData, "data"), PortableMode.ResolveDefaultDataDir(userData, isPortable: false));
		Assert.Equal(userData, PortableMode.ResolveDefaultDataDir(userData, isPortable: true));
	}

	/// <summary>
	/// ポータブルはタグ名だけの更新確認、インストーラ版はインストーラのダウンロード確認にする
	/// </summary>
	[Fact]
	public void ResolveUpdateCheckMode_uses_tag_only_for_portable()
	{
		Assert.Equal(UpdateCheckMode.GithubReleaseTagOnly, PortableMode.ResolveUpdateCheckMode(true));
		Assert.Equal(UpdateCheckMode.InstallerDownload, PortableMode.ResolveUpdateCheckMode(false));
	}

	/// <summary>
	/// ポータブル、インストーラ、開発でアプリ ID を分け、ポータブルのコピーごとにインスタンス範囲も分ける
	/// </summary>
	[Fact]
	public void ResolveAppUserModelId_and_instance_scope_separate_editions()
	{
		Assert.Equal(PortableMode.PortableAppUserModelId, PortableMode.ResolveAppUserModelId(true, false));
		Assert.Equal(PortableMode.InstallerAppUserModelId, PortableMode.ResolveAppUserModelId(false, false));
		Assert.Equal(PortableMode.DevAppUserModelId, PortableMode.ResolveAppUserModelId(false, true));

		string first = PortableMode.ResolveInstanceScope(true, Path.Combine(_tempRoot, "copy-a"), "data");
		string second = PortableMode.ResolveInstanceScope(true, Path.Combine(_tempRoot, "copy-b"), "data");
		Assert.StartsWith("portable-", first);
		Assert.NotEqual(first, second);
		Assert.Equal("prod-v1", PortableMode.ResolveInstanceScope(false, null, "tms-mdeditor"));
		Assert.Equal("dev-v1", PortableMode.ResolveInstanceScope(false, null, "tms-mdeditor-dev"));
	}

	/// <summary>
	/// 書けるディレクトリは成功し、親がファイルのパスは失敗理由を返して別の場所は作らない
	/// </summary>
	[Fact]
	public void ProbeWritableDirectory_reports_failure_without_fallback()
	{
		string missingParent = Path.Combine(_tempRoot, "no-such-parent", "data");
		File.WriteAllText(Path.Combine(_tempRoot, "blocker"), "x");
		string blocked = Path.Combine(_tempRoot, "blocker", "data");

		WritableProbeResult ok = PortableMode.ProbeWritableDirectory(Path.Combine(_tempRoot, "writable"));
		Assert.True(ok.Ok);

		WritableProbeResult failed = PortableMode.ProbeWritableDirectory(blocked);
		Assert.False(failed.Ok);
		Assert.False(string.IsNullOrWhiteSpace(failed.Error));
		// 書けないパスの失敗で、探していない未作成ディレクトリは作らない
		Assert.False(Directory.Exists(missingParent));
	}

	/// <summary>
	/// ポータブルを有効にすると、設定もログも WebView2 も exe 隣の data 配下を向く
	/// </summary>
	[Fact]
	public void EnablePortable_switches_app_paths_to_flattened_data()
	{
		string exeDir = Path.Combine(_tempRoot, "pack");
		PortableRuntime.EnableForTests(exeDir);

		Assert.True(AppPaths.IsPortable);
		Assert.Equal(Path.Combine(exeDir, "data"), AppPaths.AppDataRoot);
		Assert.Equal(AppPaths.AppDataRoot, AppPaths.DefaultDataDir);
		Assert.Equal(Path.Combine(exeDir, "data", "logs"), AppPaths.LogsDirectory);
		Assert.Equal(Path.Combine(exeDir, "data", "webview2"), AppPaths.WebView2UserDataDirectory);
		Assert.Equal(Path.Combine(exeDir, "data", "webview2-print"), AppPaths.WebView2PrintUserDataDirectory);
		Assert.Equal(Path.Combine(exeDir, "data", "temp"), AppPaths.TempDirectory);
		Assert.True(Directory.Exists(AppPaths.DefaultDataDir));
		Assert.False(AppPaths.GetConfigPath(AppPaths.DefaultDataDir).Contains(Path.Combine("data", "data"), StringComparison.OrdinalIgnoreCase));
	}

	/// <summary>
	/// ポータブルを戻すと、設定は LocalAppData 配下、一時領域はシステムの一時ディレクトリを向く
	/// </summary>
	[Fact]
	public void AppPaths_without_portable_keeps_appdata_layout()
	{
		PortableRuntime.ResetForTests();

		Assert.False(AppPaths.IsPortable);
		Assert.Contains("tms-mdeditor", AppPaths.AppDataRoot, StringComparison.OrdinalIgnoreCase);
		Assert.Equal(Path.Combine(AppPaths.AppDataRoot, "data"), AppPaths.DefaultDataDir);
		Assert.NotEqual(AppPaths.AppDataRoot, AppPaths.DefaultDataDir);
		Assert.Contains(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppPaths.WebView2UserDataDirectory, StringComparison.OrdinalIgnoreCase);
		Assert.Equal(Path.GetTempPath(), AppPaths.TempDirectory);
	}
}
