namespace TmsMdEditor.Services;

/// <summary>
/// WinForms のキーイベントと設定上のショートカット文字列を照合する。
/// </summary>
internal static class ShortcutKeyMatcher
{
	/// <summary>
	/// キーイベントがショートカット文字列と一致するか判定する
	/// </summary>
	/// <param name="e">キーイベント</param>
	/// <param name="shortcut">Ctrl+Shift+U 形式のショートカット</param>
	/// <returns>一致する場合 true</returns>
	public static bool Matches(KeyEventArgs e, string shortcut)
	{
		string[] parts = shortcut.Split(
			'+',
			StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
		if (parts.Length == 0)
		{
			return false;
		}

		bool needsControl = parts.Any(part => part.Equals("Ctrl", StringComparison.OrdinalIgnoreCase));
		bool needsShift   = parts.Any(part => part.Equals("Shift", StringComparison.OrdinalIgnoreCase));
		bool needsAlt     = parts.Any(part => part.Equals("Alt", StringComparison.OrdinalIgnoreCase));

		if (e.Control != needsControl || e.Shift != needsShift || e.Alt != needsAlt)
		{
			return false;
		}

		return MatchesKeyCode(e.KeyCode, parts[^1]);
	}

	private static bool MatchesKeyCode(Keys keyCode, string configuredKey)
	{
		string key = configuredKey.Trim();
		if (key.Length == 1 && char.IsLetter(key[0]))
		{
			Keys expected = (Keys)((int)Keys.A + char.ToUpperInvariant(key[0]) - 'A');
			return keyCode == expected;
		}

		if (key.Length == 1 && char.IsDigit(key[0]))
		{
			int offset = key[0] - '0';
			return keyCode == (Keys)((int)Keys.D0 + offset)
				|| keyCode == (Keys)((int)Keys.NumPad0 + offset);
		}

		return key.ToLowerInvariant() switch
		{
			"-"     => keyCode is Keys.OemMinus or Keys.Subtract,
			"="     => keyCode is Keys.Oemplus or Keys.Add,
			"\\"    => keyCode is Keys.Oem5 or Keys.Oem102,
			"enter" => keyCode == Keys.Enter,
			"tab"   => keyCode == Keys.Tab,
			"space" => keyCode == Keys.Space,
			_       => Enum.TryParse(key, ignoreCase: true, out Keys expected) && keyCode == expected,
		};
	}
}
