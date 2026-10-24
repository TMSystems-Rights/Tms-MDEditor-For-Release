// ==============================================
// 主ウィンドウを表示するプロセスを起動する
// ==============================================

// 単一起動の判定と、主ウィンドウを表示するプロセスの寿命はここが境界になる
// 設定の読込に失敗しても起動は続け、未処理例外は日次ログへ残す

using System.Text;
using TmsMdEditor.Services;

namespace TmsMdEditor;

/// <summary>
/// 起動手順を置く静的クラス。インスタンスは作らない
/// 副プロセスはファイル引数を主プロセスへ渡して戻り、主プロセスはフォームが閉じるまで残る
/// </summary>
internal static class Program
{
	/// <summary>
	/// 文字コード、高 DPI、ポータブル配置をプロセスへ適用し、主ウィンドウを表示する
	/// 既に主プロセスがあり single-instance のときは引数を転送して戻り、転送失敗時は警告を出して終了する
	/// </summary>
	/// <param name="args">起動時のコマンドライン。ファイルパスと --force-new-window を含む。空でも起動する</param>
	[STAThread]
	private static void Main(string[] args)
	{
		Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
		Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
		Application.EnableVisualStyles();
		Application.SetCompatibleTextRenderingDefault(false);

		PortableRuntime.ApplyIfNeeded();
		AppUserModelId.Apply();

		using var appContext = new AppContext();
		appContext.Initialize();
		RegisterUnhandledExceptionLogging(appContext.Logger);

		using var singleInstanceManager = new SingleInstanceManager(appContext.Logger);
		bool isPrimaryInstance = singleInstanceManager.TryBecomePrimary();
		bool forceNewWindow = StartupArguments.IsForceNewWindow(args);
		if (!isPrimaryInstance && !forceNewWindow && appContext.Config.Settings.InstanceMode == "single-instance")
		{
			if (!singleInstanceManager.TryForwardToPrimary(args))
			{
				MessageBox.Show(
					"既に起動している TMS-MDEditor へファイルを転送できませんでした。\n既存のウィンドウを確認してから、もう一度開いてください。",
					"TMS-MDEditor",
					MessageBoxButtons.OK,
					MessageBoxIcon.Warning);
			}

			return;
		}

		using var mainForm = new MainForm(args, appContext, isSessionOwner: isPrimaryInstance);
		if (isPrimaryInstance)
		{
			singleInstanceManager.StartListening(mainForm.ReceiveExternalOpenRequest);
		}

		Application.Run(mainForm);
	}

	/// <summary>
	/// C# 側で捕捉されなかった例外を日次ログへ記録する
	/// </summary>
	/// <param name="logger">日次ログへ書くロガー。null は渡さない。登録はプロセス終了まで残る</param>
	private static void RegisterUnhandledExceptionLogging(Logger logger)
	{
		Application.ThreadException += (_, eventArgs) => LogUnhandledException(logger, "winforms-thread", eventArgs.Exception);
		AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) => LogUnhandledException(logger, "app-domain", eventArgs.ExceptionObject as Exception ?? new Exception(eventArgs.ExceptionObject?.ToString()));
		TaskScheduler.UnobservedTaskException += (_, eventArgs) =>
		{
			LogUnhandledException(logger, "task", eventArgs.Exception);
			eventArgs.SetObserved();
		};
	}

	/// <summary>
	/// 未処理例外の発生元と本文を 1 件のエラーログにする
	/// ログ書き込みに失敗しても例外は出さず、呼び出し元の処理は続ける
	/// </summary>
	/// <param name="logger">書き込み先。失敗しても呼び出し元へは投げ直さない</param>
	/// <param name="source">発生元の区分。winforms-thread、app-domain、task を渡す</param>
	/// <param name="exception">記録する例外。null は渡さない</param>
	private static void LogUnhandledException(Logger logger, string source, Exception exception)
	{
		try
		{
			logger.Error(LogCategory.Unhandled, "未処理例外を検出しました", new Dictionary<string, object?>
			{
				[LogProperty.Source]    = source,
				[LogProperty.Exception] = exception.ToString(),
			});
		}
		catch
		{
			// 例外処理中のログ失敗は、元の例外を隠さない
		}
	}
}
