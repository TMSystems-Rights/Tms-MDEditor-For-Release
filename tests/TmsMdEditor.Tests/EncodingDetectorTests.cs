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
		// BOM と hello を連結した UTF-8。判定入力で、ファイルにはしない
		byte[] bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes("hello")).ToArray();

		// 判定した種別。BOM 付き UTF-8 以外なら失敗する
		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf8Bom, encoding);
	}

	/// <summary>
	/// UTF-16 LE の BOM 付きバイト列を、UTF-16 LE と判定する
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_utf16_le_bom()
	{
		// BOM 付き UTF-16 LE の hello。判定入力で、ファイルにはしない
		byte[] bytes = Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes("hello")).ToArray();

		// 判定した種別。UTF-16 LE 以外なら失敗する
		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf16Le, encoding);
	}

	/// <summary>
	/// UTF-16 BE の BOM 付きバイト列を、UTF-16 BE と判定する
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_utf16_be_bom()
	{
		// BOM 付き UTF-16 BE の hello。判定入力で、ファイルにはしない
		byte[] bytes = Encoding.BigEndianUnicode.GetPreamble()
			.Concat(Encoding.BigEndianUnicode.GetBytes("hello"))
			.ToArray();

		// 判定した種別。UTF-16 BE 以外なら失敗する
		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf16Be, encoding);
	}

	/// <summary>
	/// BOM の無い日本語の UTF-8 を、BOM 無し UTF-8 と判定する
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_utf8_without_bom()
	{
		// BOM の無い UTF-8 の日本語。判定入力で、ファイルにはしない
		byte[] bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes("日本語テスト");

		// 判定した種別。BOM 無し UTF-8 以外なら失敗する
		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Utf8, encoding);
	}

	/// <summary>
	/// UTF-8 として不正な Shift_JIS の日本語は CP932 にする
	/// </summary>
	[Fact]
	public void DetectEncoding_falls_back_to_cp932()
	{
		// Shift_JIS の日本語。UTF-8 としては不正な判定入力
		byte[] bytes = Encoding.GetEncoding(932).GetBytes("日本語");

		// 不正な UTF-8 を避けて決めた種別。CP932 以外なら失敗する
		TextEncodingKind encoding = EncodingDetector.DetectEncoding(bytes);

		Assert.Equal(TextEncodingKind.Cp932, encoding);
	}

	/// <summary>
	/// 先頭が長い ASCII でも、後ろの Shift_JIS を CP932 と判定して元の文字列に戻す
	/// </summary>
	[Fact]
	public void DetectEncoding_detects_cp932_when_ascii_prefix_contains_shift_jis_body()
	{
		// 先頭 5000 字の ASCII の後ろに日本語を続けた本文。ファイルにはしない
		string content = new string('A', 5000) + "日本語テスト";
		// content を CP932 で符号化した判定入力。先頭の ASCII だけでは種別を決めない
		byte[] bytes   = Encoding.GetEncoding(932).GetBytes(content);

		// 後ろの Shift_JIS を見て決めた種別。UTF-8 に寄ると失敗する
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
		// 改行と日本語を含む往復前の本文。符号化で変えない
		const string source = "line1\r\nline2\n日本語";

		// source を指定の文字コードで符号化したバイト列
		byte[] encoded = EncodingDetector.Encode(source, encodingKind);
		// encoded を同じ文字コードで戻した本文。source と一致する
		string decoded = EncodingDetector.Decode(encoded, encodingKind);

		Assert.Equal(source, decoded);
	}
}
