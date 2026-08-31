using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// 改行コード判定・変換
/// </summary>
internal static class EolAnalyzer
{
	/// <summary>
	/// 改行コード分布を解析する
	/// </summary>
	/// <param name="text">テキスト</param>
	/// <returns>解析結果</returns>
	public static EolAnalysis Analyze(string text)
	{
		int crlfCount = 0;
		int lfCount   = 0;
		int crCount   = 0;

		for (int index = 0; index < text.Length; index += 1)
		{
			char current = text[index];

			if (current == '\r')
			{
				if (index + 1 < text.Length && text[index + 1] == '\n')
				{
					crlfCount += 1;
					index     += 1;
				}
				else
				{
					crCount += 1;
				}

				continue;
			}

			if (current == '\n')
			{
				lfCount += 1;
			}
		}

		int kindsPresent = 0;

		if (crlfCount > 0)
		{
			kindsPresent += 1;
		}

		if (lfCount > 0)
		{
			kindsPresent += 1;
		}

		if (crCount > 0)
		{
			kindsPresent += 1;
		}

		EolKind primary = ResolvePrimaryEol(crlfCount, lfCount, crCount);

		return new EolAnalysis(primary, kindsPresent > 1, crlfCount, lfCount, crCount);
	}

	/// <summary>
	/// 改行コードを指定種別へ統一する
	/// </summary>
	/// <param name="text">テキスト</param>
	/// <param name="target">統一先</param>
	/// <returns>変換後テキスト</returns>
	public static string NormalizeEol(string text, EolKind target)
	{
		string normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal)
			.Replace("\r", "\n", StringComparison.Ordinal);

		return target switch
		{
			EolKind.Crlf => normalized.Replace("\n", "\r\n", StringComparison.Ordinal),
			EolKind.Lf   => normalized,
			EolKind.Cr   => normalized.Replace("\n", "\r", StringComparison.Ordinal),
			_            => text,
		};
	}

	/// <summary>
	/// 文字列から改行コード種別を解決する
	/// </summary>
	/// <param name="value">設定値</param>
	/// <returns>改行コード種別</returns>
	public static EolKind ParseEolKind(string? value)
	{
		return value?.Trim().ToLowerInvariant() switch
		{
			"crlf" => EolKind.Crlf,
			"lf"   => EolKind.Lf,
			"cr"   => EolKind.Cr,
			_      => throw new InvalidOperationException($"未対応の改行コードです: {value}"),
		};
	}

	private static EolKind ResolvePrimaryEol(int crlfCount, int lfCount, int crCount)
	{
		if (crlfCount == 0 && lfCount == 0 && crCount == 0)
		{
			return EolKind.Crlf;
		}

		if (crlfCount >= lfCount && crlfCount >= crCount)
		{
			return EolKind.Crlf;
		}

		if (lfCount >= crCount)
		{
			return EolKind.Lf;
		}

		return EolKind.Cr;
	}
}
