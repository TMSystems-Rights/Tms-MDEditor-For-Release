using System.Diagnostics;
using TmsMdEditor.PortableLauncher;

namespace TmsMdEditor.Tests;

public sealed class LaunchArgumentsTests : IDisposable
{
	private readonly string _directory = Path.Combine(Path.GetTempPath(), $"TmsMdEditorLaunchArguments-{Guid.NewGuid():N}");

	public LaunchArgumentsTests() => Directory.CreateDirectory(_directory);

	[Fact]
	public void DisplayName_is_portable_product_label()
	{
		Assert.Equal("TMS-MDEditor.portable", LaunchArguments.DisplayName);
	}

	[Fact]
	public void Portable_stub_version_resource_uses_portable_display_name()
	{
		string exePath = Path.Combine(System.AppContext.BaseDirectory, "TmsMdEditor.Portable.exe");
		Assert.True(File.Exists(exePath), $"起動用 exe が見つかりません: {exePath}");

		FileVersionInfo info = FileVersionInfo.GetVersionInfo(exePath);
		Assert.Equal(LaunchArguments.DisplayName, info.FileDescription);
		Assert.Equal(LaunchArguments.DisplayName, info.ProductName);
	}

	[Fact]
	public void Main_app_version_resource_uses_installer_display_name()
	{
		string exePath = Path.Combine(System.AppContext.BaseDirectory, "TmsMdEditor.exe");
		Assert.True(File.Exists(exePath), $"本体 exe が見つかりません: {exePath}");

		FileVersionInfo info = FileVersionInfo.GetVersionInfo(exePath);
		Assert.Equal("TMS-MDEditor", info.FileDescription);
		Assert.Equal("TMS-MDEditor", info.ProductName);
	}

	[Fact]
	public void Normalize_converts_existing_file_to_full_path()
	{
		string markdownPath = Path.Combine(_directory, "開く対象.md");
		File.WriteAllText(markdownPath, "本文");

		IReadOnlyList<string> forwarded = LaunchArguments.Normalize([markdownPath, "--force-new-window"]);

		Assert.Equal([Path.GetFullPath(markdownPath), "--force-new-window"], forwarded);
	}

	[Fact]
	public void Normalize_keeps_missing_path_and_strips_quotes_on_existing_file()
	{
		string markdownPath = Path.Combine(_directory, "quoted.md");
		File.WriteAllText(markdownPath, "本文");

		IReadOnlyList<string> forwarded = LaunchArguments.Normalize(["\"" + markdownPath + "\"", "missing-file.md"]);

		Assert.Equal([Path.GetFullPath(markdownPath), "missing-file.md"], forwarded);
	}

	[Fact]
	public void Normalize_returns_empty_when_no_args()
	{
		Assert.Empty(LaunchArguments.Normalize([]));
	}

	public void Dispose()
	{
		if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
	}
}

