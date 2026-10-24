// ==============================================
// 貼り付け画像の保存先パスを解決する
// ==============================================

// フォルダは作らない。設定の文字列を絶対パスへ解決するだけで、作成と書き込みは FileService が行う

namespace TmsMdEditor.Services;

/// <summary>
/// クリップボード画像を置くフォルダの絶対パスを決める
/// 設定が空ならピクチャ配下の既定フォルダ、相対パスは失敗として理由を返す
/// </summary>
internal static class AttachmentFolder
{
	/// <summary>
	/// 既定パスに挟むアプリ名。設定で上書きできない
	/// </summary>
	public const string AppFolderName = "TMS-MDEditor";

	/// <summary>
	/// 既定パスの末尾フォルダ名。画像ファイル自体の名前ではない
	/// </summary>
	public const string ScreenshotsFolderName = "Screenshots";

	/// <summary>
	/// 設定が空のときに使う絶対パスを返す。フォルダの有無は見ない
	/// </summary>
	/// <returns>ピクチャ、またはユーザープロファイルの Pictures 配下の既定パス</returns>
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
	/// 設定値を保存先の絶対パスにする。空なら既定フォルダ、相対パスは失敗
	/// </summary>
	/// <param name="configured">設定されたパス。null や空白は既定フォルダにする。環境変数は展開する</param>
	/// <param name="folder">成功時の絶対パス。失敗時は空文字</param>
	/// <param name="error">失敗時の利用者向けメッセージ。成功時は null</param>
	/// <returns>絶対パスを決められたら true。相対パスや不正なパスは false</returns>
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
