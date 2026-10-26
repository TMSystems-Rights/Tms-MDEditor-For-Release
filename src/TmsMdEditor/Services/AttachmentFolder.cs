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
		// ピクチャ特殊フォルダ。未設定の環境では空になり、ユーザー配下の Pictures へ落とす
		string pictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
		// 特殊フォルダが空のときだけ、ユーザープロファイル直下の Pictures を既定にする
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
		// null は空として扱う設定値。前後の空白は除く。長さ 0 は既定フォルダ
		string trimmed = (configured ?? string.Empty).Trim();
		// 空の設定は失敗にせず、ピクチャ配下の既定フォルダを返す
		if (trimmed.Length == 0)
		{
			folder = GetDefaultFolder();
			error  = null;
			return true;
		}

		// 環境変数を展開した候補。未定義の変数は展開されず残る
		string expanded = Environment.ExpandEnvironmentVariables(trimmed);
		// 相対パスは保存先にせず失敗にする。絶対パスだけ次の正規化へ進む
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
