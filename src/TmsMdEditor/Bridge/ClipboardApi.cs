using System.Text.Json;

namespace TmsMdEditor.Bridge;

/// <summary>
/// Windows クリップボード操作ブリッジ API
/// </summary>
internal sealed class ClipboardApi
{
	/// <summary>
	/// Unicode テキストを取得する
	/// </summary>
	/// <returns>クリップボード文字列</returns>
	public string ReadText()
	{
		return Clipboard.ContainsText(TextDataFormat.UnicodeText)
			? Clipboard.GetText(TextDataFormat.UnicodeText)
			: string.Empty;
	}

	/// <summary>
	/// Unicode テキストを書き込む
	/// </summary>
	/// <param name="paramsElement">text を含むパラメータ</param>
	/// <returns>処理結果</returns>
	public object WriteText(JsonElement paramsElement)
	{
		string text = paramsElement.TryGetProperty("text", out JsonElement textElement)
			? textElement.GetString() ?? string.Empty
			: string.Empty;

		if (text.Length == 0)
		{
			Clipboard.Clear();
		}
		else
		{
			Clipboard.SetText(text, TextDataFormat.UnicodeText);
		}

		return new { ok = true };
	}
}
