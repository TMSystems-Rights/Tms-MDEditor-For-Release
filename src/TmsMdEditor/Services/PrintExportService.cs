// ==============================================
// 隠し WebView2 での PDF と印刷
// ==============================================

// 印刷用の WebView2 を親コントロールの外に 1 つ所有する
// 呼び出し元は自己完結 HTML を渡し、画面のエディタ用 WebView とはユーザーデータを分けておく

using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// 画面外の WebView2 で HTML を PDF へ書くか、OS の印刷ダイアログを開く
/// 失敗は結果のメッセージで返し、WebView は最初の要求まで作らない
/// </summary>
internal sealed class PrintExportService : IDisposable
{
	// ==============================================
	// 隠し WebView
	// ==============================================

	/// <summary>
	/// 隠し WebView を載せる親。このサービスは親を破棄しない
	/// </summary>
	private readonly Control _owner;

	/// <summary>
	/// PDF と印刷の失敗を記録するログ。ダイアログの成否は結果でも返す
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// 画面外に置く印刷用 WebView。未作成、または破棄後は null。2 回目以降の要求で再利用する
	/// </summary>
	private WebView2? _view;

	/// <summary>
	/// Dispose を二重に実行しない印。true のあと WebView は外してある
	/// </summary>
	private bool _disposed;

	/// <summary>
	/// 親とログを受け取る。WebView は最初の PDF または印刷まで作らない
	/// </summary>
	/// <param name="owner">隠し WebView を追加する親コントロール</param>
	/// <param name="logger">出力失敗を記録するログ</param>
	public PrintExportService(Control owner, Logger logger)
	{
		_owner  = owner;
		_logger = logger;
	}

	// ==============================================
	// PDF と印刷
	// ==============================================

	/// <summary>
	/// HTML を A4 の PDF ファイルへ書く。背景色は印刷し、ヘッダーとフッターは付けない
	/// </summary>
	/// <param name="html">NavigateToString へ渡す自己完結 HTML</param>
	/// <param name="filePath">PDF の保存先。空白だけなら失敗。親ディレクトリが無ければ作る</param>
	/// <returns>出力の成否。失敗時は Message に理由を入れ、例外は出さない</returns>
	public async Task<ExportActionResult> PrintToPdfAsync(string html, string filePath)
	{
		if (string.IsNullOrWhiteSpace(filePath))
		{
			return new ExportActionResult { Success = false, Message = "保存先が指定されていません。" };
		}

		try
		{
			CoreWebView2 core = await EnsureCoreAsync().ConfigureAwait(true);
			await NavigateHtmlAsync(core, html).ConfigureAwait(true);
			string fullPath = Path.GetFullPath(filePath);
			string? directory = Path.GetDirectoryName(fullPath);
			if (!string.IsNullOrWhiteSpace(directory))
			{
				Directory.CreateDirectory(directory);
			}

			bool printed = await core.PrintToPdfAsync(fullPath, CreateExportPrintSettings(core)).ConfigureAwait(true);
			if (!printed)
			{
				return new ExportActionResult { Success = false, Message = "PDF の出力に失敗しました。" };
			}

			_logger.Info(LogCategory.Export, "PDF を出力しました", new Dictionary<string, object?>
			{
				[LogProperty.FilePath] = fullPath,
			});
			return new ExportActionResult { Success = true };
		}
		catch (Exception ex)
		{
			_logger.Error(LogCategory.Export, "PDF 出力に失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Error] = ex.Message,
			});
			return new ExportActionResult { Success = false, Message = ex.Message };
		}
	}

	/// <summary>
	/// HTML を読み、OS の印刷ダイアログを開く。印刷の完了は待たない
	/// </summary>
	/// <param name="html">NavigateToString へ渡す自己完結 HTML</param>
	/// <returns>ダイアログを表示できれば成功。失敗時は Message に理由を入れ、例外は出さない</returns>
	public async Task<ExportActionResult> ShowPrintUiAsync(string html)
	{
		try
		{
			CoreWebView2 core = await EnsureCoreAsync().ConfigureAwait(true);
			await NavigateHtmlAsync(core, html).ConfigureAwait(true);
			core.ShowPrintUI(CoreWebView2PrintDialogKind.System);
			return new ExportActionResult { Success = true };
		}
		catch (Exception ex)
		{
			_logger.Error(LogCategory.Export, "印刷ダイアログの表示に失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Error] = ex.Message,
			});
			return new ExportActionResult { Success = false, Message = ex.Message };
		}
	}

	/// <summary>
	/// 隠し WebView を親から外して破棄する。2 回目以降は何もしない
	/// </summary>
	public void Dispose()
	{
		if (_disposed)
		{
			return;
		}

		_disposed = true;
		if (_view is not null)
		{
			_owner.Controls.Remove(_view);
			_view.Dispose();
			_view = null;
		}
	}

	// ==============================================
	// ページの読み込み
	// ==============================================

	/// <summary>
	/// 印刷用 WebView2 を画面外に 1 つ作り、専用のユーザーデータフォルダで初期化する。既存があればそれを返す
	/// </summary>
	/// <returns>初期化済みのコア。2 回目以降は同じインスタンス</returns>
	/// <exception cref="InvalidOperationException">コアを初期化できない</exception>
	private async Task<CoreWebView2> EnsureCoreAsync()
	{
		if (_view?.CoreWebView2 is not null)
		{
			return _view.CoreWebView2;
		}

		_view = new WebView2
		{
			Visible = false,
			Width   = 794,
			Height  = 1123,
			Left    = -2000,
			Top     = -2000,
		};
		_owner.Controls.Add(_view);

		string userDataFolder = AppPaths.WebView2PrintUserDataDirectory;
		Directory.CreateDirectory(userDataFolder);

		CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder)
			.ConfigureAwait(true);
		await _view.EnsureCoreWebView2Async(environment).ConfigureAwait(true);

		CoreWebView2 core = _view.CoreWebView2
			?? throw new InvalidOperationException("印刷用 WebView2 を初期化できませんでした。");
		core.Settings.AreDefaultContextMenusEnabled     = false;
		core.Settings.AreBrowserAcceleratorKeysEnabled = false;
		core.Settings.IsStatusBarEnabled              = false;
		return core;
	}

	/// <summary>
	/// HTML と同じ見た目で PDF 化するため、背景を印刷し、余白を mm からインチへ換算した A4 縦の設定を作る
	/// </summary>
	/// <param name="core">印刷設定を作る WebView2。環境はこれのものを使う</param>
	/// <returns>背景印刷あり、ヘッダーとフッター無し、A4 縦の設定。余白は上 16mm、左右 14mm</returns>
	private static CoreWebView2PrintSettings CreateExportPrintSettings(CoreWebView2 core)
	{
		CoreWebView2PrintSettings settings = core.Environment.CreatePrintSettings();
		settings.ShouldPrintBackgrounds     = true;
		settings.ShouldPrintHeaderAndFooter = false;
		settings.ColorMode                  = CoreWebView2PrintColorMode.Color;
		settings.Orientation                = CoreWebView2PrintOrientation.Portrait;
		settings.PageWidth                  = 8.27;
		settings.PageHeight                 = 11.69;
		settings.MarginTop                  = 16.0 / 25.4;
		settings.MarginBottom               = 16.0 / 25.4;
		settings.MarginLeft                 = 14.0 / 25.4;
		settings.MarginRight                = 14.0 / 25.4;
		return settings;
	}

	/// <summary>
	/// HTML 文字列へ遷移し、完了か失敗まで待つ。30 秒を超えたら失敗にする
	/// </summary>
	/// <param name="core">遷移させる WebView2</param>
	/// <param name="html">NavigateToString へ渡す HTML</param>
	/// <exception cref="InvalidOperationException">遷移に失敗した</exception>
	/// <exception cref="TimeoutException">30 秒以内に遷移が完了しない</exception>
	private static async Task NavigateHtmlAsync(CoreWebView2 core, string html)
	{
		TaskCompletionSource<bool> completed = new(TaskCreationOptions.RunContinuationsAsynchronously);

		void Handler(object? sender, CoreWebView2NavigationCompletedEventArgs args)
		{
			core.NavigationCompleted -= Handler;
			if (args.IsSuccess)
			{
				completed.TrySetResult(true);
				return;
			}

			completed.TrySetException(new InvalidOperationException("印刷用ページの読み込みに失敗しました。"));
		}

		core.NavigationCompleted += Handler;
		core.NavigateToString(html);

		using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(30));
		using (timeout.Token.Register(() =>
			completed.TrySetException(new TimeoutException("印刷用ページの読み込みがタイムアウトしました。"))))
		{
			await completed.Task.ConfigureAwait(true);
		}
	}
}
