using System.Text.Json;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class NoteViewPositionStoreTests : IDisposable
{
	private readonly string _tempRoot;
	private readonly ConfigStore _configStore;
	private readonly NoteViewPositionStore _store;

	public NoteViewPositionStoreTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-viewpos-test-{Guid.NewGuid():N}");
		AppPaths.SetOverrideAppDataRoot(_tempRoot);
		var logger = new Logger();
		var bootstrapConfigStore = new BootstrapConfigStore(logger);
		_configStore = new ConfigStore(logger, bootstrapConfigStore);
		_store       = new NoteViewPositionStore(logger, _configStore);
		_configStore.Load();
	}

	public void Dispose()
	{
		AppPaths.SetOverrideAppDataRoot(null);
		if (Directory.Exists(_tempRoot)) Directory.Delete(_tempRoot, recursive: true);
	}

	[Fact]
	public void Save_and_load_round_trips_note_view_positions()
	{
		using JsonDocument document = JsonDocument.Parse("""
			{
			  "schemaVersion": 1,
			  "entries": [
			    {
			      "filePath": "C:\\docs\\one.md",
			      "anchor": 120,
			      "yMargin": -8.5,
			      "scrollLeft": 4,
			      "selectionAnchor": 140,
			      "selectionHead": 150,
			      "updatedAt": "2026-10-04T01:00:00.000Z"
			    }
			  ]
			}
			""");

		NoteViewPositionSaveResult save = _store.Save(document.RootElement);
		NoteViewPositionLoadResult load = _store.Load();

		Assert.True(save.Success, save.Message);
		Assert.True(load.Success);
		JsonElement entry = load.Document.GetProperty("entries")[0];
		Assert.Equal(120, entry.GetProperty("anchor").GetInt32());
		Assert.Equal(-8.5, entry.GetProperty("yMargin").GetDouble());
		Assert.Equal("C:\\docs\\one.md", entry.GetProperty("filePath").GetString());
	}

	[Fact]
	public void Save_keeps_newer_existing_entry_and_adds_new_path()
	{
		Save("""
			{
			  "schemaVersion": 1,
			  "entries": [
			    {
			      "filePath": "C:\\docs\\a.md",
			      "anchor": 3,
			      "yMargin": 0,
			      "scrollLeft": 0,
			      "selectionAnchor": 3,
			      "selectionHead": 3,
			      "updatedAt": "2026-10-04T03:00:00.000Z"
			    }
			  ]
			}
			""");

		NoteViewPositionSaveResult save = Save("""
			{
			  "schemaVersion": 1,
			  "entries": [
			    {
			      "filePath": "c:/docs/a.md",
			      "anchor": 1,
			      "yMargin": 0,
			      "scrollLeft": 0,
			      "selectionAnchor": 1,
			      "selectionHead": 1,
			      "updatedAt": "2026-10-04T01:00:00.000Z"
			    },
			    {
			      "filePath": "C:\\docs\\b.md",
			      "anchor": 4,
			      "yMargin": 0,
			      "scrollLeft": 0,
			      "selectionAnchor": 4,
			      "selectionHead": 4,
			      "updatedAt": "2026-10-04T04:00:00.000Z"
			    }
			  ]
			}
			""");

		NoteViewPositionLoadResult load = _store.Load();
		Assert.True(save.Success, save.Message);
		JsonElement entries = load.Document.GetProperty("entries");
		Assert.Equal(2, entries.GetArrayLength());
		Assert.Equal("C:\\docs\\b.md", entries[0].GetProperty("filePath").GetString());
		Assert.Equal(3, entries[1].GetProperty("anchor").GetInt32());
	}

	[Fact]
	public void Save_drops_entries_beyond_the_limit()
	{
		List<string> entries = [];
		for (int index = 0; index < NoteViewPositionStore.MaxEntries + 1; index++)
		{
			string updatedAt = DateTimeOffset.Parse("2026-10-04T00:00:00Z").AddSeconds(index).ToString("o");
			entries.Add($$"""
				{
				  "filePath": "C:\\docs\\{{index}}.md",
				  "anchor": {{index}},
				  "yMargin": 0,
				  "scrollLeft": 0,
				  "selectionAnchor": 0,
				  "selectionHead": 0,
				  "updatedAt": "{{updatedAt}}"
				}
				""");
		}

		NoteViewPositionSaveResult save = Save($$"""{"schemaVersion":1,"entries":[{{string.Join(',', entries)}}]}""");
		NoteViewPositionLoadResult load = _store.Load();

		Assert.True(save.Success, save.Message);
		JsonElement stored = load.Document.GetProperty("entries");
		Assert.Equal(NoteViewPositionStore.MaxEntries, stored.GetArrayLength());
		Assert.Equal(NoteViewPositionStore.MaxEntries, stored[0].GetProperty("anchor").GetInt32());
		Assert.All(stored.EnumerateArray(), entry => Assert.NotEqual(0, entry.GetProperty("anchor").GetInt32()));
	}

	[Fact]
	public void Save_rejects_unknown_schema_version()
	{
		using JsonDocument document = JsonDocument.Parse("""{"schemaVersion":99,"entries":[]}""");

		NoteViewPositionSaveResult result = _store.Save(document.RootElement);

		Assert.False(result.Success);
		Assert.False(File.Exists(AppPaths.GetNoteViewPositionsPath(AppPaths.DefaultDataDir)));
	}

	[Fact]
	public void Load_ignores_corrupt_file_without_replacing_it()
	{
		string path = AppPaths.GetNoteViewPositionsPath(AppPaths.DefaultDataDir);
		File.WriteAllText(path, "{broken");

		NoteViewPositionLoadResult result = _store.Load();

		Assert.False(result.Success);
		Assert.Equal(0, result.Document.GetProperty("entries").GetArrayLength());
		Assert.Equal("{broken", File.ReadAllText(path));
	}

	private NoteViewPositionSaveResult Save(string json)
	{
		using JsonDocument document = JsonDocument.Parse(json);
		return _store.Save(document.RootElement);
	}
}
