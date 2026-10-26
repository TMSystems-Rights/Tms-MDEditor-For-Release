// ==============================================
// ショートカットキーの一致判定
// ==============================================

// Ctrl と Shift を含むキー入力が、設定されたショートカット表記と一致する条件を固定する

using System.Windows.Forms;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// キーイベントとショートカット文字列を直接比較する。設定ファイルは読まない
/// </summary>
public sealed class ShortcutKeyMatcherTests
{
	/// <summary>
	/// Ctrl+Shift と合わせた OEM キーや U が、分割用のショートカット表記と一致する
	/// </summary>
	/// <param name="keyCode">Ctrl と Shift と組み合わせるキー。修飾キー自体は含めない</param>
	/// <param name="shortcut">比較するショートカット表記。空は渡さない</param>
	[Theory]
	[InlineData(Keys.OemMinus, "Ctrl+Shift+-")]
	[InlineData(Keys.Oem5, "Ctrl+Shift+\\")]
	[InlineData(Keys.Oem102, "Ctrl+Shift+\\")]
	[InlineData(Keys.Oemplus, "Ctrl+Shift+=")]
	[InlineData(Keys.U, "Ctrl+Shift+U")]
	public void Matches_detects_split_shortcuts(Keys keyCode, string shortcut)
	{
		// Ctrl と Shift を対象キーへ足した入力。余分な Alt は含まない
		var keyEvent = new KeyEventArgs(keyCode | Keys.Control | Keys.Shift);

		Assert.True(ShortcutKeyMatcher.Matches(keyEvent, shortcut));
	}

	/// <summary>
	/// Shift が無い、または Alt が余分な Ctrl+Shift+U は一致しない
	/// </summary>
	[Fact]
	public void Matches_rejects_missing_or_extra_modifiers()
	{
		Assert.False(ShortcutKeyMatcher.Matches(
			new KeyEventArgs(Keys.U | Keys.Control),
			"Ctrl+Shift+U"));
		Assert.False(ShortcutKeyMatcher.Matches(
			new KeyEventArgs(Keys.U | Keys.Control | Keys.Shift | Keys.Alt),
			"Ctrl+Shift+U"));
	}

	/// <summary>
	/// Ctrl+Alt+M は、その表記のショートカットと一致する
	/// </summary>
	[Fact]
	public void Matches_supports_custom_letter_shortcut()
	{
		// Ctrl と Alt と M を同時に押した入力
		var keyEvent = new KeyEventArgs(Keys.M | Keys.Control | Keys.Alt);

		Assert.True(ShortcutKeyMatcher.Matches(keyEvent, "Ctrl+Alt+M"));
	}

	/// <summary>
	/// Ctrl+Space は、Space のショートカットと一致する
	/// </summary>
	[Fact]
	public void Matches_supports_space_shortcut()
	{
		// Ctrl と Space を同時に押した入力
		var keyEvent = new KeyEventArgs(Keys.Space | Keys.Control);

		Assert.True(ShortcutKeyMatcher.Matches(keyEvent, "Ctrl+Space"));
	}
}
