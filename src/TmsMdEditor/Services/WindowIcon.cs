namespace TmsMdEditor.Services;

/// <summary>
/// ウィンドウ / タスクバー用アイコンを解決する
/// </summary>
internal static class WindowIcon
{
	/// <summary>exe 隣へコピーするアイコンファイル名</summary>
	public const string FileName = "icon.ico";

	/// <summary>
	/// 実行中プロセスのウィンドウアイコンを読み込む
	/// </summary>
	/// <returns>アイコン。読み込めなければ null</returns>
	public static Icon? Load()
	{
		return Load(System.AppContext.BaseDirectory, Application.ExecutablePath);
	}

	/// <summary>
	/// 指定ディレクトリまたは exe からウィンドウアイコンを読み込む
	/// </summary>
	/// <param name="baseDirectory">icon.ico を探すディレクトリ</param>
	/// <param name="executablePath">フォールバック用 exe パス</param>
	/// <returns>アイコン。読み込めなければ null</returns>
	public static Icon? Load(string baseDirectory, string? executablePath)
	{
		try
		{
			string iconPath = Path.Combine(baseDirectory, FileName);
			if (File.Exists(iconPath))
			{
				return new Icon(iconPath);
			}

			if (!string.IsNullOrWhiteSpace(executablePath) && File.Exists(executablePath))
			{
				return Icon.ExtractAssociatedIcon(executablePath);
			}
		}
		catch
		{
			return null;
		}

		return null;
	}
}
