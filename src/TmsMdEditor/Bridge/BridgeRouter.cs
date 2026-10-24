// ==============================================
// ブリッジ要求を API へ振り分ける
// ==============================================

// method 名で各 API へ振り分け、id があるときだけ JSON 応答を返す
// 処理中の例外はログへ残し、呼び出し元へは error 応答として返す。未対応の method も同様

using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// Web 層からの JSON 要求を、設定、ファイル、更新などの API へ振り分ける
/// 応答の往復は MainForm が行い、このクラスはウィンドウを直接閉じない
/// </summary>
internal sealed class BridgeRouter
{
	/// <summary>
	/// 設定、ログ、ノート位置の参照先。ルーターより長く生き、ここからは破棄しない
	/// </summary>
	private readonly AppContext _appContext;

	/// <summary>
	/// config:* の取得と保存。コンストラクタで作り、要求のたびに使い回す
	/// </summary>
	private readonly ConfigApi _configApi;

	/// <summary>
	/// file:* の読み書きとダイアログ。コンストラクタで作り、要求のたびに使い回す
	/// </summary>
	private readonly FileApi _fileApi;

	/// <summary>
	/// recent:* の一覧更新。保存成功時にメニューも更新する
	/// </summary>
	private readonly RecentApi _recentApi;

	/// <summary>
	/// window:* のタイトルとタブ切り離し
	/// </summary>
	private readonly WindowApi _windowApi;

	/// <summary>
	/// shell:* とフォルダ選択。CSS スニペットのフォルダを開くときも使う
	/// </summary>
	private readonly ShellApi _shellApi;

	/// <summary>
	/// 閉じる判断と、シェルメニューの更新
	/// </summary>
	private readonly AppApi _appApi;

	/// <summary>
	/// clipboard:* の読み書きと、エディタ向けの貼り付け変換
	/// </summary>
	private readonly ClipboardApi _clipboardApi;

	/// <summary>
	/// CSS スニペットの一覧とフォルダパス。ルーターと同時に作り、設定ストアを借用する
	/// </summary>
	private readonly CssSnippetService _cssSnippetService;

	/// <summary>
	/// update:* の確認、取得、適用。起動時チェックもここから始める
	/// </summary>
	private readonly UpdateApi _updateApi;

	/// <summary>
	/// session:save。副ウィンドウでは保存しない
	/// </summary>
	private readonly SessionApi _sessionApi;

	/// <summary>
	/// HTML の PDF 出力と印刷 UI。所有は MainForm にあり、ルーターは破棄しない
	/// </summary>
	private readonly PrintExportService _printExportService;

	/// <summary>
	/// 各 API を作り、セッション保存の所有者を SessionApi へ渡す
	/// </summary>
	/// <param name="mainForm">メニュー、タイトル、イベント送信の宛先。null は渡さない</param>
	/// <param name="appContext">設定、ファイル、ログの参照先。ルーターより長く生きる</param>
	/// <param name="isSessionOwner">true のときだけ session:save がタブ構成を書く</param>
	/// <param name="printExportService">印刷と PDF。フォームの終了時に破棄される。null は渡さない</param>
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
	/// method に対応する処理を実行し、id があるときだけ JSON 応答を返す
	/// 例外と未対応の method はログへ残し、id があるときは error 応答に変える。id の無い通知は null
	/// </summary>
	/// <param name="request">method を持つ要求 JSON。params が無いときは空として各 API へ渡す</param>
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
				BridgeMethod.UiUpdateTableMenuState  => _appApi.UpdateTableMenuState(paramsElement),
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

	/// <summary>
	/// 起動時の更新チェックを非同期で始める。同日に確認済みなら UpdateApi 側で何もしない
	/// 失敗はイベントで Web 層へ知らせ、ここからは例外を出さない
	/// </summary>
	public void StartStartupUpdateCheck() => _updateApi.StartStartupCheck();

	/// <summary>
	/// 疎通確認のメッセージと、応答を作ったローカル時刻を返す
	/// message が無いときは pong を返す
	/// </summary>
	/// <param name="paramsElement">message を持つ JSON。未指定やオブジェクト以外のときは pong</param>
	/// <returns>message と、ISO 8601 の now</returns>
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
	/// Web 層のログを日次ログへ写す。level が不明なときは INFO にする
	/// params が無いときは何も書かず成功を返す
	/// </summary>
	/// <param name="paramsElement">level、source、message を持つ JSON。未指定の level は INFO、source は web</param>
	/// <returns>受付済みを表す ok。ログ書き込みの失敗はロガー側に任せ、ここは成功を返す</returns>
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
