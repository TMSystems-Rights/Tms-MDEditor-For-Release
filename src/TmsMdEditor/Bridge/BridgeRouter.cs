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
		// 応答を対応付ける要求 ID。無い通知は null で、応答 JSON を返さない
		string? id   = request.TryGetProperty(BridgeProperty.Id, out JsonElement idElement) ? idElement.GetString() : null;
		// 振り分け先のメソッド名。null のときは空文字で、未対応として失敗する
		string method  = request.GetProperty(BridgeProperty.Method).GetString() ?? string.Empty;
		// API へ渡す引数。params が無いときは default で、各 API は未指定として扱う
		JsonElement paramsElement = request.TryGetProperty(BridgeProperty.Params, out JsonElement rawParams)
			? rawParams
			: default;

		try
		{
			// method 名ごとの処理。未対応は破棄側で例外にし、id があるときだけ error 応答にする
			object? result = method switch
			{
				// 疎通確認。message が無ければ pong と、応答を作った時刻を返す
				BridgeMethod.Ping              => HandlePing(paramsElement),
				// Web 層のログを日次ログへ写す。level が不明なら INFO
				BridgeMethod.LogWrite          => HandleLogWrite(paramsElement),
				// ディスクを読み直さず、メモリ上の設定と保存先を返す
				BridgeMethod.ConfigGet         => _configApi.GetConfig(),
				// settings、装飾、ウィンドウのいずれか一つを保存する。対象が無ければ失敗
				BridgeMethod.ConfigUpdate      => _configApi.Update(paramsElement),
				// 指定した設定項目だけを既定値へ戻す。未知のキーは失敗
				BridgeMethod.ConfigResetItem   => _configApi.ResetItem(paramsElement),
				// データ保存先以外を既定値へ戻す
				BridgeMethod.ConfigResetAll    => _configApi.ResetAll(),
				// 現在と既定のデータ保存先を返す。設定ファイルは読み直さない
				BridgeMethod.ConfigGetDataDir  => _configApi.GetDataDir(),
				// params が未指定か null のときだけフォルダ選択。値があるときはそのパスへ移す。両方の条件が同時には成立しない
				BridgeMethod.ConfigChangeDataDir => paramsElement.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
					? _configApi.ChangeDataDirWithDialog()
					: _configApi.ChangeDataDir(paramsElement),
				// スニペットの配置と有効状態を返す
				BridgeMethod.CssSnippetsList       => _cssSnippetService.List(),
				// スニペット保存フォルダをエクスプローラーで開く。フォルダが無いときは例外
				BridgeMethod.CssSnippetsOpenFolder => _shellApi.OpenFolder(_cssSnippetService.GetDirectoryPath()),
				// 文字コードを自動判定して読み、その絶対パスを監視対象に加える
				BridgeMethod.FileOpen              => _fileApi.Open(paramsElement),
				// 指定した文字コードで読む。名前が未対応のときは例外
				BridgeMethod.FileOpenWithEncoding  => _fileApi.OpenWithEncoding(paramsElement),
				// ファイル選択ダイアログ。キャンセルは例外にせず Canceled にする
				BridgeMethod.FileOpenDialog        => _fileApi.OpenDialog(),
				// 本文を保存し、書く直前だけ外部変更の再読込を抑止する
				BridgeMethod.FileSave              => _fileApi.Save(paramsElement),
				// params が未指定のときだけ初期パス無し。値があるときはそのパスを初期表示にする
				BridgeMethod.FileSaveAsDialog      => paramsElement.ValueKind == JsonValueKind.Undefined
					? _fileApi.SaveAsDialog(default)
					: _fileApi.SaveAsDialog(paramsElement),
				// HTML または PDF の保存先を選ぶ。ファイルはまだ書かない
				BridgeMethod.FileExportDialog      => _fileApi.ExportDialog(paramsElement),
				// 生成済みテキストを UTF-8 で書く。監視の抑止はしない
				BridgeMethod.FileWriteUtf8         => _fileApi.WriteUtf8(paramsElement),
				// 生成済み HTML を PDF へ書く。UI スレッドへ戻してから完了する
				BridgeMethod.ExportPrintToPdf      => await _printExportService.PrintToPdfAsync(PrintExportService.ReadRequest(paramsElement))
					.ConfigureAwait(true),
				// Windows の印刷画面を出す。UI スレッドへ戻してから完了する
				BridgeMethod.ExportShowPrintUi => await _printExportService.ShowPrintUiAsync(PrintExportService.ReadRequest(paramsElement))
					.ConfigureAwait(true),
				// params が未指定のときも空の引数で Data URL を読む。失敗は結果の Error に入れる
				BridgeMethod.FileReadImageAsDataUrl => paramsElement.ValueKind == JsonValueKind.Undefined
					? _fileApi.ReadImageAsDataUrl(default)
					: _fileApi.ReadImageAsDataUrl(paramsElement),
				// params が未指定のときも空の引数で絶対パスを解決する。バイトは返さない
				BridgeMethod.FileResolveLocalImage => paramsElement.ValueKind == JsonValueKind.Undefined
					? _fileApi.ResolveLocalImage(default)
					: _fileApi.ResolveLocalImage(paramsElement),
				// 最近使ったファイルのパスを新しい順で返す。0 件でも失敗にはしない
				BridgeMethod.RecentList              => _recentApi.List(),
				// パスを一覧の先頭へ加え、成功したときだけメニューを更新する
				BridgeMethod.RecentAdd               => _recentApi.Add(paramsElement),
				// パスを一覧から外し、成功したときだけメニューを更新する
				BridgeMethod.RecentRemove            => _recentApi.Remove(paramsElement),
				// ネイティブウィンドウのタイトルを差し替える。title が無ければ製品名
				BridgeMethod.WindowSetTitle          => _windowApi.SetTitle(paramsElement),
				// ウィンドウの外へ出たタブを、別ウィンドウか新しいプロセスへ渡す
				BridgeMethod.WindowDetachTab         => _windowApi.DetachTab(paramsElement),
				// エクスプローラーでファイルを選択した状態にする。ファイルが無いときは例外
				BridgeMethod.ShellShowInFolder       => _shellApi.ShowInFolder(paramsElement),
				// http または https を、設定が custom ならそのコマンドで開く
				BridgeMethod.ShellOpenExternal       => _shellApi.OpenExternal(paramsElement),
				// 未保存確認の結果を受け、閉じてよいときだけウィンドウを閉じ直す
				BridgeMethod.AppReportCloseReady     => _appApi.ReportCloseReady(paramsElement),
				// 次回起動用のタブ構成を保存する。副ウィンドウは保存しない
				BridgeMethod.SessionSave             => _sessionApi.Save(paramsElement),
				// ノートごとのカーソル位置とスクロール位置を保存する
				BridgeMethod.NoteViewPositionsSave   => _appContext.NoteViewPositionStore.Save(paramsElement),
				// 開いているシェルのドロップダウンを閉じる
				BridgeMethod.UiDismissMenus          => _appApi.DismissMenus(),
				// テーブル選択に合わせて上部メニューの活性を変える。未知の操作 ID は無視する
				BridgeMethod.UiUpdateTableMenuState  => _appApi.UpdateTableMenuState(paramsElement),
				// Unicode テキストを読む。テキストが無ければ空文字
				BridgeMethod.ClipboardReadText       => _clipboardApi.ReadText(),
				// Unicode テキストを書く。空文字のときはクリップボードを空にする
				BridgeMethod.ClipboardWriteText      => _clipboardApi.WriteText(paramsElement),
				// 画像、表、テキストの順に Markdown へ変換する。失敗は結果の Error
				BridgeMethod.ClipboardPasteForEditor => _clipboardApi.PasteForEditor(paramsElement),
				// 貼り付け画像の保存先フォルダを選ぶ。キャンセルは例外にしない
				BridgeMethod.ShellPickFolder         => _shellApi.PickFolder(),
				// 新しいリリースがあるかを確認する。通信失敗は status が error
				BridgeMethod.UpdateCheck             => await _updateApi.CheckAsync().ConfigureAwait(false),
				// 検出済みインストーラーを取得する。ポータブル版は取得しない
				BridgeMethod.UpdateDownload          => await _updateApi.DownloadAsync().ConfigureAwait(false),
				// 進行中の取得を中止する。取得していなくても成功を返す
				BridgeMethod.UpdateCancelDownload    => _updateApi.CancelDownload(),
				// 検出中のバージョンを起動時通知から外す。別バージョンは保存しない
				BridgeMethod.UpdateSkipVersion       => _updateApi.SkipVersion(paramsElement),
				// 終了後にインストーラーを起動するよう予約してウィンドウを閉じる
				BridgeMethod.UpdateApplyNow          => _updateApi.ApplyNow(),
				// 公式の入手ページを既定のブラウザで開く
				BridgeMethod.UpdateOpenOfficialPage  => _updateApi.OpenOfficialPage(),
				_ => throw new InvalidOperationException($"未対応のメソッドです: {method}"),
			};

			// 応答を返す相手がいない通知。id が null のときは JSON を作らない
			if (id is null)
			{
				return null;
			}

			// 要求 ID と API の戻り。Web 層が id で要求と対応付ける
			string response = JsonSerializer.Serialize(new
			{
				// 要求と同じ id。この分岐では null にならない
				id,
				// API の戻り。失敗は catch 側の error になる
				result,
			}, BridgeJson.Options);

			return response;
		}
		catch (Exception ex)
		{
			// 失敗した method と例外メッセージ。id の無い通知は応答を返さない
			_appContext.Logger.Error(LogCategory.Bridge, "ブリッジ要求の処理に失敗しました", new Dictionary<string, object?>
			{
				// 失敗したブリッジメソッド名。空なら未対応の空文字
				[LogProperty.Method] = method,
				// 例外メッセージ。スタックはここには載せない
				[LogProperty.Error]  = ex.Message,
			});

			// 通知には error 応答も返さない。id があるときだけ Web 層へ失敗を返す
			if (id is null)
			{
				return null;
			}

			// 要求 ID と失敗理由。message だけを載せる
			string errorResponse = JsonSerializer.Serialize(new
			{
				// 要求と同じ id。この分岐では null にならない
				id,
				// 失敗オブジェクト。本文は例外メッセージ
				error = new
				{
					// Web 層へ見せる失敗理由。空のこともある
					message = ex.Message,
				},
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
		// 応答メッセージ。message が無いときは pong
		string message = "pong";

		// params があり、かつ message プロパティがあるときだけ差し替える。片方でも欠けると pong のまま
		if (paramsElement.ValueKind != JsonValueKind.Undefined
			&& paramsElement.TryGetProperty(BridgeProperty.Message, out JsonElement messageElement))
		{
			// null の message は pong のまま残す。空文字はそのまま返す
			message = messageElement.GetString() ?? message;
		}

		// 疎通確認の応答。message と、応答を作ったローカル時刻
		return new
		{
			// 受け取った message。空文字もありうる
			message,
			// 応答を作ったローカル時刻。ISO 8601
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
		// params が無い通知。ログは書かず、受付済みだけ返す
		if (paramsElement.ValueKind == JsonValueKind.Undefined)
		{
			return new { ok = true };
		}

		// 重大度。プロパティが無い、または null のときは INFO
		string level   = paramsElement.TryGetProperty(BridgeProperty.Level, out JsonElement levelElement) ? levelElement.GetString() ?? "INFO" : "INFO";
		// 発生元。プロパティが無い、または null のときは web
		string source  = paramsElement.TryGetProperty(BridgeProperty.Source, out JsonElement sourceElement) ? sourceElement.GetString() ?? "web" : "web";
		// 本文。プロパティが無い、または null のときは空文字のログを書く
		string message = paramsElement.TryGetProperty(BridgeProperty.Message, out JsonElement messageElement) ? messageElement.GetString() ?? string.Empty : string.Empty;

		switch (level.ToUpperInvariant())
		{
		// 重大度が ERROR のとき。エラーログとして残す
		case "ERROR":
			_appContext.Logger.Error(source, message);
			break;
		// 重大度が WARN のとき。警告ログとして残す
		case "WARN":
			_appContext.Logger.Warn(source, message);
			break;
		// 重大度が DEBUG のとき。デバッグログとして残す
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
