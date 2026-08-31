using System.Text;
using TmsMdEditor.Services;

namespace TmsMdEditor;

internal static class Program
{
	/// <summary>
	/// アプリケーションのエントリポイント
	/// </summary>
	/// <param name="args">コマンドライン引数</param>
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
	/// <param name="logger">ロガー</param>
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
	/// 未処理例外の詳細をログへ記録する
	/// </summary>
	/// <param name="logger">ロガー</param>
	/// <param name="source">発生元</param>
	/// <param name="exception">例外</param>
	private static void LogUnhandledException(Logger logger, string source, Exception exception)
	{
		try
		{
			logger.Error("unhandled", "未処理例外を検出しました", new Dictionary<string, object?>
			{
				["source"]    = source,
				["exception"] = exception.ToString(),
			});
		}
		catch
		{
			// 例外処理中のログ失敗は、元の例外を隠さない。
		}
	}
}
