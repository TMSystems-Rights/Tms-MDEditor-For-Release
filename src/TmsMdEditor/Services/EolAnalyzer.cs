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
		// CRLF の個数。単独の CR や LF は含めない。0 はこの種別が無い
		int crlfCount = 0;
		// 直前が CR でない LF の個数。0 はこの種別が無い
		int lfCount   = 0;
		// 次が LF でない CR の個数。0 はこの種別が無い
		int crCount   = 0;

		for (int index = 0; index < text.Length; index += 1)
		{
			// 今見ている文字。CR の次が LF なら組で数える
			char current = text[index];

			// CR のとき、次が LF なら CRLF、そうでなければ単独 CR として数える
			if (current == '\r')
			{
				// 次の文字も範囲内で LF のときだけ CRLF として数える。どちらかが欠けても入らない
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

			// 単独 LF。CRLF の LF は上で index を進めてここへ来ない
			if (current == '\n')
			{
				lfCount += 1;
			}
		}

		// 現れた改行種別の数。0 は改行なし、2 以上は混在
		int kindsPresent = 0;

		// この種別が 1 回でもあれば種別に数える。0 件では入らない
		if (crlfCount > 0)
		{
			kindsPresent += 1;
		}

		// 単独 LF が 1 回でもあれば種別に数える
		if (lfCount > 0)
		{
			kindsPresent += 1;
		}

		// 単独 CR が 1 回でもあれば種別に数える
		if (crCount > 0)
		{
			kindsPresent += 1;
		}

		// 同数のときは CRLF、次に LF を優先した主改行。すべて 0 なら CRLF
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
		// いったん LF に寄せた本文。未知の種別では使わず引数を返す
		string normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal)
			.Replace("\r", "\n", StringComparison.Ordinal);

		return target switch
		{
			// CRLF へ戻す
			EolKind.Crlf => normalized.Replace("\n", "\r\n", StringComparison.Ordinal),
			// LF のまま返す
			EolKind.Lf   => normalized,
			// 単独 CR へ戻す
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
			// Windows 改行
			"crlf" => EolKind.Crlf,
			// LF のみ
			"lf"   => EolKind.Lf,
			// 旧 Mac の CR のみ
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
		// 改行が一つも無いときは主を CRLF にする。どれか一つでもあれば入らない
		if (crlfCount == 0 && lfCount == 0 && crCount == 0)
		{
			return EolKind.Crlf;
		}

		// CRLF が LF と CR のどちらにも劣らないとき主を CRLF にする。片方に負ければ入らない
		if (crlfCount >= lfCount && crlfCount >= crCount)
		{
			return EolKind.Crlf;
		}

		// LF が CR 以上なら LF。CR の方が多ければ入らない
		if (lfCount >= crCount)
		{
			return EolKind.Lf;
		}

		return EolKind.Cr;
	}
}
