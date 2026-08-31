namespace TmsMdEditor.Services;

/// <summary>アプリ起動引数を解析する</summary>
internal static class StartupArguments
{
	private const string ForceNewWindowOption = "--force-new-window";
	private const string DetachedTabOption     = "--detached-tab";
	private const string WindowXOption         = "--window-x";
	private const string WindowYOption         = "--window-y";

	/// <summary>明示的な新規ウィンドウ起動かを返す</summary>
	public static bool IsForceNewWindow(string[] args) => args.Contains(ForceNewWindowOption, StringComparer.OrdinalIgnoreCase);

	/// <summary>通常の起動対象ファイルだけを返す</summary>
	public static string[] ResolveFilePaths(string[] args)
	{
		var paths = new List<string>();
		for (int index = 0; index < args.Length; index++)
		{
			string arg = args[index];
			if (string.Equals(arg, DetachedTabOption, StringComparison.OrdinalIgnoreCase)
				|| string.Equals(arg, WindowXOption, StringComparison.OrdinalIgnoreCase)
				|| string.Equals(arg, WindowYOption, StringComparison.OrdinalIgnoreCase))
			{
				index++;
				continue;
			}
			if (string.Equals(arg, ForceNewWindowOption, StringComparison.OrdinalIgnoreCase)) continue;

			string path = arg.Trim('"');
			if (File.Exists(path)) paths.Add(Path.GetFullPath(path));
		}
		return paths.ToArray();
	}

	/// <summary>切り離しタブ状態ファイルのパスを返す</summary>
	public static string? GetDetachedTabPath(string[] args)
	{
		int markerIndex = Array.FindIndex(args, arg => string.Equals(arg, DetachedTabOption, StringComparison.OrdinalIgnoreCase));
		return markerIndex >= 0 && markerIndex + 1 < args.Length ? args[markerIndex + 1].Trim('"') : null;
	}

	/// <summary>切り離し先のドロップ座標を返す</summary>
	public static Point? GetDetachedWindowPoint(string[] args)
	{
		string? x = GetOptionValue(args, WindowXOption);
		string? y = GetOptionValue(args, WindowYOption);
		return int.TryParse(x, out int screenX) && int.TryParse(y, out int screenY)
			? new Point(screenX, screenY)
			: null;
	}

	private static string? GetOptionValue(string[] args, string option)
	{
		int markerIndex = Array.FindIndex(args, arg => string.Equals(arg, option, StringComparison.OrdinalIgnoreCase));
		return markerIndex >= 0 && markerIndex + 1 < args.Length ? args[markerIndex + 1].Trim('"') : null;
	}
}
