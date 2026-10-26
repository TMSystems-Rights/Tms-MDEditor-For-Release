// ==============================================
// 起動引数の解釈
// ==============================================

// プロセスの引数配列を受け取るだけで、ファイルは開かない
// 単一インスタンスの転送後も同じ解釈を使う

namespace TmsMdEditor.Services;

/// <summary>
/// コマンドラインから、開くファイル、新規ウィンドウ指定、切り離しタブの位置を取り出す
/// 未知の引数はファイル候補とし、実在しなければ捨てる
/// </summary>
internal static class StartupArguments
{
	/// <summary>
	/// 単一インスタンスを抜けて新しいウィンドウを開く印。値は持たない
	/// </summary>
	private const string ForceNewWindowOption = "--force-new-window";

	/// <summary>
	/// 次の引数が切り離しタブ状態ファイルのパスである印。ファイルの存在はここでは見ない
	/// </summary>
	private const string DetachedTabOption     = "--detached-tab";

	/// <summary>
	/// 次の引数がドロップ位置の水平座標である印。単位は px
	/// </summary>
	private const string WindowXOption         = "--window-x";

	/// <summary>
	/// 次の引数がドロップ位置の垂直座標である印。単位は px
	/// </summary>
	private const string WindowYOption         = "--window-y";

	/// <summary>
	/// 新規ウィンドウを強制する印が含まれるかを返す。大文字小文字は無視する
	/// </summary>
	/// <param name="args">起動引数。オプションの値は見ない</param>
	/// <returns>印があれば true</returns>
	public static bool IsForceNewWindow(string[] args) => args.Contains(ForceNewWindowOption, StringComparer.OrdinalIgnoreCase);

	/// <summary>
	/// 内部オプションとその値を除き、実在するファイルだけを絶対パスで返す
	/// </summary>
	/// <param name="args">起動引数。未知の引数はファイル候補、実在しなければ捨てる</param>
	/// <returns>開く対象の絶対パス。無ければ空配列</returns>
	public static string[] ResolveFilePaths(string[] args)
	{
		// 実在したファイルの絶対パス。未知の引数でも実在しなければ入れない
		var paths = new List<string>();
		for (int index = 0; index < args.Length; index++)
		{
			// 今見ている引数。値を持つオプションなら次の要素もファイルにしない
			string arg = args[index];
			// 内部オプションの値をファイルパスと誤認しないよう、オプションと次の1要素をまとめて飛ばす
			// 値を持つ印のどれか一つに一致すれば入る。どれでもなければファイル候補へ進む
			if (string.Equals(arg, DetachedTabOption, StringComparison.OrdinalIgnoreCase)
				|| string.Equals(arg, WindowXOption, StringComparison.OrdinalIgnoreCase)
				|| string.Equals(arg, WindowYOption, StringComparison.OrdinalIgnoreCase))
			{
				index++;
				continue;
			}
			// 新規ウィンドウの印は値を持たないので、その要素だけファイルにしない
			if (string.Equals(arg, ForceNewWindowOption, StringComparison.OrdinalIgnoreCase)) continue;

			// 前後の引用符を外した候補。実在しなければ捨てる
			string path = arg.Trim('"');
			// 実在するときだけ絶対パスを追加する。無いパスでは入らない
			if (File.Exists(path)) paths.Add(Path.GetFullPath(path));
		}
		return paths.ToArray();
	}

	/// <summary>
	/// 切り離しタブ状態ファイルのパスを返す。存在確認はしない
	/// </summary>
	/// <param name="args">起動引数。印の次の要素をパスとみなす</param>
	/// <returns>パス。印が無い、または値が無いときは null。前後の引用符は外す</returns>
	public static string? GetDetachedTabPath(string[] args)
	{
		// 切り離し印の位置。無ければ -1 で null を返す
		int markerIndex = Array.FindIndex(args, arg => string.Equals(arg, DetachedTabOption, StringComparison.OrdinalIgnoreCase));
		return markerIndex >= 0 && markerIndex + 1 < args.Length ? args[markerIndex + 1].Trim('"') : null;
	}

	/// <summary>
	/// 切り離し先のドロップ座標を返す。両方の整数が揃ったときだけ有効
	/// </summary>
	/// <param name="args">起動引数。水平と垂直のオプションを別々に読む</param>
	/// <returns>スクリーン座標。単位は px。どちらかが整数でなければ null</returns>
	public static Point? GetDetachedWindowPoint(string[] args)
	{
		// 水平座標の文字列。単位は px。オプションや値が無ければ null で点にしない
		string? x = GetOptionValue(args, WindowXOption);
		// 垂直座標の文字列。単位は px。null や整数でないときは点にしない
		string? y = GetOptionValue(args, WindowYOption);
		return int.TryParse(x, out int screenX) && int.TryParse(y, out int screenY)
			? new Point(screenX, screenY)
			: null;
	}

	/// <summary>
	/// オプションの次の引数を返す。無ければ null
	/// </summary>
	/// <param name="args">探す引数配列</param>
	/// <param name="option">値を持つオプション名。大文字小文字は無視する</param>
	/// <returns>次の引数。前後の引用符は外す。オプションや値が無ければ null</returns>
	private static string? GetOptionValue(string[] args, string option)
	{
		// オプションの位置。無ければ -1 で null。次の要素が無ければ値も null
		int markerIndex = Array.FindIndex(args, arg => string.Equals(arg, option, StringComparison.OrdinalIgnoreCase));
		return markerIndex >= 0 && markerIndex + 1 < args.Length ? args[markerIndex + 1].Trim('"') : null;
	}
}
