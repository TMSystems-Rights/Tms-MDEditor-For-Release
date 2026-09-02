using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TmsMdEditor.PortableLauncher;

/// <summary>
/// ポータブル ZIP 直下から app\TmsMdEditor.exe を起動する
/// </summary>
internal static partial class Program
{
	private const string AppFolderName = "app";
	private const string AppExeFileName = "TmsMdEditor.exe";
	private const string WindowTitle = "TMS-MDEditor";
	private const uint MbOk = 0x00000000;
	private const uint MbIconError = 0x00000010;

	/// <summary>
	/// 本体 exe を起動する
	/// </summary>
	/// <param name="args">エクスプローラやコマンドラインから渡された引数</param>
	/// <returns>成功なら 0</returns>
	private static int Main(string[] args)
	{
		string baseDirectory = AppContext.BaseDirectory;
		string appDirectory = Path.Combine(baseDirectory, AppFolderName);
		string appExePath = Path.Combine(appDirectory, AppExeFileName);

		if (!File.Exists(appExePath))
		{
			ShowError("本体が見つかりません。フォルダごと移動してください。\n" + AppFolderName + "\\" + AppExeFileName);
			return 1;
		}

		ProcessStartInfo startInfo = new()
		{
			FileName = appExePath,
			WorkingDirectory = appDirectory,
			UseShellExecute = false,
		};

		foreach (string argument in LaunchArguments.Normalize(args))
		{
			startInfo.ArgumentList.Add(argument);
		}

		try
		{
			using Process? process = Process.Start(startInfo);
			if (process is null)
			{
				ShowError("本体を起動できませんでした。");
				return 1;
			}
		}
		catch (Exception exception)
		{
			ShowError("本体を起動できませんでした。\n" + exception.Message);
			return 1;
		}

		return 0;
	}

	/// <summary>
	/// エラーを表示する
	/// </summary>
	/// <param name="message">本文</param>
	private static void ShowError(string message)
	{
		_ = MessageBoxW(nint.Zero, message, WindowTitle, MbOk | MbIconError);
	}

	[LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16, EntryPoint = "MessageBoxW")]
	private static partial int MessageBoxW(nint hWnd, string lpText, string lpCaption, uint uType);
}
