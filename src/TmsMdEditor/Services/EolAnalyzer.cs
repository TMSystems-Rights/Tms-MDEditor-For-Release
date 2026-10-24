// ==============================================
// 改行の集計と統一
// ==============================================

// 状態は持たない。FileService が読み書きの前後に呼び、混在の判定と保存前の統一に使う

using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// 本文中の CR、LF、CRLF を数え、最も多い種別を主改行とする
/// 同数のときは CRLF、次に LF を優先する。改行が無ければ CRLF で、混在ではない
/// </summary>
internal static class EolAnalyzer
{
	/// <summary>
	/// 本文の改行を種別ごとに数える。CRLF は CR と LF に分解しない
	/// </summary>
	/// <param name="text">数える本文。空文字は改行なしとして CRLF を主とする</param>
	/// <returns>主改行、混在かどうか、CRLF / LF / CR の個数</returns>
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
	/// 本文の改行をいったん LF へ寄せてから、指定した種別へ戻す
	/// </summary>
	/// <param name="text">変換する本文。改行以外の文字は変えない</param>
	/// <param name="target">統一先。CRLF、LF、CR 以外のときは本文をそのまま返す</param>
	/// <returns>統一した本文。未知の <paramref name="target"/> では引数のまま</returns>
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
	/// 設定の文字列を改行種別に対応付ける。前後の空白と大文字小文字は無視する
	/// </summary>
	/// <param name="value">crlf、lf、cr のいずれか。null や空、未知の名前は失敗</param>
	/// <returns>対応する改行種別</returns>
	/// <exception cref="InvalidOperationException"><paramref name="value"/> が null、空、または crlf / lf / cr 以外</exception>
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

	/// <summary>
	/// 個数が最も多い種別を返す。同数なら CRLF、その次は LF を優先する
	/// </summary>
	/// <param name="crlfCount">CRLF の個数</param>
	/// <param name="lfCount">単独 LF の個数</param>
	/// <param name="crCount">単独 CR の個数</param>
	/// <returns>主改行。すべて 0 のときは CRLF</returns>
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
