using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class PortableConfigStoreTests : IDisposable
{
	private readonly string _exeDir;
	private readonly Logger _logger;
	private readonly BootstrapConfigStore _bootstrapConfigStore;
	private readonly ConfigStore _configStore;

	public PortableConfigStoreTests()
	{
		PortableRuntime.ResetForTests();
		_exeDir = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-portable-cfg-{Guid.NewGuid():N}");
		PortableRuntime.EnableForTests(_exeDir);
		_logger = new Logger();
		_bootstrapConfigStore = new BootstrapConfigStore(_logger);
		_configStore = new ConfigStore(_logger, _bootstrapConfigStore);
	}

	public void Dispose()
	{
		PortableRuntime.ResetForTests();
		if (Directory.Exists(_exeDir))
		{
			Directory.Delete(_exeDir, recursive: true);
		}
	}

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
