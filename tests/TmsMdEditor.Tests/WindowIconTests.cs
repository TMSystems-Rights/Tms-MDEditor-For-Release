using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class WindowIconTests : IDisposable
{
	private readonly string _tempRoot;

	public WindowIconTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-icon-{Guid.NewGuid():N}");
		Directory.CreateDirectory(_tempRoot);
	}

	public void Dispose()
	{
		if (Directory.Exists(_tempRoot))
		{
			Directory.Delete(_tempRoot, recursive: true);
		}
	}

	[Fact]
	public void Load_reads_icon_file_beside_executable()
	{
		string source = ResolveRepoIconPath();
		Assert.True(File.Exists(source), $"build/icon.ico が見つかりません: {source}");
		string copy = Path.Combine(_tempRoot, WindowIcon.FileName);
		File.Copy(source, copy);

		object? icon = WindowIcon.Load(_tempRoot, executablePath: null);

		Assert.NotNull(icon);
		(icon as IDisposable)?.Dispose();
	}

	[Fact]
	public void Load_returns_null_when_icon_sources_are_missing()
	{
		Assert.Null(WindowIcon.Load(_tempRoot, executablePath: Path.Combine(_tempRoot, "missing.exe")));
	}

	private static string ResolveRepoIconPath()
	{
		string? directory = System.AppContext.BaseDirectory;
		while (!string.IsNullOrWhiteSpace(directory))
		{
			string candidate = Path.Combine(directory, "build", "icon.ico");
			if (File.Exists(candidate))
			{
				return candidate;
			}

			directory = Directory.GetParent(directory)?.FullName;
		}

		return Path.Combine("build", "icon.ico");
	}
}
