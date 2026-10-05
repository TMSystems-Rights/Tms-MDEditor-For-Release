using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// Web 層からの JSON-RPC 風要求をディスパッチする
/// </summary>
internal sealed class BridgeRouter
{
	private readonly AppContext _appContext;
	private readonly ConfigApi _configApi;
	private readonly FileApi _fileApi;
	private readonly RecentApi _recentApi;
	private readonly WindowApi _windowApi;
	private readonly ShellApi _shellApi;
	private readonly AppApi _appApi;
	private readonly ClipboardApi _clipboardApi;
	private readonly CssSnippetService _cssSnippetService;
	private readonly UpdateApi _updateApi;
	private readonly SessionApi _sessionApi;
	private readonly PrintExportService _printExportService;

	/// <summary>
	/// ブリッジルーターを初期化する
	/// </summary>
	/// <param name="mainForm">メインフォーム</param>
	/// <param name="appContext">アプリコンテキスト</param>
	/// <param name="isSessionOwner">セッション保存の所有者か</param>
	/// <param name="printExportService">印刷・PDF サービス</param>
	public BridgeRouter(MainForm mainForm, AppContext appContext, bool isSessionOwner, PrintExportService printExportService)
	{
		_appContext = appContext;
		_printExportService = printExportService;
		_configApi  = new ConfigApi(appContext, mainForm.RefreshSettingsMenuShortcutDisplays);
		_fileApi    = new FileApi(appContext);
		_recentApi  = new RecentApi(mainForm, appContext);
		_windowApi  = new WindowApi(mainForm);
		_shellApi   = new ShellApi(appContext);
		_appApi     = new AppApi(mainForm);
		_clipboardApi = new ClipboardApi(appContext);
		_cssSnippetService = new CssSnippetService(appContext.ConfigStore, appContext.Logger);
		_updateApi  = new UpdateApi(mainForm, appContext);
		_sessionApi = new SessionApi(appContext.SessionStore, isSessionOwner);
	}

	/// <summary>
	/// Web 層からの要求を処理する
	/// </summary>
	/// <param name="request">要求 JSON</param>
	/// <returns>応答 JSON。通知のみの場合は null</returns>
	public async Task<string?> HandleRequestAsync(JsonElement request)
	{
		string? id   = request.TryGetProperty(BridgeProperty.Id, out JsonElement idElement) ? idElement.GetString() : null;
		string method  = request.GetProperty(BridgeProperty.Method).GetString() ?? string.Empty;
		JsonElement paramsElement = request.TryGetProperty(BridgeProperty.Params, out JsonElement rawParams)
			? rawParams
			: default;

		try
		{
			object? result = method switch
			{
				BridgeMethod.Ping              => HandlePing(paramsElement),
				BridgeMethod.LogWrite          => HandleLogWrite(paramsElement),
				BridgeMethod.ConfigGet         => _configApi.GetConfig(),
				BridgeMethod.ConfigUpdate      => _configApi.Update(paramsElement),
				BridgeMethod.ConfigResetItem   => _configApi.ResetItem(paramsElement),
				BridgeMethod.ConfigResetAll    => _configApi.ResetAll(),
				BridgeMethod.ConfigGetDataDir  => _configApi.GetDataDir(),
				BridgeMethod.ConfigChangeDataDir => paramsElement.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
					? _configApi.ChangeDataDirWithDialog()
					: _configApi.ChangeDataDir(paramsElement),
				BridgeMethod.CssSnippetsList       => _cssSnippetService.List(),
				BridgeMethod.CssSnippetsOpenFolder => _shellApi.OpenFolder(_cssSnippetService.GetDirectoryPath()),
				BridgeMethod.FileOpen              => _fileApi.Open(paramsElement),
				BridgeMethod.FileOpenWithEncoding  => _fileApi.OpenWithEncoding(paramsElement),
				BridgeMethod.FileOpenDialog        => _fileApi.OpenDialog(),
				BridgeMethod.FileSave              => _fileApi.Save(paramsElement),
				BridgeMethod.FileSaveAsDialog      => paramsElement.ValueKind == JsonValueKind.Undefined
					? _fileApi.SaveAsDialog(default)
					: _fileApi.SaveAsDialog(paramsElement),
				BridgeMethod.FileExportDialog      => _fileApi.ExportDialog(paramsElement),
				BridgeMethod.FileWriteUtf8         => _fileApi.WriteUtf8(paramsElement),
				BridgeMethod.ExportPrintToPdf      => await _printExportService.PrintToPdfAsync(
					paramsElement.GetProperty(BridgeProperty.Html).GetString() ?? string.Empty,
					paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement pdfPath) ? pdfPath.GetString() ?? string.Empty : string.Empty)
					.ConfigureAwait(true),
				BridgeMethod.ExportShowPrintUi => await _printExportService.ShowPrintUiAsync(
					paramsElement.GetProperty(BridgeProperty.Html).GetString() ?? string.Empty)
					.ConfigureAwait(true),
				BridgeMethod.FileReadImageAsDataUrl => paramsElement.ValueKind == JsonValueKind.Undefined
					? _fileApi.ReadImageAsDataUrl(default)
					: _fileApi.ReadImageAsDataUrl(paramsElement),
				BridgeMethod.RecentList              => _recentApi.List(),
				BridgeMethod.RecentAdd               => _recentApi.Add(paramsElement),
				BridgeMethod.RecentRemove            => _recentApi.Remove(paramsElement),
				BridgeMethod.WindowSetTitle          => _windowApi.SetTitle(paramsElement),
				BridgeMethod.WindowDetachTab         => _windowApi.DetachTab(paramsElement),
				BridgeMethod.ShellShowInFolder       => _shellApi.ShowInFolder(paramsElement),
				BridgeMethod.ShellOpenExternal       => _shellApi.OpenExternal(paramsElement),
				BridgeMethod.AppReportCloseReady     => _appApi.ReportCloseReady(paramsElement),
				BridgeMethod.SessionSave             => _sessionApi.Save(paramsElement),
				BridgeMethod.NoteViewPositionsSave   => _appContext.NoteViewPositionStore.Save(paramsElement),
				BridgeMethod.UiDismissMenus          => _appApi.DismissMenus(),
				BridgeMethod.ClipboardReadText       => _clipboardApi.ReadText(),
				BridgeMethod.ClipboardWriteText      => _clipboardApi.WriteText(paramsElement),
				BridgeMethod.ClipboardPasteForEditor => _clipboardApi.PasteForEditor(paramsElement),
				BridgeMethod.ShellPickFolder         => _shellApi.PickFolder(),
				BridgeMethod.UpdateCheck             => await _updateApi.CheckAsync().ConfigureAwait(false),
				BridgeMethod.UpdateDownload          => await _updateApi.DownloadAsync().ConfigureAwait(false),
				BridgeMethod.UpdateCancelDownload    => _updateApi.CancelDownload(),
				BridgeMethod.UpdateSkipVersion       => _updateApi.SkipVersion(paramsElement),
				BridgeMethod.UpdateApplyNow          => _updateApi.ApplyNow(),
				BridgeMethod.UpdateOpenOfficialPage  => _updateApi.OpenOfficialPage(),
				_ => throw new InvalidOperationException($"未対応のメソッドです: {method}"),
			};

			if (id is null)
			{
				return null;
			}

			string response = JsonSerializer.Serialize(new
			{
				id,
				result,
			}, BridgeJson.Options);

			return response;
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error(LogCategory.Bridge, "ブリッジ要求の処理に失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Method] = method,
				[LogProperty.Error]  = ex.Message,
			});

			if (id is null)
			{
				return null;
			}

			string errorResponse = JsonSerializer.Serialize(new
			{
				id,
				error = new { message = ex.Message },
			}, BridgeJson.Options);

			return errorResponse;
		}
	}

	/// <summary>起動時の更新チェックを開始する</summary>
	public void StartStartupUpdateCheck() => _updateApi.StartStartupCheck();

	/// <summary>
	/// 疎通確認要求を処理する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>応答ペイロード</returns>
	private static object HandlePing(JsonElement paramsElement)
	{
		string message = "pong";

		if (paramsElement.ValueKind != JsonValueKind.Undefined
			&& paramsElement.TryGetProperty(BridgeProperty.Message, out JsonElement messageElement))
		{
			message = messageElement.GetString() ?? message;
		}

		return new
		{
			message,
			now = DateTimeOffset.Now.ToString("o"),
		};
	}

	/// <summary>
	/// Web 層ログ転送要求を処理する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>空の成功応答</returns>
	private object HandleLogWrite(JsonElement paramsElement)
	{
		if (paramsElement.ValueKind == JsonValueKind.Undefined)
		{
			return new { ok = true };
		}

		string level   = paramsElement.TryGetProperty(BridgeProperty.Level, out JsonElement levelElement) ? levelElement.GetString() ?? "INFO" : "INFO";
		string source  = paramsElement.TryGetProperty(BridgeProperty.Source, out JsonElement sourceElement) ? sourceElement.GetString() ?? "web" : "web";
		string message = paramsElement.TryGetProperty(BridgeProperty.Message, out JsonElement messageElement) ? messageElement.GetString() ?? string.Empty : string.Empty;

		switch (level.ToUpperInvariant())
		{
		case "ERROR":
			_appContext.Logger.Error(source, message);
			break;
		case "WARN":
			_appContext.Logger.Warn(source, message);
			break;
		case "DEBUG":
			_appContext.Logger.Debug(source, message);
			break;
		default:
			_appContext.Logger.Info(source, message);
			break;
		}

		return new { ok = true };
	}
}
