// ==============================================
// 貼り付け画像の保存先解決を固定する
// ==============================================

// 未指定はピクチャ配下の既定フォルダにし、相対パスは拒否し、環境変数と UNC は絶対パスへ解決する

using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 保存先パスの解決だけを見る。ディレクトリの作成や画像の書き込みはしない
/// </summary>
public class AttachmentFolderTests
{
	/// <summary>
	/// 既定の保存先はピクチャ配下の TMS-MDEditor\Screenshots で、絶対パスである
	/// </summary>
	[Fact]
	public void GetDefaultFolder_uses_pictures_and_product_name()
	{
		string folder = AttachmentFolder.GetDefaultFolder();

		Assert.Contains(Path.DirectorySeparatorChar + "TMS-MDEditor" + Path.DirectorySeparatorChar, folder, StringComparison.Ordinal);
		Assert.EndsWith(Path.DirectorySeparatorChar + "Screenshots", folder, StringComparison.Ordinal);
		Assert.True(Path.IsPathFullyQualified(folder));
	}

	/// <summary>
	/// 空白だけの指定はエラーにせず、既定の保存先へ解決する
	/// </summary>
	[Fact]
	public void TryResolve_empty_uses_default()
	{
		Assert.True(AttachmentFolder.TryResolve("  ", out string folder, out string? error));
		Assert.Null(error);
		Assert.Equal(AttachmentFolder.GetDefaultFolder(), folder);
	}

	/// <summary>
	/// 相対パスは空の保存先と、絶対パスを求めるエラーにする
	/// </summary>
	[Fact]
	public void TryResolve_rejects_relative_path()
	{
		Assert.False(AttachmentFolder.TryResolve("attachments", out string folder, out string? error));
		Assert.Equal(string.Empty, folder);
		Assert.Equal("貼り付け画像の保存先は絶対パスで指定してください。", error);
	}

	/// <summary>
	/// ローカルの絶対パスと UNC は、エラーなしで絶対パスのまま受け入れる
	/// </summary>
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

	/// <summary>
	/// 環境変数を含む指定は展開し、% が残らない絶対パスにする
	/// </summary>
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
