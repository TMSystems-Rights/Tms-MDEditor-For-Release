// ==============================================
// 改行コードの判定と統一
// ==============================================

// CRLF、LF、CR の本数と混在、指定した改行への統一結果を固定する

using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 文字列を直接渡し、改行の判定と統一を確認する。ファイルは作らない
/// </summary>
public class EolAnalyzerTests
{
	/// <summary>
	/// CRLF だけの文字列は混在にせず、CRLF を2つと数える
	/// </summary>
	[Fact]
	public void Analyze_detects_crlf()
	{
		EolAnalysis analysis = EolAnalyzer.Analyze("a\r\nb\r\nc");

		Assert.Equal(EolKind.Crlf, analysis.Primary);
		Assert.False(analysis.IsMixed);
		Assert.Equal(2, analysis.CrlfCount);
	}

	/// <summary>
	/// LF だけの文字列は混在にせず、LF を2つと数える
	/// </summary>
	[Fact]
	public void Analyze_detects_lf()
	{
		EolAnalysis analysis = EolAnalyzer.Analyze("a\nb\nc");

		Assert.Equal(EolKind.Lf, analysis.Primary);
		Assert.False(analysis.IsMixed);
		Assert.Equal(2, analysis.LfCount);
	}

	/// <summary>
	/// CR だけの文字列は混在にせず、CR を2つと数える
	/// </summary>
	[Fact]
	public void Analyze_detects_cr()
	{
		EolAnalysis analysis = EolAnalyzer.Analyze("a\rb\rc");

		Assert.Equal(EolKind.Cr, analysis.Primary);
		Assert.False(analysis.IsMixed);
		Assert.Equal(2, analysis.CrCount);
	}

	/// <summary>
	/// CRLF、LF、CR が1つずつある文字列は混在とする
	/// </summary>
	[Fact]
	public void Analyze_detects_mixed_eol()
	{
		EolAnalysis analysis = EolAnalyzer.Analyze("a\r\nb\nc\rd");

		Assert.True(analysis.IsMixed);
		Assert.Equal(1, analysis.CrlfCount);
		Assert.Equal(1, analysis.LfCount);
		Assert.Equal(1, analysis.CrCount);
	}

	/// <summary>
	/// 指定した改行へ統一し、混在していても目標の改行だけが残る
	/// </summary>
	/// <param name="source">統一前の文字列。混在した改行を含んでよい。null は渡さない</param>
	/// <param name="target">統一先の改行種別</param>
	/// <param name="expected">統一後の文字列</param>
	[Theory]
	[InlineData("a\r\nb", EolKind.Crlf, "a\r\nb")]
	[InlineData("a\nb", EolKind.Lf, "a\nb")]
	[InlineData("a\rb", EolKind.Cr, "a\rb")]
	[InlineData("a\r\nb\nc", EolKind.Crlf, "a\r\nb\r\nc")]
	[InlineData("a\r\nb\nc", EolKind.Lf, "a\nb\nc")]
	public void NormalizeEol_unifies_line_endings(string source, EolKind target, string expected)
	{
		string normalized = EolAnalyzer.NormalizeEol(source, target);

		Assert.Equal(expected, normalized);
	}
}
