using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class RecentFilesServiceTests : IDisposable
{
	private readonly string _tempRoot;
	private readonly Logger _logger;
	private readonly BootstrapConfigStore _bootstrapConfigStore;
	private readonly ConfigStore _configStore;
	private readonly RecentFilesService _recentFilesService;

	public RecentFilesServiceTests()
	{
		_tempRoot             = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-recent-test-{Guid.NewGuid():N}");
		_logger               = new Logger();
		_bootstrapConfigStore = new BootstrapConfigStore(_logger);
		_configStore          = new ConfigStore(_logger, _bootstrapConfigStore);
		_recentFilesService   = new RecentFilesService();
		AppPaths.SetOverrideAppDataRoot(_tempRoot);
		_configStore.Load();
	}

	public void Dispose()
	{
		AppPaths.SetOverrideAppDataRoot(null);

		if (Directory.Exists(_tempRoot))
		{
			Directory.Delete(_tempRoot, recursive: true);
		}
	}

	[Fact]
	public void Add_prepends_path_and_limits_to_15_items()
	{
		AppConfigDocument config = _configStore.Load().Config;

		for (int index = 0; index < 16; index += 1)
		{
			SaveConfigResult result = _recentFilesService.Add(_configStore, config, $"C:\\files\\file-{index}.md");
			Assert.True(result.Success, result.Message);
			config = result.Config ?? config;
		}

		Assert.Equal(RecentFilesService.MaxRecentFiles, config.RecentFiles.Count);
		Assert.Equal("C:\\files\\file-15.md", config.RecentFiles[0]);
		Assert.DoesNotContain("C:\\files\\file-0.md", config.RecentFiles);
	}

	[Fact]
	public void Add_moves_existing_path_to_front()
	{
		AppConfigDocument config = _configStore.Load().Config;

		SaveConfigResult addOlder = _recentFilesService.Add(_configStore, config, "C:\\files\\older.md");
		Assert.True(addOlder.Success, addOlder.Message);
		config = addOlder.Config ?? config;

		SaveConfigResult addNewer = _recentFilesService.Add(_configStore, config, "C:\\files\\newer.md");
		Assert.True(addNewer.Success, addNewer.Message);
		config = addNewer.Config ?? config;

		SaveConfigResult reopenOlder = _recentFilesService.Add(_configStore, config, "C:\\files\\older.md");
		Assert.True(reopenOlder.Success, reopenOlder.Message);

		Assert.Equal(2, reopenOlder.Config?.RecentFiles.Count);
		Assert.Equal("C:\\files\\older.md", reopenOlder.Config?.RecentFiles[0]);
		Assert.Equal("C:\\files\\newer.md", reopenOlder.Config?.RecentFiles[1]);
	}

	[Fact]
	public void Remove_deletes_path_from_recent_files()
	{
		AppConfigDocument config = _configStore.Load().Config;

		SaveConfigResult addKeep = _recentFilesService.Add(_configStore, config, "C:\\files\\keep.md");
		Assert.True(addKeep.Success, addKeep.Message);
		config = addKeep.Config ?? config;

		SaveConfigResult addRemove = _recentFilesService.Add(_configStore, config, "C:\\files\\remove.md");
		Assert.True(addRemove.Success, addRemove.Message);
		config = addRemove.Config ?? config;

		SaveConfigResult result = _recentFilesService.Remove(_configStore, config, "C:\\files\\remove.md");

		Assert.True(result.Success, result.Message);
		Assert.Single(result.Config?.RecentFiles ?? []);
		Assert.Equal("C:\\files\\keep.md", result.Config?.RecentFiles[0]);
	}
}
