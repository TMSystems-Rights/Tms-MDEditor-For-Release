using System.Windows.Forms;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class ShortcutKeyMatcherTests
{
	[Theory]
	[InlineData(Keys.OemMinus, "Ctrl+Shift+-")]
	[InlineData(Keys.Oem5, "Ctrl+Shift+\\")]
	[InlineData(Keys.Oem102, "Ctrl+Shift+\\")]
	[InlineData(Keys.Oemplus, "Ctrl+Shift+=")]
	[InlineData(Keys.U, "Ctrl+Shift+U")]
	public void Matches_detects_split_shortcuts(Keys keyCode, string shortcut)
	{
		var keyEvent = new KeyEventArgs(keyCode | Keys.Control | Keys.Shift);

		Assert.True(ShortcutKeyMatcher.Matches(keyEvent, shortcut));
	}

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

	[Fact]
	public void Matches_supports_custom_letter_shortcut()
	{
		var keyEvent = new KeyEventArgs(Keys.M | Keys.Control | Keys.Alt);

		Assert.True(ShortcutKeyMatcher.Matches(keyEvent, "Ctrl+Alt+M"));
	}

	[Fact]
	public void Matches_supports_space_shortcut()
	{
		var keyEvent = new KeyEventArgs(Keys.Space | Keys.Control);

		Assert.True(ShortcutKeyMatcher.Matches(keyEvent, "Ctrl+Space"));
	}
}
