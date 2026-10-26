// ==============================================
// ポータブル stub から本体へ渡す引数
// ==============================================

// 存在するファイルだけを絶対パスへ変え、フラグや未作成のパスはそのまま渡す
// パスとして不正な引数は例外にせず、受け取った文字列を残す

namespace TmsMdEditor.PortableLauncher;

/// <summary>
/// ポータブル起動用 stub が本体へ渡す引数を整える
/// </summary>
internal static class LaunchArguments
{
	/// <summary>
	/// Windows の既定アプリ名として使う FileDescription / ProductName
	/// </summary>
	public const string DisplayName = "TMS-MDEditor.portable";

	/// <summary>
	/// 本体へ転送する引数を返す。存在するファイルは絶対パスにする
	/// </summary>
	/// <param name="args">stub が受け取った引数。null は渡さない。件数 0 でも空の一覧を返す</param>
	/// <returns>本体へ渡す引数。入力と同じ件数で、存在しないパスとフラグは元の文字列</returns>
	public static IReadOnlyList<string> Normalize(IReadOnlyList<string> args)
	{
		// 本体へ渡す引数。件数は入力と同じ。要素は絶対パスか、変換しなかった元の文字列
		var forwarded = new List<string>(args.Count);
		foreach (string arg in args)
		{
			forwarded.Add(NormalizeOne(arg));
		}

		return forwarded;
	}

	/// <summary>
	/// 1 件の引数を転送用に整える。実在するファイルだけ絶対パスにし、空や不正なパスは元の文字列を返す
	/// </summary>
	/// <param name="arg">stub が受け取った 1 件。前後の引用符は判定前に外す</param>
	/// <returns>本体へ渡す 1 件。ファイルでなければ <paramref name="arg"/> のまま</returns>
	private static string NormalizeOne(string arg)
	{
		// 前後の引用符を外した判定用。空なら元の引数を返す
		string trimmed = arg.Trim('"');
		// 引用符を外すと空になるとき。空文字はファイルではないので受け取った文字列を残す
		if (trimmed.Length == 0)
		{
			return arg;
		}

		try
		{
			// 実在するファイルのときだけ絶対パスにする。無いときは元の文字列を残す
			if (File.Exists(trimmed))
			{
				return Path.GetFullPath(trimmed);
			}
		}
		catch (ArgumentException)
		{
		}
		catch (NotSupportedException)
		{
		}
		catch (PathTooLongException)
		{
		}
		catch (IOException)
		{
		}

		return arg;
	}
}
