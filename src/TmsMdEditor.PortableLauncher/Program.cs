// ==============================================
// ポータブル ZIP の起動 stub
// ==============================================

// ZIP を展開した直下に置き、隣の app フォルダにある本体だけを起動する
// 本体が無い、または起動できないときはエラーダイアログを出して 1 で戻る

using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TmsMdEditor.PortableLauncher;

/// <summary>
/// 受け取った引数を本体へ渡し、自身は本体の終了を待たずに戻る
/// ウィンドウや設定は持たない
/// </summary>
internal static partial class Program
{
	/// <summary>
	/// 本体 exe を置くフォルダ名。ZIP 直下のこの名前だけを探す
	/// </summary>
	private const string AppFolderName = "app";

	/// <summary>
	/// 起動する本体のファイル名。AppFolderName の直下に無いと起動しない
	/// </summary>
	private const string AppExeFileName = "TmsMdEditor.exe";

	/// <summary>
	/// 起動失敗ダイアログのタイトル。本体ウィンドウと同じ表示名
	/// </summary>
	private const string WindowTitle = "TMS-MDEditor";

	/// <summary>
	/// MessageBoxW のボタン指定。OK のみ
	/// </summary>
	private const uint MbOk = 0x00000000;

	/// <summary>
	/// MessageBoxW のアイコン指定。エラー。MbOk と合わせて渡す
	/// </summary>
	private const uint MbIconError = 0x00000010;

	/// <summary>
	/// app\TmsMdEditor.exe を作業フォルダ付きで起動し、引数を絶対パスへ整えて渡す
	/// 本体が無い、またはプロセスを作れないときはダイアログを出して 1 を返す
	/// </summary>
	/// <param name="args">エクスプローラやコマンドラインから渡された引数。空でも本体は起動する</param>
	/// <returns>起動できれば 0。本体が無い、または起動に失敗したときは 1</returns>
	private static int Main(string[] args)
	{
		// stub 自身の配置ディレクトリ。ZIP を展開した直下
		string baseDirectory = AppContext.BaseDirectory;
		// 本体を置く app フォルダ。ここに exe が無いと起動しない
		string appDirectory = Path.Combine(baseDirectory, AppFolderName);
		// 起動する本体の絶対パス。ファイルが無いときは 1 で戻る
		string appExePath = Path.Combine(appDirectory, AppExeFileName);

		// 本体 exe が無いとき。ダイアログを出して 1 で戻る
		if (!File.Exists(appExePath))
		{
			ShowError("本体が見つかりません。フォルダごと移動してください。\n" + AppFolderName + "\\" + AppExeFileName);
			return 1;
		}

		// 作業フォルダを app にした起動情報。引数は存在するファイルだけ絶対パスにして足す
		ProcessStartInfo startInfo = new()
		{
			// 起動する本体の絶対パス
			FileName = appExePath,
			// 本体のカレント。相対パスの解決基準になる
			WorkingDirectory = appDirectory,
			// false ならシェルを介さず起動し、作業フォルダが本体に渡る
			UseShellExecute = false,
		};

		foreach (string argument in LaunchArguments.Normalize(args))
		{
			startInfo.ArgumentList.Add(argument);
		}

		try
		{
			// 起動した本体。null はプロセスを作れなかったときで、1 で戻る
			using Process? process = Process.Start(startInfo);
			// プロセスを作れなかったとき。例外にならない失敗はここで 1 を返す
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
	/// 起動失敗をモーダルダイアログで出す。閉じるまで stub は戻らない
	/// 表示できなくても例外は出さず、呼び出し側が終了コードを返す
	/// </summary>
	/// <param name="message">ダイアログ本文。空でもウィンドウは出す</param>
	private static void ShowError(string message)
	{
		_ = MessageBoxW(nint.Zero, message, WindowTitle, MbOk | MbIconError);
	}

	/// <summary>
	/// user32 の MessageBoxW。親ウィンドウを持たない stub からエラーを出す
	/// </summary>
	/// <param name="hWnd">オーナー。常に 0 を渡し、親を持たない</param>
	/// <param name="lpText">本文</param>
	/// <param name="lpCaption">タイトルバー。WindowTitle を渡す</param>
	/// <param name="uType">ボタンとアイコン。MbOk と MbIconError の和を渡す</param>
	/// <returns>押されたボタンの識別子。呼び出し側は見ない</returns>
	[LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16, EntryPoint = "MessageBoxW")]
	private static partial int MessageBoxW(nint hWnd, string lpText, string lpCaption, uint uType);
}
