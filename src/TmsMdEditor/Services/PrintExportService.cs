using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// 隠し WebView2 で PDF 出力と印刷ダイアログを行う
/// </summary>
internal sealed class PrintExportService : IDisposable
{
	private readonly Control _owner;
	private readonly Logger _logger;
	private WebView2? _view;
	private bool _disposed;

	/// <summary>
	/// 印刷サービスを初期化する
	/// </summary>
	/// <param name="owner">親コントロール</param>
	/// <param name="logger">ロガー</param>
	public PrintExportService(Control owner, Logger logger)
	{
		_owner  = owner;
		_logger = logger;
	}

	/// <summary>
	/// HTML を PDF ファイルへ出力する
	/// </summary>
	/// <param name="html">自己完結 HTML</param>
	/// <param name="filePath">保存先</param>
	/// <returns>結果</returns>
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

			_logger.Info("export", "PDF を出力しました", new Dictionary<string, object?>
			{
				["filePath"] = fullPath,
			});
			return new ExportActionResult { Success = true };
		}
		catch (Exception ex)
		{
			_logger.Error("export", "PDF 出力に失敗しました", new Dictionary<string, object?>
			{
				["error"] = ex.Message,
			});
			return new ExportActionResult { Success = false, Message = ex.Message };
		}
	}

	/// <summary>
	/// HTML を OS の印刷ダイアログで印刷する
	/// </summary>
	/// <param name="html">自己完結 HTML</param>
	/// <returns>結果</returns>
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
			_logger.Error("export", "印刷ダイアログの表示に失敗しました", new Dictionary<string, object?>
			{
				["error"] = ex.Message,
			});
			return new ExportActionResult { Success = false, Message = ex.Message };
		}
	}

	/// <inheritdoc />
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

		string userDataFolder = Path.Combine(
			Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
			Path.GetFileName(AppPaths.AppDataRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)),
			"webview2-print");
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
	/// HTML と同じ見た目で PDF 化するための印刷設定
	/// </summary>
	/// <param name="core">WebView2</param>
	/// <returns>印刷設定</returns>
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
