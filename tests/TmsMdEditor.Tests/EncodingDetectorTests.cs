// ==============================================
// 文字コードの判定と往復
// ==============================================

// BOM の有無、UTF-16、判定できないバイト列の CP932、同じ文字コードでの符号化の往復を固定する

using System.Text;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// バイト列と文字列を直接渡し、ファイルは作らない
/// CP932 用のコードページが登録できない環境では、そのケースが失敗する
/// </summary>
public class EncodingDetectorTests
{
	/// <summary>
	/// CP932 の判定に必要なコードページを、このクラスのあいだプロセスへ登録する
	/// 登録はプロセスが終わるまで残る
	/// </summary>
	static EncodingDetectorTests()
	{
		Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
	}

	/// <summary>
	/// UTF-8 の BOM 付きバイト列を、BOM 付き UTF-8 と判定する
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_utf8_bom()
	{
		byte[] bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes("hello")).ToArray();

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf8Bom, encoding);
	}

	/// <summary>
	/// UTF-16 LE の BOM 付きバイト列を、UTF-16 LE と判定する
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_utf16_le_bom()
	{
		byte[] bytes = Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes("hello")).ToArray();

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf16Le, encoding);
	}

	/// <summary>
	/// UTF-16 BE の BOM 付きバイト列を、UTF-16 BE と判定する
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_utf16_be_bom()
	{
		byte[] bytes = Encoding.BigEndianUnicode.GetPreamble()
			.Concat(Encoding.BigEndianUnicode.GetBytes("hello"))
			.ToArray();

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf16Be, encoding);
	}

	/// <summary>
	/// BOM の無い日本語の UTF-8 を、BOM 無し UTF-8 と判定する
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_utf8_without_bom()
	{
		byte[] bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes("日本語テスト");

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf8, encoding);
	}

	/// <summary>
	/// UTF-8 として不正な Shift_JIS の日本語は CP932 にする
	/// </summary>
	[Fact]
	public void DetectEncoding_falls_back_to_cp932()
	{
		byte[] bytes = Encoding.GetEncoding(932).GetBytes("日本語");

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Cp932, encoding);
	}

	/// <summary>
	/// 先頭が長い ASCII でも、後ろの Shift_JIS を CP932 と判定して元の文字列に戻す
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_cp932_when_ascii_prefix_contains_shift_jis_body()
	{
		string content = new string('A', 5000) + "日本語テスト";
		byte[] bytes   = Encoding.GetEncoding(932).GetBytes(content);

		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Cp932, encoding);
		Assert.Equal(content, EncodingDetector.Decode(bytes, encoding));
	}

	/// <summary>
	/// 指定した文字コードで符号化してから復号し、改行と日本語を含めて元の文字列に戻る
	/// </summary>
	/// <param name="encodingKind">往復に使う文字コード。BOM の有無を含む</param>
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
