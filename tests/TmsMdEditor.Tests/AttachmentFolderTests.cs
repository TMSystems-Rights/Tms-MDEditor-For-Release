using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class AttachmentFolderTests
{
	[Fact]
	public void GetDefaultFolder_uses_pictures_and_product_name()
	{
		string folder = AttachmentFolder.GetDefaultFolder();

		Assert.Contains(Path.DirectorySeparatorChar + "TMS-MDEditor" + Path.DirectorySeparatorChar, folder, StringComparison.Ordinal);
		Assert.EndsWith(Path.DirectorySeparatorChar + "Screenshots", folder, StringComparison.Ordinal);
		Assert.True(Path.IsPathFullyQualified(folder));
	}

	[Fact]
	public void TryResolve_empty_uses_default()
	{
		Assert.True(AttachmentFolder.TryResolve("  ", out string folder, out string? error));
		Assert.Null(error);
		Assert.Equal(AttachmentFolder.GetDefaultFolder(), folder);
	}

	[Fact]
	public void TryResolve_rejects_relative_path()
	{
		Assert.False(AttachmentFolder.TryResolve("attachments", out string folder, out string? error));
		Assert.Equal(string.Empty, folder);
		Assert.Equal("貼り付け画像の保存先は絶対パスで指定してください。", error);
	}

	[Fact]
	public void TryResolve_accepts_local_absolute_and_unc()
	{
		string local = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "tms-mdeditor-attach"));
		Assert.True(AttachmentFolder.TryResolve(local, out string resolvedLocal, out string? localError));
		Assert.Null(localError);
		Assert.Equal(local, resolvedLocal);

		Assert.True(AttachmentFolder.TryResolve(@"\\server\share\TMS-MDEditor\Screenshots", out string unc, out string? uncError));
		Assert.Null(uncError);
		Assert.StartsWith(@"\\server\share\", unc, StringComparison.OrdinalIgnoreCase);
	}

	[Fact]
	public void TryResolve_expands_environment_variables()
	{
		string configured = Path.Combine("%TEMP%", "TMS-MDEditor-AttachTest");
		Assert.True(AttachmentFolder.TryResolve(configured, out string folder, out string? error));
		Assert.Null(error);
		Assert.DoesNotContain('%', folder);
		Assert.True(Path.IsPathFullyQualified(folder));
	}
}
