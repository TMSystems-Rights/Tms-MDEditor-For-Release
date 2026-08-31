using System.Drawing;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class StartupArgumentsTests : IDisposable
{
	private readonly string _directory = Path.Combine(Path.GetTempPath(), $"TmsMdEditorStartupArguments-{Guid.NewGuid():N}");

	public StartupArgumentsTests() => Directory.CreateDirectory(_directory);

	[Fact]
	public void ResolveFilePaths_excludes_detach_transfer_file_and_options()
	{
		string markdownPath = Path.Combine(_directory, "表示対象.md");
		string transferPath = Path.Combine(_directory, "transfer.json");
		File.WriteAllText(markdownPath, "本文");
		File.WriteAllText(transferPath, "{}");

		string[] paths = StartupArguments.ResolveFilePaths(["--force-new-window", "--detached-tab", transferPath, "--window-x", "123", "--window-y", "456", markdownPath]);

		Assert.Equal([Path.GetFullPath(markdownPath)], paths);
		Assert.True(StartupArguments.IsForceNewWindow(["--FORCE-NEW-WINDOW"]));
		Assert.Equal(transferPath, StartupArguments.GetDetachedTabPath(["--detached-tab", transferPath]));
		Assert.Equal(new Point(123, 456), StartupArguments.GetDetachedWindowPoint(["--window-x", "123", "--window-y", "456"]));
	}

	public void Dispose()
	{
		if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
	}
}
