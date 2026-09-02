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
	/// 本体へ転送する引数を返す。存在するファイルは絶対パスにする。
	/// </summary>
	/// <param name="args">stub が受け取った引数</param>
	/// <returns>本体へ渡す引数</returns>
	public static IReadOnlyList<string> Normalize(IReadOnlyList<string> args)
	{
		var forwarded = new List<string>(args.Count);
		foreach (string arg in args)
		{
			forwarded.Add(NormalizeOne(arg));
		}

		return forwarded;
	}

	/// <summary>
	/// 1件の引数を転送用に整える
	/// </summary>
	/// <param name="arg">元の引数</param>
	/// <returns>転送する値</returns>
	private static string NormalizeOne(string arg)
	{
		string trimmed = arg.Trim('"');
		if (trimmed.Length == 0)
		{
			return arg;
		}

		try
		{
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
