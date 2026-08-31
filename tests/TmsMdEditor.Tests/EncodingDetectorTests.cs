using System.Text;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class EncodingDetectorTests
{
	static EncodingDetectorTests()
	{
		Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
	}

	[Fact]
	public void DetectEncoding_detects_utf8_bom()
	{
		byte[] bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes("hello")).ToArray();

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf8Bom, encoding);
	}

	[Fact]
	public void DetectEncoding_detects_utf16_le_bom()
	{
		byte[] bytes = Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes("hello")).ToArray();

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf16Le, encoding);
	}

	[Fact]
	public void DetectEncoding_detects_utf16_be_bom()
	{
		byte[] bytes = Encoding.BigEndianUnicode.GetPreamble()
			.Concat(Encoding.BigEndianUnicode.GetBytes("hello"))
			.ToArray();

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf16Be, encoding);
	}

	[Fact]
	public void DetectEncoding_detects_utf8_without_bom()
	{
		byte[] bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes("日本語テスト");

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf8, encoding);
	}

	[Fact]
	public void DetectEncoding_falls_back_to_cp932()
	{
		byte[] bytes = Encoding.GetEncoding(932).GetBytes("日本語");

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Cp932, encoding);
	}

	[Fact]
	public void DetectEncoding_detects_cp932_when_ascii_prefix_contains_shift_jis_body()
	{
		string content = new string('A', 5000) + "日本語テスト";
		byte[] bytes   = Encoding.GetEncoding(932).GetBytes(content);

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Cp932, encoding);
		Assert.Equal(content, EncodingDetector.Decode(bytes, encoding));
	}

	[Theory]
	[InlineData(TextEncodingKind.Utf8)]
	[InlineData(TextEncodingKind.Utf8Bom)]
	[InlineData(TextEncodingKind.Utf16Le)]
	[InlineData(TextEncodingKind.Utf16Be)]
	[InlineData(TextEncodingKind.Cp932)]
	public void Encode_and_decode_roundtrip(TextEncodingKind encodingKind)
	{
		const string source = "line1\r\nline2\n日本語";

		byte[] encoded = EncodingDetector.Encode(source, encodingKind);
		string decoded = EncodingDetector.Decode(encoded, encodingKind);

		Assert.Equal(source, decoded);
	}
}
