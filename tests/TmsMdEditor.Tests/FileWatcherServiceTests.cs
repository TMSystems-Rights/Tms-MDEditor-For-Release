// ==============================================
// 外部変更監視と保存通知の抑止
// ==============================================

// 監視中の削除は削除として通知し、自アプリの保存と抑止中の作り直しは外部変更にしない

using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリの実ファイルを監視する
/// 通知が制限時間内に来ないときは失敗し、ディレクトリは各テストの最後に削除する
/// </summary>
public sealed class FileWatcherServiceTests
{
	/// <summary>
	/// 監視中のファイルを削除すると、そのパスの削除として通知する
	/// </summary>
	[Fact]
	public void Deleted_file_is_reported_as_deleted()
	{
		string directory = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-watch-{Guid.NewGuid():N}");
		Directory.CreateDirectory(directory);
		string filePath = Path.Combine(directory, "sample.md");
		File.WriteAllText(filePath, "before");
		try
		{
			using var watcher = new FileWatcherService(new Logger());
			using var signal = new ManualResetEventSlim();
			ExternalFileChange? received = null;
			watcher.FileChanged += change =>
			{
				received = change;
				signal.Set();
			};
			watcher.Track(filePath);

			File.Delete(filePath);

			Assert.True(signal.Wait(TimeSpan.FromSeconds(5)));
			Assert.NotNull(received);
			Assert.Equal(filePath, received.FilePath, ignoreCase: true);
			Assert.Equal(ExternalFileChangeKind.Deleted, received.Kind);
		}
		finally
		{
			if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
		}
	}

	/// <summary>
	/// 保存の抑止中に上書きしても、削除や変更として通知しない
	/// </summary>
	[Fact]
	public void Save_does_not_report_deleted_for_watched_file()
	{
		string directory = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-watch-{Guid.NewGuid():N}");
		Directory.CreateDirectory(directory);
		string filePath = Path.Combine(directory, "sample.md");
		File.WriteAllText(filePath, "before");
		try
		{
			using var watcher = new FileWatcherService(new Logger());
			var received = new List<ExternalFileChange>();
			watcher.FileChanged += received.Add;
			watcher.Track(filePath);
			watcher.SuppressNextChange(filePath);

			var fileService = new FileService(new Logger());
			SaveFileResult saved = fileService.Save(filePath, "after", TextEncodingKind.Utf8, unifyEol: null);

			Assert.True(saved.Success);
			Assert.Equal("after", File.ReadAllText(filePath));
			// 削除通知の待ちより長く、保存通知の抑止より短い時間だけ待つ
			Thread.Sleep(1200);
			Assert.Empty(received);
		}
		finally
		{
			if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
		}
	}

	/// <summary>
	/// 抑止中の削除と再作成は、通知の待ちが終わっても外部変更にしない
	/// </summary>
	[Fact]
	public void SuppressNextChange_covers_delete_and_recreate_in_window()
	{
		string directory = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-watch-{Guid.NewGuid():N}");
		Directory.CreateDirectory(directory);
		string filePath = Path.Combine(directory, "sample.md");
		File.WriteAllText(filePath, "before");
		try
		{
			using var watcher = new FileWatcherService(new Logger());
			var received = new List<ExternalFileChange>();
			watcher.FileChanged += received.Add;
			watcher.Track(filePath);
			watcher.SuppressNextChange(filePath);

			File.Delete(filePath);
			File.WriteAllText(filePath, "after");

			// 再作成の通知待ちより長く、抑止が終わるより短い時間だけ待つ
			Thread.Sleep(1200);
			Assert.Empty(received);
		}
		finally
		{
			if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
		}
	}

	/// <summary>
	/// 抑止せずに削除してすぐ作り直すと、削除ではなく変更として通知する
	/// </summary>
	[Fact]
	public void Recreated_file_is_reported_as_changed_not_deleted()
	{
		string directory = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-watch-{Guid.NewGuid():N}");
		Directory.CreateDirectory(directory);
		string filePath = Path.Combine(directory, "sample.md");
		File.WriteAllText(filePath, "before");
		try
		{
			using var watcher = new FileWatcherService(new Logger());
			using var signal = new ManualResetEventSlim();
			ExternalFileChange? received = null;
			watcher.FileChanged += change =>
			{
				received = change;
				signal.Set();
			};
			watcher.Track(filePath);

			File.Delete(filePath);
			File.WriteAllText(filePath, "after");

			Assert.True(signal.Wait(TimeSpan.FromSeconds(5)));
			Assert.NotNull(received);
			Assert.Equal(filePath, received.FilePath, ignoreCase: true);
			Assert.Equal(ExternalFileChangeKind.Changed, received.Kind);
		}
		finally
		{
			if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
		}
	}
}
