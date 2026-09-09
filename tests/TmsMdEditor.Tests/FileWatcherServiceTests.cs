using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class FileWatcherServiceTests
{
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
			Thread.Sleep(1200);
			Assert.Empty(received);
		}
		finally
		{
			if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
		}
	}

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

			Thread.Sleep(1200);
			Assert.Empty(received);
		}
		finally
		{
			if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
		}
	}

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
