namespace TmsMdEditor.Services;

/// <summary>
/// クリップボード画像の保存先フォルダを解決する
/// </summary>
internal static class AttachmentFolder
{
	public const string AppFolderName = "TMS-MDEditor";

	public const string ScreenshotsFolderName = "Screenshots";

	/// <summary>
	/// 設定未入力時の内蔵既定フォルダを返す
	/// </summary>
	/// <returns>既定の絶対パス</returns>
	public static string GetDefaultFolder()
	{
		string pictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
		if (string.IsNullOrWhiteSpace(pictures))
		{
			pictures = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Pictures");
		}

		return Path.Combine(pictures, AppFolderName, ScreenshotsFolderName);
	}

	/// <summary>
	/// 設定値から保存先を解決する。空なら既定フォルダ
	/// </summary>
	/// <param name="configured">設定されたパス。空なら既定</param>
	/// <param name="folder">解決した絶対パス</param>
	/// <param name="error">失敗時のメッセージ</param>
	/// <returns>成功なら true</returns>
	public static bool TryResolve(string? configured, out string folder, out string? error)
	{
		string trimmed = (configured ?? string.Empty).Trim();
		if (trimmed.Length == 0)
		{
			folder = GetDefaultFolder();
			error  = null;
			return true;
		}

		string expanded = Environment.ExpandEnvironmentVariables(trimmed);
		if (!Path.IsPathFullyQualified(expanded))
		{
			folder = string.Empty;
			error  = "貼り付け画像の保存先は絶対パスで指定してください。";
			return false;
		}

		try
		{
			folder = Path.GetFullPath(expanded);
			error  = null;
			return true;
		}
		catch (Exception ex)
		{
			folder = string.Empty;
			error  = $"貼り付け画像の保存先が不正です。{ex.Message}";
			return false;
		}
	}
}
