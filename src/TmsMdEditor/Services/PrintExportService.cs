// ==============================================
// 隠し WebView2 での PDF と印刷
// ==============================================

// 印刷用の WebView2 を親コントロールの外に 1 つ所有する
// HTML は一時フォルダへ書き、仮想ホストから開く。画像は Data URL にせず media へコピーする

using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using TmsMdEditor.Bridge;
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
	/// 印刷用文書を配信する仮想ホスト。編集用の app.tms-mdeditor とは別にする
	/// </summary>
	private const string PrintVirtualHost = "print.tms-mdeditor";

	/// <summary>
	/// 文書と画像の読み込みを待つ上限。秒
	/// </summary>
	private const int LoadTimeoutSeconds = 30;

	/// <summary>
	/// 画像の完了を再確認する間隔。ミリ秒
	/// </summary>
	private const int ImagePollMilliseconds = 50;

	/// <summary>
	/// ローカル画像が読めたかを返すスクリプト。結果は ready、pending、broken のいずれか
	/// </summary>
	private const string ImageReadyScript = """
		(() => {
			const images = Array.from(document.images);
			const localBroken = images.some((img) => {
				const src = img.getAttribute('src') || '';
				if (!src.startsWith('media/') || !img.complete) {
					return false;
				}

				if (src.toLowerCase().endsWith('.svg')) {
					return false;
				}

				return img.naturalWidth === 0;
			});
			if (localBroken) {
				return 'broken';
			}

			return images.every((img) => img.complete) ? 'ready' : 'pending';
		})()
		""";

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
	/// いま仮想ホストへ割り当てている一時フォルダ。印刷ダイアログのあいだ残し、次の出力か破棄で消す
	/// </summary>
	private string? _stagedDirectory;

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
	/// ブリッジ要求から HTML、保存先、画像一覧を読む
	/// </summary>
	/// <param name="paramsElement">html、filePath、media。media が無ければ画像なし</param>
	/// <returns>印刷または PDF へ渡す要求。html が無いときは例外</returns>
	public static PrintDocumentRequest ReadRequest(JsonElement paramsElement)
	{
		string html = paramsElement.GetProperty(BridgeProperty.Html).GetString() ?? string.Empty;
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		return new PrintDocumentRequest
		{
			Html     = html,
			FilePath = filePath,
			Media    = ReadMedia(paramsElement),
		};
	}

	/// <summary>
	/// HTML を A4 の PDF ファイルへ書く。背景色は印刷し、ヘッダーとフッターは付けない
	/// 一時フォルダは書き終えたら消す
	/// </summary>
	/// <param name="request">HTML、保存先、コピーする画像。保存先が空白だけなら失敗</param>
	/// <returns>出力の成否。失敗時は Message に理由を入れ、例外は出さない</returns>
	public async Task<ExportActionResult> PrintToPdfAsync(PrintDocumentRequest request)
	{
		if (string.IsNullOrWhiteSpace(request.FilePath))
		{
			return new ExportActionResult { Success = false, Message = "保存先が指定されていません。" };
		}

		string? loadedDirectory = null;
		try
		{
			CoreWebView2 core = await LoadDocumentAsync(request).ConfigureAwait(true);
			loadedDirectory = _stagedDirectory;
			string fullPath = Path.GetFullPath(request.FilePath);
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
		finally
		{
			if (loadedDirectory is not null)
			{
				ReleaseStagedDirectory();
			}
		}
	}

	/// <summary>
	/// HTML を読み、OS の印刷ダイアログを開く。印刷の完了は待たない
	/// ダイアログが画像を読むあいだ、一時フォルダは残す
	/// </summary>
	/// <param name="request">HTML とコピーする画像。保存先は見ない</param>
	/// <returns>ダイアログを表示できれば成功。失敗時は Message に理由を入れ、例外は出さない</returns>
	public async Task<ExportActionResult> ShowPrintUiAsync(PrintDocumentRequest request)
	{
		bool loaded = false;
		try
		{
			CoreWebView2 core = await LoadDocumentAsync(request).ConfigureAwait(true);
			loaded = true;
			core.ShowPrintUI(CoreWebView2PrintDialogKind.System);
			return new ExportActionResult { Success = true };
		}
		catch (Exception ex)
		{
			if (loaded)
			{
				ReleaseStagedDirectory();
			}

			_logger.Error(LogCategory.Export, "印刷ダイアログの表示に失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Error] = ex.Message,
			});
			return new ExportActionResult { Success = false, Message = ex.Message };
		}
	}

	/// <summary>
	/// 隠し WebView を親から外して破棄し、残っている一時フォルダを消す。2 回目以降は何もしない
	/// </summary>
	public void Dispose()
	{
		if (_disposed)
		{
			return;
		}

		_disposed = true;
		ReleaseStagedDirectory();
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
	/// 一時フォルダを仮想ホストへ割り当て、画像の読み込み完了まで待つ
	/// 成功したら直前の一時フォルダを消す。失敗したら今回のフォルダだけ消す
	/// </summary>
	/// <param name="request">書く HTML とコピーする画像</param>
	/// <returns>文書を開いたコア</returns>
	/// <exception cref="InvalidOperationException">読み込み、またはローカル画像の表示に失敗した</exception>
	/// <exception cref="TimeoutException">制限時間内に読み込みが終わらない</exception>
	private async Task<CoreWebView2> LoadDocumentAsync(PrintDocumentRequest request)
	{
		CoreWebView2 core = await EnsureCoreAsync().ConfigureAwait(true);
		string root = Path.Combine(AppPaths.TempDirectory, "print-documents");
		string directory = PrintDocumentStaging.Create(root, request.Html, request.Media);

		try
		{
			core.SetVirtualHostNameToFolderMapping(
				PrintVirtualHost,
				directory,
				CoreWebView2HostResourceAccessKind.DenyCors);
			await NavigateAsync(core, $"https://{PrintVirtualHost}/{PrintDocumentStaging.DocumentFileName}")
				.ConfigureAwait(true);
			await WaitForImagesAsync(core).ConfigureAwait(true);
		}
		catch
		{
			PrintDocumentStaging.DeleteDirectory(directory);
			RestoreStagedMapping(core);
			throw;
		}

		string? previous = _stagedDirectory;
		_stagedDirectory = directory;
		if (!string.Equals(previous, directory, StringComparison.OrdinalIgnoreCase))
		{
			PrintDocumentStaging.DeleteDirectory(previous);
		}

		return core;
	}

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
		core.Settings.AreDefaultContextMenusEnabled    = false;
		core.Settings.AreBrowserAcceleratorKeysEnabled = false;
		core.Settings.IsStatusBarEnabled               = false;
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
	/// 仮想ホストの URL へ遷移し、完了か失敗まで待つ
	/// </summary>
	/// <param name="core">遷移させる WebView2</param>
	/// <param name="uri">https の仮想ホスト URL</param>
	/// <exception cref="InvalidOperationException">遷移に失敗した</exception>
	/// <exception cref="TimeoutException">制限時間内に遷移が完了しない</exception>
	private static async Task NavigateAsync(CoreWebView2 core, string uri)
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
		core.Navigate(uri);

		using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(LoadTimeoutSeconds));
		using (timeout.Token.Register(() =>
			completed.TrySetException(new TimeoutException("印刷用ページの読み込みがタイムアウトしました。"))))
		{
			await completed.Task.ConfigureAwait(true);
		}
	}

	/// <summary>
	/// 文書内の img が完了するまで待つ。media の画像が壊れていればすぐ失敗にする
	/// </summary>
	/// <param name="core">文書を開いている WebView2</param>
	/// <exception cref="InvalidOperationException">ローカル画像を表示できない</exception>
	/// <exception cref="TimeoutException">制限時間内に画像が完了しない</exception>
	private static async Task WaitForImagesAsync(CoreWebView2 core)
	{
		DateTime deadline = DateTime.UtcNow.AddSeconds(LoadTimeoutSeconds);
		while (true)
		{
			string status = await core.ExecuteScriptAsync(ImageReadyScript).ConfigureAwait(true);
			string token = status.Trim().Trim('"');
			if (string.Equals(token, "ready", StringComparison.Ordinal))
			{
				return;
			}

			if (string.Equals(token, "broken", StringComparison.Ordinal))
			{
				throw new InvalidOperationException("印刷用ページの画像を読み込めませんでした。");
			}

			if (DateTime.UtcNow >= deadline)
			{
				throw new TimeoutException("印刷用ページの画像の読み込みがタイムアウトしました。");
			}

			await Task.Delay(ImagePollMilliseconds).ConfigureAwait(true);
		}
	}

	/// <summary>
	/// 失敗した読み込みのあと、前回の一時フォルダが残っていれば仮想ホストをそこへ戻す
	/// </summary>
	/// <param name="core">割り当てを戻す WebView2</param>
	private void RestoreStagedMapping(CoreWebView2 core)
	{
		if (string.IsNullOrWhiteSpace(_stagedDirectory) || !Directory.Exists(_stagedDirectory))
		{
			return;
		}

		core.SetVirtualHostNameToFolderMapping(
			PrintVirtualHost,
			_stagedDirectory,
			CoreWebView2HostResourceAccessKind.DenyCors);
	}

	/// <summary>
	/// いまの一時フォルダを消し、参照を外す
	/// </summary>
	private void ReleaseStagedDirectory()
	{
		PrintDocumentStaging.DeleteDirectory(_stagedDirectory);
		_stagedDirectory = null;
	}

	/// <summary>
	/// media 配列を読む。配列でなければ空
	/// </summary>
	/// <param name="paramsElement">media を含む要求。プロパティが無くても空で戻る</param>
	/// <returns>名前とコピー元。欠けた要素は空文字のまま後段で失敗させる</returns>
	private static List<PrintMediaFile> ReadMedia(JsonElement paramsElement)
	{
		var media = new List<PrintMediaFile>();
		if (!paramsElement.TryGetProperty(BridgeProperty.Media, out JsonElement mediaElement)
			|| mediaElement.ValueKind != JsonValueKind.Array)
		{
			return media;
		}

		foreach (JsonElement item in mediaElement.EnumerateArray())
		{
			if (item.ValueKind != JsonValueKind.Object)
			{
				continue;
			}

			string name = item.TryGetProperty(BridgeProperty.Name, out JsonElement nameElement)
				? nameElement.GetString() ?? string.Empty
				: string.Empty;
			string sourcePath = item.TryGetProperty(BridgeProperty.SourcePath, out JsonElement sourceElement)
				? sourceElement.GetString() ?? string.Empty
				: string.Empty;
			media.Add(new PrintMediaFile
			{
				Name       = name,
				SourcePath = sourcePath,
			});
		}

		return media;
	}
}
