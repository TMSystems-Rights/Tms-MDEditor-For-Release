// ==============================================
// ポータブル版が別の data へ移るのを拒否する
// ==============================================

// ポータブル版は exe の隣の data を設定の保存先にし、別の data ディレクトリへの移動は拒否する

using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリを exe の位置にして、ポータブル時の設定ストアを検証する
/// プロセスのポータブル状態は各テストの前後で戻す
/// </summary>
public sealed class PortableConfigStoreTests : IDisposable
{
	/// <summary>
	/// ポータブル exe の代わりに使う一時ディレクトリ
	/// 隣の data が設定の保存先になる。コンストラクタで作り、Dispose で削除する
	/// </summary>
	private readonly string _exeDir;

	/// <summary>
	/// 設定ストアへ渡す実ロガー。ログの文面は検証しない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// data ディレクトリの指示を読む実ストア。ポータブル中は exe 隣の data を指す
	/// </summary>
	private readonly BootstrapConfigStore _bootstrapConfigStore;

	/// <summary>
	/// 検証対象の設定ストア。ポータブルを有効にしたあとに作る
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// ポータブル状態を一度戻してから、一時ディレクトリを exe の位置として有効にする
	/// 設定ファイルはこの時点では作らない
	/// </summary>
	public PortableConfigStoreTests()
	{
		PortableRuntime.ResetForTests();
		_exeDir = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-portable-cfg-{Guid.NewGuid():N}");
		PortableRuntime.EnableForTests(_exeDir);
		_logger = new Logger();
		_bootstrapConfigStore = new BootstrapConfigStore(_logger);
		_configStore = new ConfigStore(_logger, _bootstrapConfigStore);
	}

	/// <summary>
	/// ポータブル状態を戻し、一時ディレクトリが残っていれば削除する
	/// </summary>
	public void Dispose()
	{
		PortableRuntime.ResetForTests();
		if (Directory.Exists(_exeDir))
		{
			Directory.Delete(_exeDir, recursive: true);
		}
	}

	/// <summary>
	/// 初回読込は exe の隣の data を保存先にし、data の中へ data を重ねない
	/// </summary>
	[Fact]
	public void Load_uses_flattened_data_dir_next_to_exe()
	{
		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success, result.Message);
		Assert.Equal(Path.Combine(_exeDir, "data"), AppPaths.DefaultDataDir);
		Assert.Equal(AppPaths.AppDataRoot, AppPaths.DefaultDataDir);
		Assert.True(File.Exists(AppPaths.GetConfigPath(AppPaths.DefaultDataDir)));
		Assert.False(Directory.Exists(Path.Combine(_exeDir, "data", "data")));
		Assert.True(_configStore.GetDataDirInfo().IsPortable);
	}

	/// <summary>
	/// ブートストラップが別の data ディレクトリを指していても、ポータブル中は exe 隣の data を使う
	/// </summary>
	[Fact]
	public void Load_ignores_non_portable_data_dir_in_bootstrap()
	{
		string foreign = Path.Combine(_exeDir, "foreign-data");
		Directory.CreateDirectory(foreign);
		Directory.CreateDirectory(AppPaths.AppDataRoot);
		File.WriteAllText(
			AppPaths.BootstrapConfigPath,
			$$"""
			{"schemaVersion":1,"dataDir":"{{foreign.Replace("\\", "\\\\")}}"}
			""");

		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success, result.Message);
		Assert.Equal(AppPaths.DefaultDataDir, _bootstrapConfigStore.Load().DataDir);
		Assert.True(File.Exists(AppPaths.GetConfigPath(AppPaths.DefaultDataDir)));
		Assert.False(File.Exists(AppPaths.GetConfigPath(foreign)));
	}

	/// <summary>
	/// ポータブル中の data ディレクトリ移動は失敗し、保存先は exe 隣の data のまま残る
	/// </summary>
	[Fact]
	public void MigrateDataDir_is_rejected()
	{
		_configStore.Load();
		MigrateDataDirResult result = _configStore.MigrateDataDir(Path.Combine(_exeDir, "elsewhere"));

		Assert.False(result.Success);
		Assert.Contains("ポータブル版", result.Message);
		Assert.Equal(AppPaths.DefaultDataDir, _bootstrapConfigStore.Load().DataDir);
	}
}
