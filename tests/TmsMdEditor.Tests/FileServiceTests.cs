// ==============================================
// テキストと画像ファイルの読み書き
// ==============================================

// 文字コードと改行を保った保存、画像の解決、UTF-8 書き出し、保存後に一時ファイルが残らないことを固定する

using System.Text;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリの実ファイルで読み書きを検証する
/// CP932 用のコードページは各テストの前に登録し、プロセスが終わるまで残る
/// </summary>
public class FileServiceTests : IDisposable
{
	/// <summary>
	/// 読み書きに使う一時ディレクトリ。テストごとに作り、Dispose で削除する
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// 検証対象。ログは実ロガーへ渡し、ログ文面は検証しない
	/// </summary>
	private readonly FileService _fileService;

	/// <summary>
	/// CP932 の往復に必要なコードページを登録し、空の一時ディレクトリを作る
	/// </summary>
	public FileServiceTests()
	{
		Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

		_tempRoot    = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-file-test-{Guid.NewGuid():N}");
		_fileService = new FileService(new Logger());
		Directory.CreateDirectory(_tempRoot);
	}

	/// <summary>
	/// 一時ディレクトリが残っていれば、中身ごと削除する
	/// </summary>
	public void Dispose()
	{
		// 一時ディレクトリが残っているときだけ中身ごと削除する。無いときは何もしない
		if (Directory.Exists(_tempRoot))
		{
			Directory.Delete(_tempRoot, recursive: true);
		}
	}

	/// <summary>
	/// BOM 無し UTF-8 と LF のファイルを、その文字コードと改行、同じ本文で読む
	/// </summary>
	[Fact]
	public void Read_detects_encoding_and_eol()
	{
		// BOM 無し UTF-8 と LF で書く読み込み対象
		string filePath = Path.Combine(_tempRoot, "utf8-lf.md");
		File.WriteAllBytes(filePath, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes("line1\nline2"));

		// 判定した文字コード、改行、本文。ファイルは消さない
		TextFileInfo info = _fileService.Read(filePath);

		Assert.Equal(TextEncodingKind.Utf8, info.Encoding);
		Assert.Equal(EolKind.Lf, info.PrimaryEol);
		Assert.False(info.EolMixed);
		Assert.Equal("line1\nline2", info.Text);
	}

	/// <summary>
	/// BOM 付き UTF-8 で保存すると、BOM が残り、本文は新しい文字列になる
	/// </summary>
	[Fact]
	public void Save_preserves_encoding_and_bom()
	{
		// BOM 付き UTF-8 で上書きする対象
		string filePath = Path.Combine(_tempRoot, "utf8-bom.md");
		// 保存前の BOM 付き before。BOM が残ることを見る基準
		byte[] originalBytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true).GetPreamble()
			.Concat(new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes("before"))
			.ToArray();
		File.WriteAllBytes(filePath, originalBytes);

		// 読み込んだ文字コード。BOM 付き UTF-8 以外なら保存の前提が崩れる
		TextFileInfo opened = _fileService.Read(filePath);
		Assert.Equal(TextEncodingKind.Utf8Bom, opened.Encoding);

		// BOM 付きのまま after にした保存結果。失敗すると Success が false
		SaveFileResult saved = _fileService.Save(filePath, "after", opened.Encoding, unifyEol: null);

		Assert.True(saved.Success);
		// 保存後のファイル全体。BOM と after を含む
		byte[] savedBytes = File.ReadAllBytes(filePath);
		// BOM 付き UTF-8 の after。savedBytes と一致する
		byte[] expectedBytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true).GetBytes("after");
		Assert.Equal(expectedBytes, savedBytes);
	}

	/// <summary>
	/// 混在した改行を CRLF へ統一して保存すると、ファイルも結果も CRLF だけになる
	/// </summary>
	[Fact]
	public void Save_can_unify_mixed_eol_to_crlf()
	{
		// CRLF、LF、CR が混在した保存対象
		string filePath = Path.Combine(_tempRoot, "mixed.md");
		File.WriteAllText(filePath, "a\r\nb\nc\rd", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

		// 混在のまま読んだ本文と文字コード。統一前は EolMixed が true
		TextFileInfo opened = _fileService.Read(filePath);
		Assert.True(opened.EolMixed);

		// 読んだ本文を CRLF へ統一した保存結果。失敗すると Success が false
		SaveFileResult saved = _fileService.Save(filePath, opened.Text, opened.Encoding, EolKind.Crlf);

		Assert.True(saved.Success);
		Assert.False(saved.EolMixed);
		Assert.Equal(EolKind.Crlf, saved.PrimaryEol);
		Assert.Equal("a\r\nb\r\nc\r\nd", File.ReadAllText(filePath, Encoding.UTF8));
	}

	/// <summary>
	/// CP932 の日本語を読むと CP932 になり、同じ文字コードで保存すると同じ文字列に戻る
	/// </summary>
	[Fact]
	public void Read_and_save_roundtrip_cp932()
	{
		// CP932 で往復する対象
		string filePath = Path.Combine(_tempRoot, "cp932.txt");
		// 往復に使う CP932。コンストラクタでコードページを登録済み
		Encoding cp932 = Encoding.GetEncoding(932);
		File.WriteAllBytes(filePath, cp932.GetBytes("日本語\r\nテスト"));

		// 読み込んだ本文と文字コード。CP932 以外なら往復の前提が崩れる
		TextFileInfo opened = _fileService.Read(filePath);
		Assert.Equal(TextEncodingKind.Cp932, opened.Encoding);

		// 同じ文字コードで書き戻した保存結果。失敗すると Success が false
		SaveFileResult saved = _fileService.Save(filePath, opened.Text, opened.Encoding, unifyEol: null);

		Assert.True(saved.Success);
		Assert.Equal(opened.Text, cp932.GetString(File.ReadAllBytes(filePath)));
	}

	/// <summary>
	/// ノートと同じディレクトリの相対パスを、PNG のデータ URL とその絶対パスへ解決する
	/// </summary>
	[Fact]
	public void ReadImageAsDataUrl_resolves_relative_path()
	{
		// 相対パスの基準にするノート。中身は読まない
		string notePath = Path.Combine(_tempRoot, "note.md");
		// ノートと同じディレクトリの PNG。シグネチャだけで画像としては読まない
		string imagePath = Path.Combine(_tempRoot, "pic.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		// 相対パスをデータ URL と絶対パスへ解決した結果。失敗時は Ok が false
		ReadImageResult result = _fileService.ReadImageAsDataUrl("pic.png", notePath, embed: null);

		Assert.True(result.Ok);
		Assert.StartsWith("data:image/png;base64,", result.DataUrl);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	/// <summary>
	/// 相対パスの画像は、バイトを読まず絶対パスだけを返す
	/// </summary>
	[Fact]
	public void ResolveLocalImage_returns_path_without_data_url()
	{
		// 相対パスの基準にするノート。中身は読まない
		string notePath = Path.Combine(_tempRoot, "note.md");
		// バイトを埋め込まずパスだけ返す PNG
		string imagePath = Path.Combine(_tempRoot, "pic.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		// 絶対パスだけの解決結果。DataUrl は null
		ReadImageResult result = _fileService.ResolveLocalImage("pic.png", notePath, embed: null);

		Assert.True(result.Ok);
		Assert.Null(result.DataUrl);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	/// <summary>
	/// サブディレクトリにある埋め込み画像を、ファイル名からその絶対パスへ解決する
	/// </summary>
	[Fact]
	public void ReadImageAsDataUrl_resolves_embed_in_subdirectory()
	{
		// 埋め込みの基準にするノート
		string notePath = Path.Combine(_tempRoot, "note.md");
		// ノートの隣の assets。ファイル名だけでこの中を探す
		string nestedDir = Path.Combine(_tempRoot, "assets");
		Directory.CreateDirectory(nestedDir);
		// assets の中の PNG。ノート直下には置かない
		string imagePath = Path.Combine(nestedDir, "nested.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		// ファイル名だけの埋め込みを絶対パスへ解決した結果。失敗時は Ok が false
		ReadImageResult result = _fileService.ReadImageAsDataUrl(path: null, notePath, embed: "nested.png");

		Assert.True(result.Ok);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	/// <summary>
	/// 埋め込みの幅指定を除いた相対パスを、添付フォルダ内の画像へ解決する
	/// </summary>
	[Fact]
	public void ReadImageAsDataUrl_strips_size_suffix_from_embed()
	{
		// 幅指定を除く前の基準にするノート
		string notePath = Path.Combine(_tempRoot, "note.md");
		// ノート直下の添付フォルダ。幅指定の前の相対パスが指す
		string nestedDir = Path.Combine(_tempRoot, "_添付ファイル");
		Directory.CreateDirectory(nestedDir);
		// 幅の数値を除いたあとに残るファイル名の PNG
		string imagePath = Path.Combine(nestedDir, "Pasted image 20260908104606.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		// 幅指定を除いて添付フォルダ内の画像へ解決した結果。失敗時は Error に理由がある
		ReadImageResult result = _fileService.ReadImageAsDataUrl(
			path: null,
			notePath,
			embed: "_添付ファイル/Pasted image 20260908104606.png|478");

		Assert.True(result.Ok, result.Error);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	/// <summary>
	/// 保管庫直下からのパスと幅指定を、ノートからの相対パスではなくその画像へ解決する
	/// </summary>
	[Fact]
	public void ReadImageAsDataUrl_resolves_vault_root_embed_with_arbitrary_attachment_folder()
	{
		// 保管庫の印。これがあるとノート相対より保管庫直下のパスを優先できる
		Directory.CreateDirectory(Path.Combine(_tempRoot, ".obsidian"));
		// ノートを置く深いディレクトリ。画像とは別
		string noteDirectory = Path.Combine(_tempRoot, "notes", "nested");
		// 保管庫直下からのパスが指す画像ディレクトリ
		string imageDirectory = Path.Combine(_tempRoot, "custom-attachments", "images");
		Directory.CreateDirectory(noteDirectory);
		Directory.CreateDirectory(imageDirectory);
		// 深い場所のノート。画像の隣ではない
		string notePath  = Path.Combine(noteDirectory, "note.md");
		// 幅指定の前の保管庫パスが指す PNG
		string imagePath = Path.Combine(imageDirectory, "vault-image.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		// 保管庫直下のパスと幅指定を、ノート相対ではなくその画像へ解決した結果
		ReadImageResult result = _fileService.ReadImageAsDataUrl(
			path: null,
			notePath,
			embed: "custom-attachments/images/vault-image.png|480");

		Assert.True(result.Ok, result.Error);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	/// <summary>
	/// 保管庫の中でも、明示したノート相対の埋め込みはそのノートの隣の画像へ解決する
	/// </summary>
	[Fact]
	public void ReadImageAsDataUrl_resolves_explicit_document_relative_embed_inside_vault()
	{
		// 保管庫の印。明示したノート相対は保管庫検索より先に使う
		Directory.CreateDirectory(Path.Combine(_tempRoot, ".obsidian"));
		// ノートを置くディレクトリ
		string noteDirectory  = Path.Combine(_tempRoot, "notes");
		// ノート相対の ./images が指すディレクトリ
		string localDirectory = Path.Combine(noteDirectory, "images");
		Directory.CreateDirectory(localDirectory);
		// 埋め込みの基準にするノート
		string notePath  = Path.Combine(noteDirectory, "note.md");
		// ./images/local.png が指す PNG。保管庫の別場所には置かない
		string imagePath = Path.Combine(localDirectory, "local.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		// 明示したノート相対を、そのノートの隣の画像へ解決した結果
		ReadImageResult result = _fileService.ReadImageAsDataUrl(
			path: null,
			notePath,
			embed: "./images/local.png");

		Assert.True(result.Ok, result.Error);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	/// <summary>
	/// 保管庫内で一意なファイル名の埋め込みは、ノートと別の場所にある画像へ解決する
	/// </summary>
	[Fact]
	public void ReadImageAsDataUrl_resolves_unique_bare_embed_from_vault_root()
	{
		// 保管庫全体からファイル名を探す印
		Directory.CreateDirectory(Path.Combine(_tempRoot, ".obsidian"));
		// 画像とは別の場所に置くノートのディレクトリ
		string noteDirectory  = Path.Combine(_tempRoot, "notes", "nested");
		// 一意なファイル名の PNG を置く、ノートの隣ではない場所
		string imageDirectory = Path.Combine(_tempRoot, "another-attachment-location");
		Directory.CreateDirectory(noteDirectory);
		Directory.CreateDirectory(imageDirectory);
		// ファイル名だけの埋め込みの基準にするノート
		string notePath  = Path.Combine(noteDirectory, "note.md");
		// 保管庫内で1つだけの unique.png
		string imagePath = Path.Combine(imageDirectory, "unique.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		// ファイル名だけで保管庫内の一意な画像へ解決した結果
		ReadImageResult result = _fileService.ReadImageAsDataUrl(path: null, notePath, embed: "unique.png");

		Assert.True(result.Ok, result.Error);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	/// <summary>
	/// 同名画像が複数あるときはどれも選ばず、見つからないエラーにする
	/// </summary>
	[Fact]
	public void ReadImageAsDataUrl_does_not_choose_ambiguous_bare_embed()
	{
		// 保管庫全体から同名を探す印。ノートの隣には画像が無い
		Directory.CreateDirectory(Path.Combine(_tempRoot, ".obsidian"));
		// 画像を置かないノートのディレクトリ
		string noteDirectory = Path.Combine(_tempRoot, "notes");
		// 同名 PNG の1件目を置く場所
		string firstFolder   = Path.Combine(_tempRoot, "attachments-a");
		// 同名 PNG の2件目を置く場所。両方あるとどれも選ばない
		string secondFolder  = Path.Combine(_tempRoot, "attachments-b");
		Directory.CreateDirectory(noteDirectory);
		Directory.CreateDirectory(firstFolder);
		Directory.CreateDirectory(secondFolder);
		// 同名解決の基準にするノート。隣には duplicate.png が無い
		string notePath = Path.Combine(noteDirectory, "note.md");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(Path.Combine(firstFolder, "duplicate.png"), [0x89, 0x50, 0x4E, 0x47]);
		File.WriteAllBytes(Path.Combine(secondFolder, "duplicate.png"), [0x89, 0x50, 0x4E, 0x47]);

		// 同名が複数あるため失敗する解決結果。Ok は false
		ReadImageResult result = _fileService.ReadImageAsDataUrl(path: null, notePath, embed: "duplicate.png");

		Assert.False(result.Ok);
		Assert.Equal("画像ファイルが見つかりません。", result.Error);
	}

	/// <summary>
	/// ノートパスが無くても、幅指定付きの絶対パスをその画像へ解決する
	/// </summary>
	[Fact]
	public void ReadImageAsDataUrl_resolves_absolute_embed_without_document()
	{
		// ノートが無くても幅指定の前の絶対パスが指す PNG
		string imagePath = Path.Combine(_tempRoot, "absolute.png");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		// ノートパス無しで絶対パスと幅指定を解決した結果。失敗時は Error に理由がある
		ReadImageResult result = _fileService.ReadImageAsDataUrl(
			path: null,
			documentPath: null,
			embed: imagePath + "|300");

		Assert.True(result.Ok, result.Error);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	/// <summary>
	/// 同じファイル名で2回保存すると、両方の実体が残り、パスは重ならない
	/// </summary>
	[Fact]
	public void SaveImageCopy_writes_unique_filename()
	{
		// 同じファイル名で2回書く先。テストごとに空
		string directory = Path.Combine(_tempRoot, "shots");
		// 両方の実体へ同じ中身が残る PNG シグネチャ
		byte[] bytes     = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

		// 1回目の保存パス
		string first  = _fileService.SaveImageCopy(directory, bytes, "Pasted image 20260908120000.png");
		// 同名の2回目。first と重ならない
		string second = _fileService.SaveImageCopy(directory, bytes, "Pasted image 20260908120000.png");

		Assert.True(File.Exists(first));
		Assert.True(File.Exists(second));
		Assert.NotEqual(first, second);
		Assert.Equal(bytes, File.ReadAllBytes(first));
	}

	/// <summary>
	/// UTF-8 の書き出しは BOM を付けず、渡した HTML をそのまま書く
	/// </summary>
	[Fact]
	public void WriteUtf8_writes_without_bom()
	{
		// BOM 無し UTF-8 で新規に書く HTML
		string filePath = Path.Combine(_tempRoot, "export.html");

		// 渡した HTML を書いた結果。失敗すると Success が false
		SaveFileResult saved = _fileService.WriteUtf8(filePath, "<!DOCTYPE html><html><body>日本語</body></html>");

		Assert.True(saved.Success);
		// BOM の有無を見る書き出し後のバイト列。先頭3バイトが EF BB BF なら失敗
		byte[] bytes = File.ReadAllBytes(filePath);
		Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
		Assert.Equal("<!DOCTYPE html><html><body>日本語</body></html>", Encoding.UTF8.GetString(bytes));
	}

	/// <summary>
	/// 既存ファイルへの UTF-8 書き出しは、以前の内容を新しい文字列で置き換える
	/// </summary>
	[Fact]
	public void WriteUtf8_replaces_existing_file()
	{
		// 古い内容を新しい文字列で置き換える対象
		string filePath = Path.Combine(_tempRoot, "export.html");
		File.WriteAllText(filePath, "old");

		// 既存ファイルを置き換えた結果。失敗すると Success が false
		SaveFileResult saved = _fileService.WriteUtf8(filePath, "new-content");

		Assert.True(saved.Success);
		Assert.Equal("new-content", File.ReadAllText(filePath));
	}

	/// <summary>
	/// 上書き保存のあと、対象ファイルは新しい本文になり、一時ファイルは残らない
	/// </summary>
	[Fact]
	public void Save_overwrite_does_not_leave_temp_file()
	{
		// 上書きして一時ファイルが残らないことを見る対象
		string filePath = Path.Combine(_tempRoot, "note.md");
		File.WriteAllText(filePath, "old");

		// 新しい本文で上書きした保存結果。失敗すると Success が false
		SaveFileResult saved = _fileService.Save(filePath, "new", TextEncodingKind.Utf8, unifyEol: null);

		Assert.True(saved.Success);
		Assert.Equal("new", File.ReadAllText(filePath));
		// 上書き後に残った一時ファイル。空なら後始末できている
		string[] leftovers = Directory.GetFiles(_tempRoot, ".note.md.*.tmp");
		Assert.Empty(leftovers);
	}
}
