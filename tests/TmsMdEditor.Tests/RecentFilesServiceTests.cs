// ==============================================
// 最近使ったファイルの件数と順序を固定する
// ==============================================

// 最近使ったファイルは先頭へ追加し、15件を超えた分は古いものから落とし、同じパスは重複させない

using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリを AppData の代わりにして、最近使ったファイルの保存を検証する
/// 差し替えは各テストの終了時に戻す
/// </summary>
public class RecentFilesServiceTests : IDisposable
{
	/// <summary>
	/// 設定ファイルを置く一時ルート。テストごとに作り、Dispose で削除する
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// 設定ストアへ渡す実ロガー。ログの文面は検証しない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// data ディレクトリの指示を読む実ストア
	/// </summary>
	private readonly BootstrapConfigStore _bootstrapConfigStore;

	/// <summary>
	/// 最近使ったファイルの保存先になる実設定ストア。コンストラクタで初期ファイルを作る
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// 検証対象。設定の読み書きは渡した設定ストアへ委譲する
	/// </summary>
	private readonly RecentFilesService _recentFilesService;

	/// <summary>
	/// AppData を一時ディレクトリへ差し替え、空の設定を作ってから最近使ったファイルを操作できる状態にする
	/// </summary>
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
	/// 16件追加すると15件に収まり、最後に追加したパスが先頭で、最初のパスは落ちる
	/// </summary>
	[Fact]
	public void Add_prepends_path_and_limits_to_15_items()
	{
		// 空の最近使ったファイルから始める設定。16件追加して15件に収まることを見る
		AppConfigDocument config = _configStore.Load().Config;

		for (int index = 0; index < 16; index += 1)
		{
			// 1件追加した保存結果。失敗すると Success が false で、以降の config は更新前のまま
			SaveConfigResult result = _recentFilesService.Add(_configStore, config, $"C:\\files\\file-{index}.md");
			Assert.True(result.Success, result.Message);
			config = result.Config ?? config;
		}

		Assert.Equal(RecentFilesService.MaxRecentFiles, config.RecentFiles.Count);
		Assert.Equal("C:\\files\\file-15.md", config.RecentFiles[0]);
		Assert.DoesNotContain("C:\\files\\file-0.md", config.RecentFiles);
	}

	/// <summary>
	/// 既にあるパスを再度追加すると、件数は増やさず先頭へ移す
	/// </summary>
	[Fact]
	public void Add_moves_existing_path_to_front()
	{
		// まだパスが無い設定
		AppConfigDocument config = _configStore.Load().Config;

		// 先に追加する older.md。あとから先頭へ戻す
		SaveConfigResult addOlder = _recentFilesService.Add(_configStore, config, "C:\\files\\older.md");
		Assert.True(addOlder.Success, addOlder.Message);
		config = addOlder.Config ?? config;

		// older の次に追加する newer.md。再追加のあと2番目になる
		SaveConfigResult addNewer = _recentFilesService.Add(_configStore, config, "C:\\files\\newer.md");
		Assert.True(addNewer.Success, addNewer.Message);
		config = addNewer.Config ?? config;

		// 既存の older を再度追加した保存結果。件数は2のまま先頭が older
		SaveConfigResult reopenOlder = _recentFilesService.Add(_configStore, config, "C:\\files\\older.md");
		Assert.True(reopenOlder.Success, reopenOlder.Message);

		Assert.Equal(2, reopenOlder.Config?.RecentFiles.Count);
		Assert.Equal("C:\\files\\older.md", reopenOlder.Config?.RecentFiles[0]);
		Assert.Equal("C:\\files\\newer.md", reopenOlder.Config?.RecentFiles[1]);
	}

	/// <summary>
	/// 指定したパスだけを最近使ったファイルから消し、残ったパスの順は維持する
	/// </summary>
	[Fact]
	public void Remove_deletes_path_from_recent_files()
	{
		// 削除前の設定。keep と remove をこの順で足す
		AppConfigDocument config = _configStore.Load().Config;

		// 残す keep.md を追加した保存結果
		SaveConfigResult addKeep = _recentFilesService.Add(_configStore, config, "C:\\files\\keep.md");
		Assert.True(addKeep.Success, addKeep.Message);
		config = addKeep.Config ?? config;

		// 消す remove.md を追加した保存結果。先頭は remove になる
		SaveConfigResult addRemove = _recentFilesService.Add(_configStore, config, "C:\\files\\remove.md");
		Assert.True(addRemove.Success, addRemove.Message);
		config = addRemove.Config ?? config;

		// remove.md だけを消した保存結果。残るのは keep
		SaveConfigResult result = _recentFilesService.Remove(_configStore, config, "C:\\files\\remove.md");

		Assert.True(result.Success, result.Message);
		Assert.Single(result.Config?.RecentFiles ?? []);
		Assert.Equal("C:\\files\\keep.md", result.Config?.RecentFiles[0]);
	}
}
