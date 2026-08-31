using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class CssSnippetServiceTests : IDisposable
{
	private readonly string _tempRoot;
	private readonly ConfigStore _configStore;
	private readonly CssSnippetService _service;

	public CssSnippetServiceTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-snippets-test-{Guid.NewGuid():N}");
		AppPaths.SetOverrideAppDataRoot(_tempRoot);

		var logger = new Logger();
		_configStore = new ConfigStore(logger, new BootstrapConfigStore(logger));
		_configStore.Load();
		_service = new CssSnippetService(_configStore, logger);
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
	public void List_reads_css_files_and_marks_enabled_entries()
	{
		string snippetsDirectory = _service.GetDirectoryPath();
		File.WriteAllText(Path.Combine(snippetsDirectory, "sample.css"), ":root { --sample: red; }");
		File.WriteAllText(Path.Combine(snippetsDirectory, "other.txt"), "ignored");

		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"cssSnippets":{"enabled":["sample.css"]}}""").RootElement);
		Assert.True(update.Success, update.Message);

		CssSnippetsResponse response = _service.List();

		CssSnippetInfo snippet = Assert.Single(response.Snippets);
		Assert.Equal("sample.css", snippet.Name);
		Assert.True(snippet.Enabled);
		Assert.Contains("--sample: red", snippet.CssText);
		Assert.Null(snippet.Error);
	}

	[Fact]
	public void List_orders_names_case_insensitively()
	{
		string snippetsDirectory = _service.GetDirectoryPath();
		File.WriteAllText(Path.Combine(snippetsDirectory, "z.css"), "z {}");
		File.WriteAllText(Path.Combine(snippetsDirectory, "A.css"), "a {}");

		CssSnippetsResponse response = _service.List();

		Assert.Equal(["A.css", "z.css"], response.Snippets.Select(item => item.Name));
	}

	[Fact]
	public void List_does_not_recreate_snippets_directory_when_custom_data_directory_was_renamed()
	{
		string customDataDir = Path.Combine(_tempRoot, "custom-data");
		Assert.True(_configStore.MigrateDataDir(customDataDir).Success);
		Directory.Move(customDataDir, Path.Combine(_tempRoot, "custom-data-renamed"));

		CssSnippetsResponse response = _service.List();

		Assert.Empty(response.Snippets);
		Assert.Contains("CSSスニペットフォルダが見つかりません", response.Error);
		Assert.False(Directory.Exists(AppPaths.GetSnippetsDirectory(customDataDir)));
	}
}
