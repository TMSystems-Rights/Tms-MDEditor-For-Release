using System.Text;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class FileServiceTests : IDisposable
{
	private readonly string _tempRoot;
	private readonly FileService _fileService;

	public FileServiceTests()
	{
		Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

		_tempRoot    = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-file-test-{Guid.NewGuid():N}");
		_fileService = new FileService(new Logger());
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
	public void Read_detects_encoding_and_eol()
	{
		string filePath = Path.Combine(_tempRoot, "utf8-lf.md");
		File.WriteAllBytes(filePath, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes("line1\nline2"));

		TextFileInfo info = _fileService.Read(filePath);

		Assert.Equal(TextEncodingKind.Utf8, info.Encoding);
		Assert.Equal(EolKind.Lf, info.PrimaryEol);
		Assert.False(info.EolMixed);
		Assert.Equal("line1\nline2", info.Text);
	}

	[Fact]
	public void Save_preserves_encoding_and_bom()
	{
		string filePath = Path.Combine(_tempRoot, "utf8-bom.md");
		byte[] originalBytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true).GetPreamble()
			.Concat(new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes("before"))
			.ToArray();
		File.WriteAllBytes(filePath, originalBytes);

		TextFileInfo opened = _fileService.Read(filePath);
		Assert.Equal(TextEncodingKind.Utf8Bom, opened.Encoding);

		SaveFileResult saved = _fileService.Save(filePath, "after", opened.Encoding, unifyEol: null);

		Assert.True(saved.Success);
		byte[] savedBytes = File.ReadAllBytes(filePath);
		byte[] expectedBytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true).GetBytes("after");
		Assert.Equal(expectedBytes, savedBytes);
	}

	[Fact]
	public void Save_can_unify_mixed_eol_to_crlf()
	{
		string filePath = Path.Combine(_tempRoot, "mixed.md");
		File.WriteAllText(filePath, "a\r\nb\nc\rd", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

		TextFileInfo opened = _fileService.Read(filePath);
		Assert.True(opened.EolMixed);

		SaveFileResult saved = _fileService.Save(filePath, opened.Text, opened.Encoding, EolKind.Crlf);

		Assert.True(saved.Success);
		Assert.False(saved.EolMixed);
		Assert.Equal(EolKind.Crlf, saved.PrimaryEol);
		Assert.Equal("a\r\nb\r\nc\r\nd", File.ReadAllText(filePath, Encoding.UTF8));
	}

	[Fact]
	public void Read_and_save_roundtrip_cp932()
	{
		string filePath = Path.Combine(_tempRoot, "cp932.txt");
		Encoding cp932 = Encoding.GetEncoding(932);
		File.WriteAllBytes(filePath, cp932.GetBytes("日本語\r\nテスト"));

		TextFileInfo opened = _fileService.Read(filePath);
		Assert.Equal(TextEncodingKind.Cp932, opened.Encoding);

		SaveFileResult saved = _fileService.Save(filePath, opened.Text, opened.Encoding, unifyEol: null);

		Assert.True(saved.Success);
		Assert.Equal(opened.Text, cp932.GetString(File.ReadAllBytes(filePath)));
	}

	[Fact]
	public void ReadImageAsDataUrl_resolves_relative_path()
	{
		string notePath = Path.Combine(_tempRoot, "note.md");
		string imagePath = Path.Combine(_tempRoot, "pic.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		ReadImageResult result = _fileService.ReadImageAsDataUrl("pic.png", notePath, embed: null);

		Assert.True(result.Ok);
		Assert.StartsWith("data:image/png;base64,", result.DataUrl);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	[Fact]
	public void ReadImageAsDataUrl_resolves_embed_in_subdirectory()
	{
		string notePath = Path.Combine(_tempRoot, "note.md");
		string nestedDir = Path.Combine(_tempRoot, "assets");
		Directory.CreateDirectory(nestedDir);
		string imagePath = Path.Combine(nestedDir, "nested.png");
		File.WriteAllText(notePath, "# note");
		File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

		ReadImageResult result = _fileService.ReadImageAsDataUrl(path: null, notePath, embed: "nested.png");

		Assert.True(result.Ok);
		Assert.Equal(Path.GetFullPath(imagePath), result.ResolvedPath);
	}

	[Fact]
	public void WriteUtf8_writes_without_bom()
	{
		string filePath = Path.Combine(_tempRoot, "export.html");

		SaveFileResult saved = _fileService.WriteUtf8(filePath, "<!DOCTYPE html><html><body>日本語</body></html>");

		Assert.True(saved.Success);
		byte[] bytes = File.ReadAllBytes(filePath);
		Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
		Assert.Equal("<!DOCTYPE html><html><body>日本語</body></html>", Encoding.UTF8.GetString(bytes));
	}

	[Fact]
	public void WriteUtf8_replaces_existing_file()
	{
		string filePath = Path.Combine(_tempRoot, "export.html");
		File.WriteAllText(filePath, "old");

		SaveFileResult saved = _fileService.WriteUtf8(filePath, "new-content");

		Assert.True(saved.Success);
		Assert.Equal("new-content", File.ReadAllText(filePath));
	}
}
