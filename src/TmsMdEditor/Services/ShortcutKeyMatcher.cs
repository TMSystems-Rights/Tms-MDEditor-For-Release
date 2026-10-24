// ==============================================
// ショートカット文字列とキー入力の照合
// ==============================================

// 状態は持たない。WinForms の KeyEventArgs と設定の文字列を比べるだけで、コマンドは実行しない

namespace TmsMdEditor.Services;

/// <summary>
/// 設定のショートカットと KeyEventArgs が、修飾キーの過不足まで含めて一致するか判定する
/// 末尾のトークンだけをキー本体とみなし、空文字は不一致とする
/// </summary>
internal static class ShortcutKeyMatcher
{
	/// <summary>
	/// キーイベントがショートカット文字列と一致するかを返す。余分な修飾キーも不一致にする
	/// </summary>
	/// <param name="e">比較するキーイベント。Control、Shift、Alt と KeyCode を見る</param>
	/// <param name="shortcut">Ctrl+Shift+U 形式。区切りの空白は捨てる。空なら不一致</param>
	/// <returns>修飾とキー本体が両方一致すれば true</returns>
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

		// 必須修飾キーだけでなく余分な修飾キーも不一致にし、近い別操作の誤発火を防ぐ
		if (e.Control != needsControl || e.Shift != needsShift || e.Alt != needsAlt)
		{
			return false;
		}

		return MatchesKeyCode(e.KeyCode, parts[^1]);
	}

	/// <summary>
	/// ショートカット末尾のトークンを Keys へ対応付ける。英字は大文字小文字を無視する
	/// </summary>
	/// <param name="keyCode">イベントのキー本体</param>
	/// <param name="configuredKey">ショートカットの末尾トークン。1 文字の英字、数字、記号、または名前</param>
	/// <returns>対応する Keys と一致すれば true。未知の名前は false</returns>
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
			// 設定上の数字は上段キーとテンキーのどちらでも同じ操作として受け付ける
			int offset = key[0] - '0';
			return keyCode == (Keys)((int)Keys.D0 + offset)
				|| keyCode == (Keys)((int)Keys.NumPad0 + offset);
		}

		// 記号キーはキーボード由来の複数Keys値を、設定上の1表記へ対応付ける
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
