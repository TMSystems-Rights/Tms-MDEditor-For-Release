using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class EolAnalyzerTests
{
	[Fact]
	public void Analyze_detects_crlf()
	{
		EolAnalysis analysis = EolAnalyzer.Analyze("a\r\nb\r\nc");

		Assert.Equal(EolKind.Crlf, analysis.Primary);
		Assert.False(analysis.IsMixed);
		Assert.Equal(2, analysis.CrlfCount);
	}

	[Fact]
	public void Analyze_detects_lf()
	{
		EolAnalysis analysis = EolAnalyzer.Analyze("a\nb\nc");

		Assert.Equal(EolKind.Lf, analysis.Primary);
		Assert.False(analysis.IsMixed);
		Assert.Equal(2, analysis.LfCount);
	}

	[Fact]
	public void Analyze_detects_cr()
	{
		EolAnalysis analysis = EolAnalyzer.Analyze("a\rb\rc");

		Assert.Equal(EolKind.Cr, analysis.Primary);
		Assert.False(analysis.IsMixed);
		Assert.Equal(2, analysis.CrCount);
	}

	[Fact]
	public void Analyze_detects_mixed_eol()
	{
		EolAnalysis analysis = EolAnalyzer.Analyze("a\r\nb\nc\rd");

		Assert.True(analysis.IsMixed);
		Assert.Equal(1, analysis.CrlfCount);
		Assert.Equal(1, analysis.LfCount);
		Assert.Equal(1, analysis.CrCount);
	}

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
