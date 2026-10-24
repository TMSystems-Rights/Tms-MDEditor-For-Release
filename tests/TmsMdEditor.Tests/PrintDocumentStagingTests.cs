// ==============================================
// PDF と印刷の一時文書
// ==============================================

// 画像のコピー、不正な名前の拒否、失敗時にフォルダが残らないことを固定する

using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリへ印刷用文書を作り、Dispose で親ごと消す
/// </summary>
public class PrintDocumentStagingTests : IDisposable
{
	/// <summary>
	/// テストが作る親ディレクトリ。中の印刷フォルダもまとめて消す
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// 空の親ディレクトリを作る
	/// </summary>
	public PrintDocumentStagingTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-print-test-{Guid.NewGuid():N}");
		Directory.CreateDirectory(_tempRoot);
	}

	/// <summary>
	/// 親ディレクトリが残っていれば中身ごと消す
	/// </summary>
	public void Dispose()
	{
		if (Directory.Exists(_tempRoot))
		{
			Directory.Delete(_tempRoot, recursive: true);
		}
	}

	/// <summary>
	/// HTML と PNG を一時フォルダへ書き、media の中身がコピー元と一致する
	/// </summary>
	[Fact]
	public void Create_writes_html_and_copies_image()
	{
		string source = Path.Combine(_tempRoot, "図.png");
		byte[] bytes = [0x89, 0x50, 0x4E, 0x47];
		File.WriteAllBytes(source, bytes);

		string directory = PrintDocumentStaging.Create(_tempRoot, "<p>本文</p>",
		[
			new PrintMediaFile
			{
				Name       = "1.png",
				SourcePath = source,
			},
		]);

		Assert.Equal("<p>本文</p>", File.ReadAllText(Path.Combine(directory, "document.html")));
		Assert.Equal(bytes, File.ReadAllBytes(Path.Combine(directory, "media", "1.png")));
	}

	/// <summary>
	/// ディレクトリを含む名前はコピーせず、作ったフォルダも残さない
	/// </summary>
	[Fact]
	public void Create_rejects_parent_segment_and_removes_directory()
	{
		string source = Path.Combine(_tempRoot, "a.png");
		File.WriteAllBytes(source, [0x89, 0x50, 0x4E, 0x47]);
		int before = Directory.GetDirectories(_tempRoot).Length;

		InvalidOperationException ex = Assert.Throws<InvalidOperationException>(() =>
			PrintDocumentStaging.Create(_tempRoot, "<p></p>",
			[
				new PrintMediaFile
				{
					Name       = "..\\secret.png",
					SourcePath = source,
				},
			]));

		Assert.Equal("印刷用の画像名が不正です。", ex.Message);
		Assert.Equal(before, Directory.GetDirectories(_tempRoot).Length);
	}

	/// <summary>
	/// 拡張子がコピー元と違う名前は拒否する
	/// </summary>
	[Fact]
	public void Create_rejects_extension_mismatch()
	{
		string source = Path.Combine(_tempRoot, "a.png");
		File.WriteAllBytes(source, [0x89, 0x50, 0x4E, 0x47]);

		InvalidOperationException ex = Assert.Throws<InvalidOperationException>(() =>
			PrintDocumentStaging.Create(_tempRoot, "<p></p>",
			[
				new PrintMediaFile
				{
					Name       = "1.jpg",
					SourcePath = source,
				},
			]));

		Assert.Equal("未対応の画像形式です。", ex.Message);
	}
}
