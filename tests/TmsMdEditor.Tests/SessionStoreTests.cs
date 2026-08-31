using System.Text.Json;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class SessionStoreTests : IDisposable
{
	private readonly string _tempRoot;
	private readonly ConfigStore _configStore;
	private readonly SessionStore _sessionStore;

	public SessionStoreTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-session-test-{Guid.NewGuid():N}");
		AppPaths.SetOverrideAppDataRoot(_tempRoot);
		var logger = new Logger();
		var bootstrapConfigStore = new BootstrapConfigStore(logger);
		_configStore  = new ConfigStore(logger, bootstrapConfigStore);
		_sessionStore = new SessionStore(logger, _configStore);
		_configStore.Load();
	}

	public void Dispose()
	{
		AppPaths.SetOverrideAppDataRoot(null);
		if (Directory.Exists(_tempRoot)) Directory.Delete(_tempRoot, recursive: true);
	}

	[Fact]
	public void Save_and_load_round_trips_session_in_data_dir()
	{
		using JsonDocument document = JsonDocument.Parse("""{"schemaVersion":1,"tabs":[{"tabId":"tab-1","filePath":"C:\\docs\\one.md"}]}""");

		SessionSaveResult save = _sessionStore.Save(document.RootElement);
		SessionLoadResult load = _sessionStore.Load();

		Assert.True(save.Success, save.Message);
		Assert.True(load.Success, load.Message);
		Assert.Equal("tab-1", load.Session?.GetProperty("tabs")[0].GetProperty("tabId").GetString());
		Assert.True(File.Exists(AppPaths.GetSessionPath(AppPaths.DefaultDataDir)));
	}

	[Fact]
	public void Save_rejects_unknown_schema_version()
	{
		using JsonDocument document = JsonDocument.Parse("""{"schemaVersion":99}""");

		SessionSaveResult result = _sessionStore.Save(document.RootElement);

		Assert.False(result.Success);
		Assert.False(File.Exists(AppPaths.GetSessionPath(AppPaths.DefaultDataDir)));
	}

	[Fact]
	public void Load_ignores_corrupt_session_without_replacing_it()
	{
		string sessionPath = AppPaths.GetSessionPath(AppPaths.DefaultDataDir);
		File.WriteAllText(sessionPath, "{broken");

		SessionLoadResult result = _sessionStore.Load();

		Assert.False(result.Success);
		Assert.Null(result.Session);
		Assert.Equal("{broken", File.ReadAllText(sessionPath));
	}
}
