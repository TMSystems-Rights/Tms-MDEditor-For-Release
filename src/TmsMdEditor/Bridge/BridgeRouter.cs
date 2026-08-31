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
		_clipboardApi = new ClipboardApi();
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
		string? id   = request.TryGetProperty("id", out JsonElement idElement) ? idElement.GetString() : null;
		string method  = request.GetProperty("method").GetString() ?? string.Empty;
		JsonElement paramsElement = request.TryGetProperty("params", out JsonElement rawParams)
			? rawParams
			: default;

		try
		{
			object? result = method switch
			{
				"ping"              => HandlePing(paramsElement),
				"log:write"         => HandleLogWrite(paramsElement),
				"config:get"        => _configApi.GetConfig(),
				"config:update"     => _configApi.Update(paramsElement),
				"config:resetItem"  => _configApi.ResetItem(paramsElement),
				"config:resetAll"   => _configApi.ResetAll(),
				"config:getDataDir" => _configApi.GetDataDir(),
				"config:changeDataDir" => paramsElement.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
					? _configApi.ChangeDataDirWithDialog()
					: _configApi.ChangeDataDir(paramsElement),
				"cssSnippets:list" => _cssSnippetService.List(),
				"cssSnippets:openFolder" => _shellApi.OpenFolder(_cssSnippetService.GetDirectoryPath()),
				"file:open"       => _fileApi.Open(paramsElement),
				"file:openWithEncoding" => _fileApi.OpenWithEncoding(paramsElement),
				"file:openDialog" => _fileApi.OpenDialog(),
				"file:save"       => _fileApi.Save(paramsElement),
				"file:saveAsDialog" => paramsElement.ValueKind == JsonValueKind.Undefined
					? _fileApi.SaveAsDialog(default)
					: _fileApi.SaveAsDialog(paramsElement),
				"file:exportDialog" => _fileApi.ExportDialog(paramsElement),
				"file:writeUtf8" => _fileApi.WriteUtf8(paramsElement),
				"export:printToPdf" => await _printExportService.PrintToPdfAsync(
					paramsElement.GetProperty("html").GetString() ?? string.Empty,
					paramsElement.TryGetProperty("filePath", out JsonElement pdfPath) ? pdfPath.GetString() ?? string.Empty : string.Empty)
					.ConfigureAwait(true),
				"export:showPrintUI" => await _printExportService.ShowPrintUiAsync(
					paramsElement.GetProperty("html").GetString() ?? string.Empty)
					.ConfigureAwait(true),
				"file:readImageAsDataUrl" => paramsElement.ValueKind == JsonValueKind.Undefined
					? _fileApi.ReadImageAsDataUrl(default)
					: _fileApi.ReadImageAsDataUrl(paramsElement),
				"recent:list"     => _recentApi.List(),
				"recent:add"      => _recentApi.Add(paramsElement),
				"recent:remove"   => _recentApi.Remove(paramsElement),
				"window:setTitle" => _windowApi.SetTitle(paramsElement),
				"window:detachTab" => _windowApi.DetachTab(paramsElement),
				"shell:showInFolder" => _shellApi.ShowInFolder(paramsElement),
				"shell:openExternal" => _shellApi.OpenExternal(paramsElement),
				"app:reportCloseReady" => _appApi.ReportCloseReady(paramsElement),
				"session:save"          => _sessionApi.Save(paramsElement),
				"ui:dismissMenus"      => _appApi.DismissMenus(),
				"clipboard:readText"   => _clipboardApi.ReadText(),
				"clipboard:writeText"  => _clipboardApi.WriteText(paramsElement),
				"update:check"         => await _updateApi.CheckAsync().ConfigureAwait(false),
				"update:download"      => await _updateApi.DownloadAsync().ConfigureAwait(false),
				"update:cancelDownload" => _updateApi.CancelDownload(),
				"update:skipVersion"   => _updateApi.SkipVersion(paramsElement),
				"update:applyNow"      => _updateApi.ApplyNow(),
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
			_appContext.Logger.Error("bridge", "ブリッジ要求の処理に失敗しました", new Dictionary<string, object?>
			{
				["method"] = method,
				["error"]  = ex.Message,
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
			&& paramsElement.TryGetProperty("message", out JsonElement messageElement))
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

		string level   = paramsElement.TryGetProperty("level", out JsonElement levelElement) ? levelElement.GetString() ?? "INFO" : "INFO";
		string source  = paramsElement.TryGetProperty("source", out JsonElement sourceElement) ? sourceElement.GetString() ?? "web" : "web";
		string message = paramsElement.TryGetProperty("message", out JsonElement messageElement) ? messageElement.GetString() ?? string.Empty : string.Empty;

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
