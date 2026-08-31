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
}
