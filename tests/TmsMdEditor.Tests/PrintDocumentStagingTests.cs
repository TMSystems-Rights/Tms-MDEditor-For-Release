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
		// 親ディレクトリが残っているときだけ中身ごと消す。無いときは何もしない
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
		// コピー元の PNG。中身はシグネチャだけで、画像としては読まない
		string source = Path.Combine(_tempRoot, "図.png");
		// コピー元へ書く4バイト。media へ同じ並びが残ることを見る
		byte[] bytes = [0x89, 0x50, 0x4E, 0x47];
		File.WriteAllBytes(source, bytes);

		// 親の下に作った印刷フォルダ。HTML と media を置く
		string directory = PrintDocumentStaging.Create(_tempRoot, "<p>本文</p>",
		[
			// 印刷フォルダの media へコピーする1件。名前とコピー元の両方が必要
			new PrintMediaFile
			{
				// media 内のファイル名。親セグメントは含まない
				Name       = "1.png",
				// コピー元の絶対パス。空だとコピーできない
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
		// 不正な名前でもコピー元としては実在する PNG
		string source = Path.Combine(_tempRoot, "a.png");
		File.WriteAllBytes(source, [0x89, 0x50, 0x4E, 0x47]);
		// 呼び出し前の子ディレクトリ数。失敗後もこの数のまま残る。0 は親が空
		int before = Directory.GetDirectories(_tempRoot).Length;

		// 親セグメントを拒否した例外。メッセージで理由を見る
		InvalidOperationException ex = Assert.Throws<InvalidOperationException>(() =>
			PrintDocumentStaging.Create(_tempRoot, "<p></p>",
			[
				// 親セグメントを含むため拒否する画像。コピーは走らない
				new PrintMediaFile
				{
					// ディレクトリを含む名前。この形は不正
					Name       = "..\\secret.png",
					// 実在するコピー元。名前が不正なため読まれない
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
		// 拡張子の比較に使う実在の PNG
		string source = Path.Combine(_tempRoot, "a.png");
		File.WriteAllBytes(source, [0x89, 0x50, 0x4E, 0x47]);

		// 拡張子不一致を拒否した例外。メッセージで理由を見る
		InvalidOperationException ex = Assert.Throws<InvalidOperationException>(() =>
			PrintDocumentStaging.Create(_tempRoot, "<p></p>",
			[
				// コピー元と拡張子が違うため拒否する画像
				new PrintMediaFile
				{
					// jpg を名乗るが、コピー元は png
					Name       = "1.jpg",
					// 拡張子が png のコピー元。名前と一致しない
					SourcePath = source,
				},
			]));

		Assert.Equal("未対応の画像形式です。", ex.Message);
	}
}
