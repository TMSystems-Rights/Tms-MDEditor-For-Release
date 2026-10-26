// ==============================================
// CSS スニペット一覧の読込
// ==============================================

// data ディレクトリの snippets にある css だけを一覧にし、有効指定と大文字小文字を無視した順序を固定する

using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリを AppData の代わりにして、スニペット一覧を検証する
/// 設定が指す data ディレクトリが無いときはフォルダを作り直さない
/// </summary>
public class CssSnippetServiceTests : IDisposable
{
	/// <summary>
	/// スニペットと設定を置く一時ルート。テストごとに作り、Dispose で削除する
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// 有効なスニペット名を保持する実設定ストア。コンストラクタで初期ファイルを作る
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// 検証対象。設定ストアが指す snippets ディレクトリを読む
	/// </summary>
	private readonly CssSnippetService _service;

	/// <summary>
	/// AppData を一時ディレクトリへ差し替え、設定を初期化してからスニペットを読める状態にする
	/// </summary>
	public CssSnippetServiceTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-snippets-test-{Guid.NewGuid():N}");
		AppPaths.SetOverrideAppDataRoot(_tempRoot);

		// 設定とスニペットサービスの両方へ渡すログ。ファイルへは書かない
		var logger = new Logger();
		_configStore = new ConfigStore(logger, new BootstrapConfigStore(logger));
		_configStore.Load();
		_service = new CssSnippetService(_configStore, logger);
	}

	/// <summary>
	/// AppData の差し替えを戻し、一時ディレクトリが残っていれば削除する
	/// </summary>
	public void Dispose()
	{
		AppPaths.SetOverrideAppDataRoot(null);

		// 一時ディレクトリが残っているときだけ削除する。無いときは何もしない
		if (Directory.Exists(_tempRoot))
		{
			Directory.Delete(_tempRoot, recursive: true);
		}
	}

	/// <summary>
	/// snippets 内の css だけを一覧にし、設定で有効なファイルは有効と中身を返す
	/// </summary>
	[Fact]
	public void List_reads_css_files_and_marks_enabled_entries()
	{
		// 一覧が返す snippets の実ディレクトリ。css と txt をここに置く
		string snippetsDirectory = _service.GetDirectoryPath();
		File.WriteAllText(Path.Combine(snippetsDirectory, "sample.css"), ":root { --sample: red; }");
		File.WriteAllText(Path.Combine(snippetsDirectory, "other.txt"), "ignored");

		// 有効リストへ sample.css だけを入れた保存結果。失敗すると Success が false
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"cssSnippets":{"enabled":["sample.css"]}}""").RootElement);
		Assert.True(update.Success, update.Message);

		// css だけを含む一覧。txt は載らない
		CssSnippetsResponse response = _service.List();

		// 一覧の唯一の要素。有効で、中身があり、Error は null
		CssSnippetInfo snippet = Assert.Single(response.Snippets);
		Assert.Equal("sample.css", snippet.Name);
		Assert.True(snippet.Enabled);
		Assert.Contains("--sample: red", snippet.CssText);
		Assert.Null(snippet.Error);
	}

	/// <summary>
	/// ファイル名を、大文字小文字を区別せず昇順に並べる
	/// </summary>
	[Fact]
	public void List_orders_names_case_insensitively()
	{
		// 大文字小文字が混ざる css を置くディレクトリ
		string snippetsDirectory = _service.GetDirectoryPath();
		File.WriteAllText(Path.Combine(snippetsDirectory, "z.css"), "z {}");
		File.WriteAllText(Path.Combine(snippetsDirectory, "A.css"), "a {}");

		// 名前順を見る一覧。有効指定はしていない
		CssSnippetsResponse response = _service.List();

		Assert.Equal(["A.css", "z.css"], response.Snippets.Select(item => item.Name));
	}

	/// <summary>
	/// 設定の data ディレクトリが無いときは一覧を空にし、スニペットフォルダを作り直さない
	/// </summary>
	[Fact]
	public void List_does_not_recreate_snippets_directory_when_custom_data_directory_was_renamed()
	{
		// 設定の保存先にする、まだ無い data ディレクトリ
		string customDataDir = Path.Combine(_tempRoot, "custom-data");
		Assert.True(_configStore.MigrateDataDir(customDataDir).Success);
		Directory.Move(customDataDir, Path.Combine(_tempRoot, "custom-data-renamed"));

		// 移動後に読む一覧。フォルダが無いので空で、Error に理由がある
		CssSnippetsResponse response = _service.List();

		Assert.Empty(response.Snippets);
		Assert.Contains("CSSスニペットフォルダが見つかりません", response.Error);
		Assert.False(Directory.Exists(AppPaths.GetSnippetsDirectory(customDataDir)));
	}
}
