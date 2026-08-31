using System.Text;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// 文字コード判定・エンコード/デコード
/// </summary>
internal static class EncodingDetector
{
	/// <summary>
	/// バイト列から文字コードを判定する
	/// </summary>
	/// <param name="bytes">ファイル内容</param>
	/// <returns>判定結果</returns>
	public static TextEncodingKind DetectEncoding(ReadOnlySpan<byte> bytes)
	{
		if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
		{
			return TextEncodingKind.Utf8Bom;
		}

		if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
		{
			return TextEncodingKind.Utf16Le;
		}

		if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
		{
			return TextEncodingKind.Utf16Be;
		}

		if (IsValidUtf8(bytes))
		{
			return TextEncodingKind.Utf8;
		}

		return TextEncodingKind.Cp932;
	}

	/// <summary>
	/// バイト列を文字列へデコードする
	/// </summary>
	/// <param name="bytes">ファイル内容</param>
	/// <param name="encodingKind">文字コード</param>
	/// <returns>デコード結果</returns>
	public static string Decode(byte[] bytes, TextEncodingKind encodingKind)
	{
		return GetEncoding(encodingKind).GetString(bytes);
	}

	/// <summary>
	/// 文字列をバイト列へエンコードする
	/// </summary>
	/// <param name="text">テキスト</param>
	/// <param name="encodingKind">文字コード</param>
	/// <returns>エンコード結果</returns>
	public static byte[] Encode(string text, TextEncodingKind encodingKind)
	{
		return GetEncoding(encodingKind).GetBytes(text);
	}

	/// <summary>
	/// 文字コード種別から <see cref="Encoding"/> を取得する
	/// </summary>
	/// <param name="encodingKind">文字コード種別</param>
	/// <returns>Encoding インスタンス</returns>
	public static Encoding GetEncoding(TextEncodingKind encodingKind)
	{
		return encodingKind switch
		{
			TextEncodingKind.Utf8     => new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
			TextEncodingKind.Utf8Bom  => new UTF8Encoding(encoderShouldEmitUTF8Identifier: true),
			TextEncodingKind.Utf16Le  => new UnicodeEncoding(bigEndian: false, byteOrderMark: true),
			TextEncodingKind.Utf16Be  => new UnicodeEncoding(bigEndian: true, byteOrderMark: true),
			TextEncodingKind.Cp932    => Encoding.GetEncoding(932),
			_                         => throw new ArgumentOutOfRangeException(nameof(encodingKind), encodingKind, null),
		};
	}

	/// <summary>
	/// UTF-8 として妥当か判定する
	/// </summary>
	/// <param name="bytes">判定対象</param>
	/// <returns>妥当なら true</returns>
	public static bool IsValidUtf8(ReadOnlySpan<byte> bytes)
	{
		int index = 0;

		while (index < bytes.Length)
		{
			byte value = bytes[index];

			if (value <= 0x7F)
			{
				index += 1;
				continue;
			}

			int sequenceLength;

			if ((value & 0xE0) == 0xC0)
			{
				sequenceLength = 2;
			}
			else if ((value & 0xF0) == 0xE0)
			{
				sequenceLength = 3;
			}
			else if ((value & 0xF8) == 0xF0)
			{
				sequenceLength = 4;
			}
			else
			{
				return false;
			}

			if (index + sequenceLength > bytes.Length)
			{
				// サンプル末尾で文字列が切れているだけなら UTF-8 として扱う
				return true;
			}

			for (int offset = 1; offset < sequenceLength; offset += 1)
			{
				if ((bytes[index + offset] & 0xC0) != 0x80)
				{
					return false;
				}
			}

			index += sequenceLength;
		}

		return true;
	}

	/// <summary>
	/// 文字列から文字コード種別を解決する
	/// </summary>
	/// <param name="value">設定値</param>
	/// <returns>文字コード種別</returns>
	public static TextEncodingKind ParseEncodingKind(string? value)
	{
		return value?.Trim().ToLowerInvariant() switch
		{
			"utf8" or "utf-8"           => TextEncodingKind.Utf8,
			"utf8bom" or "utf-8(bom)"   => TextEncodingKind.Utf8Bom,
			"utf16le" or "utf-16le"     => TextEncodingKind.Utf16Le,
			"utf16be" or "utf-16be"     => TextEncodingKind.Utf16Be,
			"cp932" or "shift_jis"      => TextEncodingKind.Cp932,
			_                           => throw new InvalidOperationException($"未対応の文字コードです: {value}"),
		};
	}
}
