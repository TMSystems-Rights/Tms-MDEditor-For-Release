// ==============================================
// バイト列の文字コード判定
// ==============================================

// 状態は持たない。FileService が読み書きの直前に使い、設定画面の名前との対応もここが引き受ける

using System.Text;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// BOM と UTF-8 の妥当性から文字コードを決め、その Encoding で相互変換する
/// 妥当な UTF-8 でなければ Cp932 とする。未知の名前は変換せず例外にする
/// </summary>
internal static class EncodingDetector
{
	/// <summary>
	/// BOM を優先して文字コードを決める。BOM が無く、UTF-8 として妥当なら Utf8、そうでなければ Cp932
	/// </summary>
	/// <param name="bytes">判定するファイル内容。空は Utf8</param>
	/// <returns>採用する文字コード。設定値へは書き戻さない</returns>
	public static TextEncodingKind DetectEncoding(ReadOnlySpan<byte> bytes)
	{
		// UTF-8 BOM は 3 バイトが EF BB BF のときだけ。長さ不足や途中のバイトが違えば入らない
		if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
		{
			return TextEncodingKind.Utf8Bom;
		}

		// UTF-16 LE の BOM。長さが 2 以上で FF FE のときだけ。一方が違えば入らない
		if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
		{
			return TextEncodingKind.Utf16Le;
		}

		// UTF-16 BE の BOM。FE FF のときだけ。LE の並びでは入らない
		if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
		{
			return TextEncodingKind.Utf16Be;
		}

		// BOM が無く、不正な並びも無いとき UTF-8。不正なら Cp932 へ落とす
		if (IsValidUtf8(bytes))
		{
			return TextEncodingKind.Utf8;
		}

		return TextEncodingKind.Cp932;
	}

	/// <summary>
	/// 指定した文字コードでバイト列を文字列にする
	/// </summary>
	/// <param name="bytes">デコードする内容。空なら空文字</param>
	/// <param name="encodingKind">使う文字コード。定義外は <see cref="GetEncoding"/> が例外にする</param>
	/// <returns>デコードした文字列。BOM は Encoding の規則に従う</returns>
	public static string Decode(byte[] bytes, TextEncodingKind encodingKind)
	{
		return GetEncoding(encodingKind).GetString(bytes);
	}

	/// <summary>
	/// 指定した文字コードで文字列をバイト列にする。UTF-8 は BOM 無し、Utf8Bom と UTF-16 は BOM 付き
	/// </summary>
	/// <param name="text">エンコードする本文</param>
	/// <param name="encodingKind">使う文字コード。定義外は <see cref="GetEncoding"/> が例外にする</param>
	/// <returns>エンコードしたバイト列</returns>
	public static byte[] Encode(string text, TextEncodingKind encodingKind)
	{
		return GetEncoding(encodingKind).GetBytes(text);
	}

	/// <summary>
	/// 文字コード種別から、呼び出しのたびに新しい Encoding を作る
	/// </summary>
	/// <param name="encodingKind">対応付ける種別</param>
	/// <returns>BOM の有無を種別どおりにした Encoding。呼び出し元が所有する</returns>
	/// <exception cref="ArgumentOutOfRangeException"><paramref name="encodingKind"/> が定義外</exception>
	public static Encoding GetEncoding(TextEncodingKind encodingKind)
	{
		return encodingKind switch
		{
			// BOM 無し UTF-8
			TextEncodingKind.Utf8     => new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
			// BOM 付き UTF-8
			TextEncodingKind.Utf8Bom  => new UTF8Encoding(encoderShouldEmitUTF8Identifier: true),
			// BOM 付き UTF-16 リトルエンディアン
			TextEncodingKind.Utf16Le  => new UnicodeEncoding(bigEndian: false, byteOrderMark: true),
			// BOM 付き UTF-16 ビッグエンディアン
			TextEncodingKind.Utf16Be  => new UnicodeEncoding(bigEndian: true, byteOrderMark: true),
			// Windows のコードページ 932
			TextEncodingKind.Cp932    => Encoding.GetEncoding(932),
			_                         => throw new ArgumentOutOfRangeException(nameof(encodingKind), encodingKind, null),
		};
	}

	/// <summary>
	/// バイト列が UTF-8 として妥当かを返す。末尾で多バイト列が途切れているだけなら妥当とみなす
	/// </summary>
	/// <param name="bytes">判定するバイト列。空は妥当</param>
	/// <returns>不正な継続バイトや先頭バイトが無ければ true</returns>
	public static bool IsValidUtf8(ReadOnlySpan<byte> bytes)
	{
		// 次に読む位置。末尾まで進んだら妥当。空配列は 0 のまま妥当
		int index = 0;

		while (index < bytes.Length)
		{
			// 今の先頭バイト。0x7F 以下は 1 バイトで進む
			byte value = bytes[index];

			// ASCII。多バイトの判定には入らない
			if (value <= 0x7F)
			{
				index += 1;
				continue;
			}

			// この先頭から続くバイト数。不正な先頭では代入せず false
			int sequenceLength;

			// 2 バイト列の先頭。上位 3 ビットが 110 のときだけ
			if ((value & 0xE0) == 0xC0)
			{
				sequenceLength = 2;
			}
			// 3 バイト列の先頭。2 バイトの形には当てはまらない
			else if ((value & 0xF0) == 0xE0)
			{
				sequenceLength = 3;
			}
			// 4 バイト列の先頭。2 バイトでも 3 バイトでもない
			else if ((value & 0xF8) == 0xF0)
			{
				sequenceLength = 4;
			}
			else
			{
				return false;
			}

			// 宣言よりファイル末尾が先に来る途切れ。不正ではなく妥当とみなす
			if (index + sequenceLength > bytes.Length)
			{
				// サンプル末尾で文字列が切れているだけなら UTF-8 として扱う
				return true;
			}

			for (int offset = 1; offset < sequenceLength; offset += 1)
			{
				// 継続バイトでない並びは UTF-8 として不正
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
	/// 設定の文字列を文字コード種別に対応付ける。前後の空白と大文字小文字は無視する
	/// </summary>
	/// <param name="value">utf-8、utf-8(bom)、utf-16le、utf-16be、cp932 などの別名。null や未知は失敗</param>
	/// <returns>対応する文字コード種別</returns>
	/// <exception cref="InvalidOperationException"><paramref name="value"/> が null、空、または対応する別名以外</exception>
	public static TextEncodingKind ParseEncodingKind(string? value)
	{
		return value?.Trim().ToLowerInvariant() switch
		{
			// BOM 無し UTF-8。ハイフンの有無は同じ種別
			"utf8" or "utf-8"           => TextEncodingKind.Utf8,
			// BOM 付き UTF-8
			"utf8bom" or "utf-8(bom)"   => TextEncodingKind.Utf8Bom,
			// UTF-16 リトルエンディアン
			"utf16le" or "utf-16le"     => TextEncodingKind.Utf16Le,
			// UTF-16 ビッグエンディアン
			"utf16be" or "utf-16be"     => TextEncodingKind.Utf16Be,
			// コードページ 932。shift_jis も同じ種別
			"cp932" or "shift_jis"      => TextEncodingKind.Cp932,
			_                           => throw new InvalidOperationException($"未対応の文字コードです: {value}"),
		};
	}
}
