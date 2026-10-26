// ==============================================
// ウィンドウアイコンの読み込み
// ==============================================

// アイコンの実体はこの型が保持しない。フォームは Load が返した Icon を破棄する

namespace TmsMdEditor.Services;

/// <summary>
/// exe 隣の icon.ico を優先し、無ければ exe に紐づくアイコンを読む
/// どちらも読めなければ null を返し、例外は出さない
/// </summary>
internal static class WindowIcon
{
	/// <summary>
	/// exe 隣で探すアイコンのファイル名。ディレクトリは含まない
	/// </summary>
	public const string FileName = "icon.ico";

	/// <summary>
	/// 実行中プロセスの基底ディレクトリと exe パスからアイコンを読む
	/// </summary>
	/// <returns>読み込んだアイコン。ファイルが無い、または壊れているときは null</returns>
	public static Icon? Load()
	{
		return Load(System.AppContext.BaseDirectory, Application.ExecutablePath);
	}

	/// <summary>
	/// icon.ico を優先し、無ければ exe の関連アイコンを読む。失敗は null に潰す
	/// </summary>
	/// <param name="baseDirectory">icon.ico を探すディレクトリ</param>
	/// <param name="executablePath">icon.ico が無いときの exe。null や実在しなければ関連アイコンは読まない</param>
	/// <returns>読み込んだアイコン。読めなければ null。呼び出し元が破棄する</returns>
	public static Icon? Load(string baseDirectory, string? executablePath)
	{
		try
		{
			// exe 隣の icon.ico。実在しなければ exe の関連アイコンへ落ちる
			string iconPath = Path.Combine(baseDirectory, FileName);
			// 隣のファイルがあるときだけそれを読む。壊れていれば catch で null
			if (File.Exists(iconPath))
			{
				return new Icon(iconPath);
			}

			// パスが空白でなく、exe が実在するときだけ関連アイコンを読む。どちらかが欠けても入らない
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
