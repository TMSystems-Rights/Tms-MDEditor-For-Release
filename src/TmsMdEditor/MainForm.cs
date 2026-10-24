// ==============================================
// メニューと WebView2 をホストする
// ==============================================

// WinForms のメニューと WebView2 の寿命を持ち、Web 層との通知の境界になる
// WebView の初期化に失敗したときはメッセージを出してウィンドウを閉じる

using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using TmsMdEditor.Bridge;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor;

/// <summary>
/// メインウィンドウ。WinForms メニューバーと WebView2 ホストを提供する
/// </summary>
internal sealed class MainForm : Form
{
	// ==============================================
	// フィールド
	// ==============================================

	/// <summary>
	/// 通常表示の最小幅。ピクセル。保存値がこれより小さくてもフォームはこの幅を下回らない
	/// </summary>
	private const int MinFormWidth  = 600;

	/// <summary>
	/// 通常表示の最小高さ。ピクセル。メニューバーを含めた外側の高さ
	/// </summary>
	private const int MinFormHeight = 400;

	/// <summary>
	/// このプロセスの起動引数。Web 層の初期化が終わるまで保持し、ファイルパスの解決に使う
	/// </summary>
	private readonly string[] _startupArgs;

	/// <summary>
	/// 設定、ログ、ファイル監視の参照先。フォームより長く生き、ここでは破棄しない
	/// </summary>
	private readonly AppContext _appContext;

	/// <summary>
	/// Web 層からの要求の振り分け。フォームと同時に作り、印刷サービスは所有しない
	/// </summary>
	private readonly BridgeRouter _bridgeRouter;

	/// <summary>
	/// 印刷と PDF。フォームが閉じるときに破棄する
	/// </summary>
	private readonly PrintExportService _printExportService;

	/// <summary>
	/// 編集画面をホストする WebView。フォームのクライアント領域いっぱいに置く
	/// </summary>
	private readonly WebView2 _webView;

	/// <summary>
	/// ウィンドウ上部のメニュー。項目の実処理は Web 層へイベントで渡す
	/// </summary>
	private readonly MenuStrip _menuStrip;

	/// <summary>
	/// このウィンドウが次回起動用セッションの所有者か。生成後は変えない
	/// </summary>
	private readonly bool _isSessionOwner;

	/// <summary>
	/// 最近使ったファイルのサブメニュー。一覧の更新で中身だけを入れ替える
	/// </summary>
	private readonly ToolStripMenuItem _recentFilesMenuItem;

	/// <summary>
	/// 設定のキーバインド ID から、ショートカット表示を更新するメニュー項目
	/// メニュー構築時に埋め、以降は増やさない
	/// </summary>
	private readonly Dictionary<string, ToolStripMenuItem> _shortcutMenuItems = [];

	/// <summary>
	/// テーブル操作 ID から、活性を切り替えるメニュー項目。メニュー構築時に埋め、以降は増やさない
	/// </summary>
	private readonly Dictionary<string, ToolStripMenuItem> _tableMenuItems = [];

	/// <summary>
	/// ハンドルが出来る前に届いた、他プロセスからのファイル起動要求。配信後に空にする
	/// </summary>
	private readonly List<string[]> _pendingExternalOpenRequests = [];

	/// <summary>
	/// Web 層の準備前に届いたタブ転送。ready のあと、届いた順に送る
	/// </summary>
	private readonly List<PendingDetachedTab> _pendingDetachedTabs = [];

	/// <summary>
	/// app:ready を送ったあと true。これより前のイベントは捨てる
	/// </summary>
	private bool _webReady;

	/// <summary>
	/// 未保存確認を Web 層へ聞いて、返事を待っているあいだ true。重複した閉じる操作はキャンセルする
	/// </summary>
	private bool _closeDecisionPending;

	/// <summary>
	/// Web 層が閉じてよいと答えたあと true。次の FormClosing では確認をやり直さない
	/// </summary>
	private bool _allowCloseAfterDecision;

	/// <summary>
	/// タブ切り離しで位置を指定して開いたとき、表示完了後に前面化する。前面化したら false
	/// </summary>
	private bool _activateAfterShown;

	/// <summary>
	/// 閉じたあと起動するインストーラーのパス。予約が無ければ null。閉じる確認が拒否されても予約は残る
	/// </summary>
	private string? _installerToLaunchAfterClose;

	// ==============================================
	// 初期化
	// ==============================================

	/// <summary>
	/// メニュー、WebView、ブリッジを作り、保存済みのウィンドウサイズを適用する
	/// 切り離し起動の座標があるときはその位置に置き、無いときは画面中央にする
	/// </summary>
	/// <param name="startupArgs">このプロセスのコマンドライン。空でもウィンドウは開く</param>
	/// <param name="appContext">設定とサービス。フォームより長く生きる。null は渡さない</param>
	/// <param name="isSessionOwner">true のときだけ次回起動用のタブ構成を保存する</param>
	public MainForm(string[] startupArgs, AppContext appContext, bool isSessionOwner)
	{
		AutoScaleMode = AutoScaleMode.Dpi;

		_startupArgs  = startupArgs;
		_appContext   = appContext;
		_isSessionOwner = isSessionOwner;
		_printExportService = new PrintExportService(this, appContext.Logger);
		_bridgeRouter = new BridgeRouter(this, appContext, isSessionOwner, _printExportService);
		_appContext.FileWatcherService.FileChanged += OnExternalFileChanged;
		_webView      = new WebView2
		{
			Dock              = DockStyle.Fill,
			// true: Web 層の HTML5 drop で Explorer からのファイルパスを受け取る
			AllowExternalDrop = true,
		};
		_menuStrip    = BuildMenuStrip(out _recentFilesMenuItem);
		_menuStrip.MenuActivate += (_, _) => PostBridgeEvent(BridgeEventName.UiDismissContextMenus);
		RefreshSettingsMenuShortcutDisplays();

		ApplyWindowStateFromConfig();
		ApplyWindowIcon();

		MinimumSize   = new Size(MinFormWidth, MinFormHeight);
		Point? detachedWindowPoint = StartupArguments.GetDetachedWindowPoint(startupArgs);
		if (detachedWindowPoint is Point dropPoint)
		{
			WindowState   = FormWindowState.Normal;
			StartPosition = FormStartPosition.Manual;
			Location      = DetachedWindowPlacement.CalculateLocation(dropPoint, Size, Screen.FromPoint(dropPoint).WorkingArea);
			_activateAfterShown = true;
		}
		else
		{
			StartPosition = FormStartPosition.CenterScreen;
		}

		Controls.Add(_webView);
		Controls.Add(_menuStrip);
		MainMenuStrip = _menuStrip;

		_webView.GotFocus += (_, _) => DismissShellMenus();
		_webView.KeyDown  += OnWebViewKeyDown;
		_webView.ZoomFactorChanged += (_, _) => ResetWebViewZoom();

		Load        += OnFormLoadAsync;
		Shown       += OnFormShown;
		FormClosing += OnFormClosing;
		FormClosed  += OnFormClosed;
	}

	// ==============================================
	// ウィンドウ操作
	// ==============================================

	/// <summary>
	/// タブ切り離しの WM_COPYDATA を受け、それ以外は基底のウィンドウ処理へ返す
	/// 転送ファイルを読めたときだけ結果を 1 にし、失敗時は 0 を返して既定処理はしない
	/// </summary>
	/// <param name="message">ウィンドウメッセージ。タブ転送以外は書き換えない</param>
	protected override void WndProc(ref Message message)
	{
		// タブ転送のWM_COPYDATAだけを先に処理し、それ以外はWinForms既定処理へ返す
		if (WindowInterop.TryReadDetachedTab(message, out DetachedTabTransferRequest? request) && request is not null)
		{
			message.Result = ReceiveDetachedTab(request) ? new IntPtr(1) : IntPtr.Zero;
			return;
		}

		base.WndProc(ref message);
	}

	/// <summary>
	/// シェル（WinForms）のドロップダウンメニューを閉じる
	/// </summary>
	public void DismissShellMenus()
	{
		if (InvokeRequired)
		{
			BeginInvoke(DismissShellMenus);
			return;
		}

		foreach (ToolStripItem item in _menuStrip.Items)
		{
			if (item is ToolStripMenuItem menuItem)
			{
				menuItem.DropDown.Close();
			}
		}
	}

	/// <summary>
	/// ウィンドウタイトルを差し替える。UI スレッド以外から呼ぶとそちらへ移す
	/// 空文字もそのまま表示し、製品名への戻しは呼び出し側が渡す
	/// </summary>
	/// <param name="title">表示するタイトル。null は渡さない</param>
	public void UpdateWindowTitle(string title)
	{
		if (InvokeRequired)
		{
			BeginInvoke(() => Text = title);
			return;
		}

		Text = title;
	}

	/// <summary>
	/// Web 層からのクローズ判断を反映する。true のときだけ Close を再入する
	/// 返事を先に記録し、再入した FormClosing では Web 層へ聞き直さない
	/// </summary>
	/// <param name="allowClose">閉じてよいとき true。false のときはウィンドウを開いたままにする</param>
	public void CompleteCloseDecision(bool allowClose)
	{
		if (InvokeRequired)
		{
			BeginInvoke(() => CompleteCloseDecision(allowClose));
			return;
		}

		// 2回目のFormClosingで再度Web層へ問い合わせないよう、判断結果を先に記録する
		_allowCloseAfterDecision = allowClose;
		_closeDecisionPending    = false;

		if (allowClose)
		{
			Close();
		}
	}

	/// <summary>
	/// Web 層へ JSON イベントを送る。UI スレッド以外から呼ぶとそちらへ移す
	/// WebView の準備前は捨てる。必要な通知は呼び出し側がキューする
	/// </summary>
	/// <param name="eventName">BridgeEventName の値。空でも JSON には載せる</param>
	/// <param name="payload">追加データ。省略時は null を載せる</param>
	public void PostBridgeEvent(string eventName, object? payload = null)
	{
		if (InvokeRequired)
		{
			BeginInvoke(() => PostBridgeEvent(eventName, payload));
			return;
		}

		// 初期化前の通知は受信側が存在しないため送らず、必要なものは呼び出し側でキューイングする
		if (!_webReady || _webView.CoreWebView2 is null)
		{
			return;
		}

		string json = JsonSerializer.Serialize(new
		{
			@event  = eventName,
			payload,
		}, BridgeJson.Options);

		_webView.CoreWebView2.PostWebMessageAsJson(json);
	}

	/// <summary>
	/// 通常の終了確認後にインストーラーを起動するよう予約し、閉じる操作を始める
	/// 未保存確認で閉じなかったときは予約を残し、次に閉じ切ったときに起動する
	/// </summary>
	/// <param name="installerPath">終了後に起動するインストーラーのパス。存在確認は呼び出し側が済ませている</param>
	public void QueueInstallerAndClose(string installerPath)
	{
		if (InvokeRequired)
		{
			BeginInvoke(() => QueueInstallerAndClose(installerPath));
			return;
		}

		_installerToLaunchAfterClose = installerPath;
		Close();
	}

	/// <summary>
	/// 後続プロセスから転送されたファイルを既存ウィンドウで開き、前面化する
	/// </summary>
	/// <param name="args">後続プロセスのコマンドライン。ファイルパスが無くてもウィンドウは前面化する</param>
	public void ReceiveExternalOpenRequest(string[] args)
	{
		if (IsDisposed || Disposing)
		{
			return;
		}

		if (!IsHandleCreated)
		{
			lock (_pendingExternalOpenRequests)
			{
				_pendingExternalOpenRequests.Add(args);
			}
			return;
		}

		BeginInvoke(() => HandleExternalOpenRequest(args));
	}

	// ==============================================
	// メニュー
	// ==============================================

	/// <summary>
	/// 設定済みショートカットをメニュー表示へ反映する
	/// </summary>
	internal void RefreshSettingsMenuShortcutDisplays()
	{
		if (InvokeRequired)
		{
			BeginInvoke(RefreshSettingsMenuShortcutDisplays);
			return;
		}

		KeybindingsSettings keybindings = _appContext.Config.Settings.Keybindings;
		SetShortcutDisplay("newFile", keybindings.NewFile);
		SetShortcutDisplay("openFile", keybindings.OpenFile);
		SetShortcutDisplay("save", keybindings.Save);
		SetShortcutDisplay("saveAs", keybindings.SaveAs);
		SetShortcutDisplay("exportHtml", keybindings.ExportHtml);
		SetShortcutDisplay("exportPdf", keybindings.ExportPdf);
		SetShortcutDisplay("print", keybindings.Print);
		SetShortcutDisplay("find", keybindings.Find);
		SetShortcutDisplay("replace", keybindings.Replace);
		SetShortcutDisplay("findNext", keybindings.FindNext);
		SetShortcutDisplay("findPrev", keybindings.FindPrev);
		SetShortcutDisplay("toggleViewMode", keybindings.ToggleViewMode);
		SetShortcutDisplay("toggleOutline", keybindings.ToggleOutline);
		SetShortcutDisplay("splitHorizontal", keybindings.SplitHorizontal);
		SetShortcutDisplay("splitVertical", keybindings.SplitVertical);
		SetShortcutDisplay("unsplit", keybindings.Unsplit);
	}

	/// <summary>
	/// 1 件のメニュー項目へ、設定のショートカット表記を出す。対応する項目が無いときは何もしない
	/// </summary>
	/// <param name="key">キーバインド設定の項目名。辞書に無い名前は無視する</param>
	/// <param name="shortcut">メニューに出す表記。空なら表示を消す</param>
	private void SetShortcutDisplay(string key, string shortcut)
	{
		if (_shortcutMenuItems.TryGetValue(key, out ToolStripMenuItem? item))
		{
			item.ShortcutKeyDisplayString = shortcut;
		}
	}

	/// <summary>Web側の現在状態に合わせて上部テーブルメニューの活性状態を更新する</summary>
	/// <param name="state">操作IDごとの活性状態</param>
	internal void UpdateTableMenuState(JsonElement state)
	{
		if (InvokeRequired)
		{
			JsonElement cloned = state.Clone();
			BeginInvoke(() => UpdateTableMenuState(cloned));
			return;
		}

		foreach ((string action, ToolStripMenuItem item) in _tableMenuItems)
		{
			item.Enabled = state.ValueKind == JsonValueKind.Object
				&& state.TryGetProperty(action, out JsonElement enabledElement)
				&& enabledElement.ValueKind is JsonValueKind.True;
		}
	}

	/// <summary>
	/// テーブルメニュー項目を作り、操作 ID で後から活性を変えられるよう辞書へ入れる。初期状態は無効
	/// </summary>
	/// <param name="text">メニューに出す文言。アクセスキーの &amp; を含めてよい</param>
	/// <param name="action">Web 層へ渡す操作 ID。同じ ID を二度作ると辞書は上書きする</param>
	/// <returns>メニューへ追加する項目</returns>
	private ToolStripMenuItem CreateTableMenuItem(string text, string action)
	{
		var item = new ToolStripMenuItem(text, null, (_, _) => PostBridgeEvent(
			BridgeEventName.MenuTableAction,
			new { action }))
		{
			Enabled = false,
		};
		_tableMenuItems[action] = item;
		return item;
	}

	// ==============================================
	// フォームの寿命
	// ==============================================

	/// <summary>
	/// 保存済みの幅、高さ、最大化をフォームへ適用する。タイトルは製品名に戻す
	/// 切り離し起動の座標指定は、このあとコンストラクタが上書きする
	/// </summary>
	private void ApplyWindowStateFromConfig()
	{
		WindowConfig window = _appContext.Config.Window;
		Text            = "TMS-MDEditor";
		Width           = window.Width;
		Height          = window.Height;

		if (window.Maximized)
		{
			WindowState = FormWindowState.Maximized;
		}
	}

	/// <summary>
	/// exe のアプリアイコンをウィンドウとタスクバーへ設定する
	/// </summary>
	private void ApplyWindowIcon()
	{
		Icon? windowIcon = WindowIcon.Load();
		if (windowIcon is null)
		{
			return;
		}

		Icon     = windowIcon;
		ShowIcon = true;
	}

	/// <summary>
	/// WebView2 を初期化し、失敗したときはメッセージを出してウィンドウを閉じる
	/// Load からは一度だけ外し、再入しない
	/// </summary>
	/// <param name="sender">Load の送信元。使わない</param>
	/// <param name="e">イベント引数。使わない</param>
	private async void OnFormLoadAsync(object? sender, EventArgs e)
	{
		Load -= OnFormLoadAsync;

		try
		{
			await InitializeWebViewAsync();
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error(LogCategory.Shell, "WebView2 の初期化に失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			MessageBox.Show(
				$"WebView2 Runtime の初期化に失敗しました。\n\n{ex.Message}",
				"TMS-MDEditor",
				MessageBoxButtons.OK,
				MessageBoxIcon.Error);
			Close();
		}
	}

	/// <summary>
	/// 切り離し起動のときだけ、表示が終わったあとでウィンドウを前面化する
	/// 通常起動では何もしない
	/// </summary>
	/// <param name="sender">Shown の送信元。使わない</param>
	/// <param name="e">イベント引数。使わない</param>
	private void OnFormShown(object? sender, EventArgs e)
	{
		if (!_activateAfterShown) return;
		_activateAfterShown = false;
		// Shown処理完了後へ遅延し、別プロセスから転送された起動要求のウィンドウを確実に前面化する
		BeginInvoke(() =>
		{
			Show();
			BringToFront();
			Activate();
			WindowInterop.ActivateWindow(Handle);
		});
	}

	/// <summary>
	/// 閉じる操作を、Web 層の未保存確認が終わるまでキャンセルする
	/// 確認中の再入もキャンセルし、閉じてよいと分かったときだけウィンドウサイズを保存する
	/// WebView がまだ無いときは確認せず閉じる
	/// </summary>
	/// <param name="sender">FormClosing の送信元。使わない</param>
	/// <param name="e">キャンセルできる閉じる理由。Cancel を true にすると閉じない</param>
	private void OnFormClosing(object? sender, FormClosingEventArgs e)
	{
		// Web層の確認中に再度閉じる操作が来ても、問い合わせを重複させない
		if (_closeDecisionPending)
		{
			e.Cancel = true;
			return;
		}

		if (_allowCloseAfterDecision)
		{
			// 最大化中はRestoreBoundsを保存し、次回の通常表示サイズが最大化領域にならないようにする
			Rectangle bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
			_appContext.PersistWindowState(bounds.Width, bounds.Height, WindowState == FormWindowState.Maximized);
			return;
		}

		if (!_webReady)
		{
			return;
		}

		// 未保存タブの有無はWeb層が管理しているため、同期的に閉じず非同期確認へ委譲する
		e.Cancel               = true;
		_closeDecisionPending  = true;
		PostBridgeEvent(BridgeEventName.AppQueryClose);
	}

	/// <summary>
	/// 印刷用の WebView を破棄してから基底の終了処理を行う
	/// インストーラーの起動は別ハンドラが行い、ここでは印刷資源だけを解放する
	/// </summary>
	/// <param name="e">終了理由。この時点ではキャンセルできない</param>
	protected override void OnFormClosed(FormClosedEventArgs e)
	{
		_printExportService.Dispose();
		base.OnFormClosed(e);
	}

	// ==============================================
	// WebView
	// ==============================================

	/// <summary>
	/// ユーザーデータフォルダと仮想ホストを用意し、ローカルの Web 資産を開く
	/// 資産フォルダが無い、または CoreWebView2 が得られないときは例外にする。呼び出し側がダイアログを出す
	/// </summary>
	/// <exception cref="InvalidOperationException">CoreWebView2 が初期化されていない</exception>
	/// <exception cref="DirectoryNotFoundException">webdist フォルダが無い</exception>
	private async Task InitializeWebViewAsync()
	{
		string userDataFolder = AppPaths.WebView2UserDataDirectory;

		Directory.CreateDirectory(userDataFolder);

		var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
		await _webView.EnsureCoreWebView2Async(environment);

		CoreWebView2 core = _webView.CoreWebView2
			?? throw new InvalidOperationException("CoreWebView2 が初期化されていません。");

		// ブラウザ既定UIを無効化し、アプリ側メニュー・ショートカットへ操作体系を統一する
		core.Settings.AreBrowserAcceleratorKeysEnabled = false;
		core.Settings.AreDefaultContextMenusEnabled     = false;
		core.Settings.IsStatusBarEnabled              = false;
		core.Settings.IsZoomControlEnabled            = false;
		ResetWebViewZoom();
		core.Settings.AreDevToolsEnabled = true;
		_webView.AllowExternalDrop = true;

		string webDistPath = Path.Combine(System.AppContext.BaseDirectory, "webdist");
		if (!Directory.Exists(webDistPath))
		{
			throw new DirectoryNotFoundException($"Web 資産が見つかりません: {webDistPath}");
		}

		// file://制約を避けつつローカル資産だけを配信するため、固定仮想ホストへ割り当てる
		string virtualHost = AppPaths.WebViewVirtualHost;
		core.SetVirtualHostNameToFolderMapping(
			virtualHost,
			webDistPath,
			CoreWebView2HostResourceAccessKind.Allow);

		core.WebMessageReceived += OnWebMessageReceived;
		core.NavigationCompleted += OnNavigationCompleted;

		core.Navigate($"https://{virtualHost}/index.html");
		_appContext.Logger.Info(LogCategory.Shell, "WebView2 を初期化しました", new Dictionary<string, object?>
		{
			[LogProperty.WebDistPath] = webDistPath,
			[LogProperty.VirtualHost] = virtualHost,
		});
	}

	/// <summary>
	/// 外部の変更、削除、改名を Web 層へ通知する。破棄中は送らない
	/// UI スレッド以外から来たときはそちらへ移す。準備前の通知は PostBridgeEvent が捨てる
	/// </summary>
	/// <param name="change">変わったファイルの絶対パスと種別。null は渡さない</param>
	private void OnExternalFileChanged(ExternalFileChange change)
	{
		if (IsDisposed || Disposing) return;
		if (InvokeRequired)
		{
			BeginInvoke(() => OnExternalFileChanged(change));
			return;
		}
		PostBridgeEvent(BridgeEventName.AppExternalFileChanged, new
		{
			filePath = change.FilePath,
			kind     = change.Kind.ToString().ToLowerInvariant(),
		});
	}

	/// <summary>
	/// WebView の表示倍率を 1 に戻す。既に 1 なら何もしない
	/// ブラウザ側のズームを、アプリの表示設定と混ぜないために使う
	/// </summary>
	private void ResetWebViewZoom()
	{
		if (Math.Abs(_webView.ZoomFactor - 1.0) < 0.0001)
		{
			return;
		}

		_webView.ZoomFactor = 1.0;
	}

	/// <summary>
	/// WebView が先に取るキーのうち、分割と Alt のメニュー操作だけをシェルで処理する
	/// それ以外は Web 層へ渡す
	/// </summary>
	/// <param name="sender">キーを受けた WebView。使わない</param>
	/// <param name="e">修飾キーを含むキー情報。処理したときは Handled を true にする</param>
	private void OnWebViewKeyDown(object? sender, KeyEventArgs e)
	{
		if (TryHandleSplitShortcut(e))
		{
			return;
		}

		if (!e.Alt && e.KeyCode is not Keys.Menu and not Keys.LMenu and not Keys.RMenu)
		{
			return;
		}

		e.Handled          = true;
		e.SuppressKeyPress = true;
		HandleMenuAccelerator(e.KeyCode);
	}

	/// <summary>
	/// WebView2 の予約アクセラレーターより先に分割・アウトラインのショートカットを処理する
	/// </summary>
	/// <param name="e">キーイベント</param>
	/// <returns>対象ショートカットを処理した場合 true</returns>
	private bool TryHandleSplitShortcut(KeyEventArgs e)
	{
		string? eventName = GetSplitShortcutEventName(e);
		if (eventName is null)
		{
			return false;
		}

		e.Handled          = true;
		e.SuppressKeyPress = true;
		PostBridgeEvent(eventName);
		return true;
	}

	/// <summary>
	/// キーイベントに対応する分割・アウトラインのイベント名を取得する
	/// </summary>
	/// <param name="e">キーイベント</param>
	/// <returns>対応するイベント名。対象外の場合 null</returns>
	private string? GetSplitShortcutEventName(KeyEventArgs e)
	{
		KeybindingsSettings keybindings = _appContext.Config.Settings.Keybindings;
		return ShortcutKeyMatcher.Matches(e, keybindings.SplitHorizontal)
				? BridgeEventName.MenuSplitHorizontal
				: ShortcutKeyMatcher.Matches(e, keybindings.SplitVertical)
					? BridgeEventName.MenuSplitVertical
					: ShortcutKeyMatcher.Matches(e, keybindings.Unsplit)
						? BridgeEventName.MenuUnsplit
						: ShortcutKeyMatcher.Matches(e, keybindings.ToggleOutline)
							? BridgeEventName.MenuToggleOutline
						: null;
	}

	/// <summary>
	/// WebView2 へ渡る前にフォーム全体の分割ショートカットを処理する
	/// </summary>
	/// <param name="msg">Windows メッセージ</param>
	/// <param name="keyData">修飾キーを含むキー情報</param>
	/// <returns>キーを処理した場合 true</returns>
	protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
	{
		string? eventName = GetSplitShortcutEventName(new KeyEventArgs(keyData));
		if (eventName is null)
		{
			return base.ProcessCmdKey(ref msg, keyData);
		}

		PostBridgeEvent(eventName);
		return true;
	}

	// ----------------------------------------------
	// アクセスキー
	// ----------------------------------------------

	/// <summary>
	/// Alt と同時に押されたキーで、対応する最上位メニューを開く
	/// Alt 単体のときは先頭のメニューを選択する。該当が無いときは何もしない
	/// </summary>
	/// <param name="key">押されたキー。文字にならないキーは無視する</param>
	private void HandleMenuAccelerator(Keys key)
	{
		_menuStrip.Focus();

		if (key is Keys.Menu or Keys.LMenu or Keys.RMenu)
		{
			if (_menuStrip.Items.Count > 0)
			{
				_menuStrip.Items[0].Select();
			}

			return;
		}

		char mnemonic = GetMnemonicCharacter(key);
		if (mnemonic == '\0')
		{
			return;
		}

		foreach (ToolStripItem item in _menuStrip.Items)
		{
			if (item is ToolStripMenuItem menuItem
				&& GetMnemonicCharacter(menuItem.Text ?? string.Empty) == mnemonic)
			{
				menuItem.Select();
				menuItem.ShowDropDown();
				return;
			}
		}
	}

	/// <summary>
	/// キーをメニューのアクセスキー文字にする。A から Z、0 から 9 以外は対象外
	/// </summary>
	/// <param name="key">変換するキー</param>
	/// <returns>大文字または数字。対象外は NUL</returns>
	private static char GetMnemonicCharacter(Keys key)
	{
		if (key >= Keys.A && key <= Keys.Z)
		{
			return (char)key;
		}

		if (key >= Keys.D0 && key <= Keys.D9)
		{
			return (char)('0' + key - Keys.D0);
		}

		return '\0';
	}

	/// <summary>
	/// メニュー文言の &amp; の次の文字をアクセスキーとして返す。&amp;&amp; はエスケープとして飛ばす
	/// </summary>
	/// <param name="text">メニュー文言。空なら対象外</param>
	/// <returns>大文字化したアクセスキー。無ければ NUL</returns>
	private static char GetMnemonicCharacter(string text)
	{
		for (int index = 0; index < text.Length - 1; index++)
		{
			if (text[index] != '&')
			{
				continue;
			}

			if (text[index + 1] == '&')
			{
				index++;
				continue;
			}

			return char.ToUpperInvariant(text[index + 1]);
		}

		return '\0';
	}

	/// <summary>
	/// WebView からのメッセージを、ドロップファイルかブリッジ要求として処理する
	/// 失敗はログへ残し、ウィンドウは閉じない
	/// </summary>
	/// <param name="sender">メッセージの送信元。使わない</param>
	/// <param name="e">JSON 本文と、追加オブジェクトのファイル</param>
	private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
	{
		try
		{
			// WebView2の追加オブジェクトはJSON本文より先に処理し、実ファイルパスを失わないようにする
			string[] droppedPaths = ExtractDroppedFilePaths(e);
			if (droppedPaths.Length > 0)
			{
				PostBridgeEvent(BridgeEventName.AppOpenFiles, new { files = droppedPaths });
				return;
			}

			using JsonDocument document = JsonDocument.Parse(e.WebMessageAsJson);
			JsonElement root = document.RootElement;

			if (!root.TryGetProperty(BridgeProperty.Method, out JsonElement methodElement))
			{
				return;
			}

			string? method = methodElement.GetString();
			if (string.Equals(method, BridgeMethod.FileDrop, StringComparison.Ordinal))
			{
				_appContext.Logger.Warn(LogCategory.Shell, "ドロップファイルのパスを取得できませんでした");
				return;
			}

			// method付きJSONだけをBridgeへルーティングし、要求IDを含む応答を同じWebViewへ返す
			string? responseJson = await _bridgeRouter.HandleRequestAsync(root);
			if (responseJson is not null)
			{
				_webView.CoreWebView2?.PostWebMessageAsJson(responseJson);
			}
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error(LogCategory.Shell, "WebMessage の処理に失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
		}
	}

	/// <summary>
	/// Web 層から postMessageWithAdditionalObjects で渡された File のパスを取得する
	/// </summary>
	/// <param name="e">WebMessage 引数</param>
	/// <returns>存在するファイルパス一覧</returns>
	private static string[] ExtractDroppedFilePaths(CoreWebView2WebMessageReceivedEventArgs e)
	{
		if (e.AdditionalObjects is null || e.AdditionalObjects.Count == 0)
		{
			return [];
		}

		return e.AdditionalObjects
			.OfType<CoreWebView2File>()
			.Select(file => file.Path)
			.Where(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path))
			.Select(Path.GetFullPath)
			.Distinct(StringComparer.OrdinalIgnoreCase)
			.ToArray();
	}

	/// <summary>
	/// 最初のページ読み込みが成功したとき、起動情報と設定をまとめて Web 層へ渡す
	/// 失敗時はログだけ残し、ready にはしない。成功後に届いていたタブ転送を順に送る
	/// </summary>
	/// <param name="sender">ナビゲーションの送信元。使わない</param>
	/// <param name="e">成功フラグと、失敗時の WebErrorStatus</param>
	private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
	{
		if (!e.IsSuccess)
		{
			_appContext.Logger.Error(LogCategory.Shell, "Web 層の読み込みに失敗しました", new Dictionary<string, object?> { [LogProperty.WebErrorStatus] = e.WebErrorStatus.ToString() });
			return;
		}

		// Web層が最初の描画を一度で組み立てられるよう、起動情報・設定・復元状態をまとめて渡す
		DataDirInfo dataDirInfo = _appContext.ConfigStore.GetDataDirInfo();
		string[] startupFiles   = StartupArguments.ResolveFilePaths(_startupArgs)
			.Concat(DrainPendingExternalOpenRequests())
			.Distinct(StringComparer.OrdinalIgnoreCase)
			.ToArray();
		JsonElement? detachedTab = LoadDetachedTab(_startupArgs);
		SessionLoadResult sessionLoad = _isSessionOwner && _appContext.Config.Settings.RestoreSessionOnStartup
			? _appContext.SessionStore.Load()
			: new SessionLoadResult { Success = true };
		NoteViewPositionLoadResult noteViewPositions = _appContext.NoteViewPositionStore.Load();

		_webView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
		{
			@event  = BridgeEventName.AppReady,
			payload = new
			{
				version = GetDisplayVersion(),
				isPortable = AppPaths.IsPortable,
				args    = _startupArgs,
				files   = startupFiles,
				detachedTab,
				isSessionOwner = _isSessionOwner,
				session = sessionLoad.Session,
				sessionLoadMessage = sessionLoad.Message,
				noteViewPositions = noteViewPositions.Document,
				config  = new
				{
					dataDir             = dataDirInfo.DataDir,
					defaultDataDir      = dataDirInfo.DefaultDataDir,
					isPortable          = AppPaths.IsPortable,
					theme               = _appContext.Config.Settings.Theme,
					loadMessage         = _appContext.ConfigLoadMessage,
					settings            = _appContext.Config.Settings,
					customDecorations   = _appContext.Config.CustomDecorations,
				},
			},
		}, BridgeJson.Options));

		// ready通知後に到着済みのタブ転送を順番に配信し、初期化前の要求を失わないようにする
		_webReady = true;
		foreach (PendingDetachedTab pending in _pendingDetachedTabs)
		{
			PostDetachedTab(pending);
		}
		_pendingDetachedTabs.Clear();
		RefreshRecentFilesMenu();
		_appContext.Logger.Info(LogCategory.Shell, "Web 層の読み込みが完了しました");
		_bridgeRouter.StartStartupUpdateCheck();
	}

	// ==============================================
	// 終了
	// ==============================================

	/// <summary>
	/// ウィンドウが閉じたあと、予約してあったインストーラーを起動する
	/// 予約が無いときは何もしない。起動に失敗してもプロセスは戻し、ログへ残す
	/// </summary>
	/// <param name="sender">FormClosed の送信元。使わない</param>
	/// <param name="e">終了理由。使わない</param>
	private void OnFormClosed(object? sender, FormClosedEventArgs e)
	{
		if (string.IsNullOrWhiteSpace(_installerToLaunchAfterClose)) return;

		try
		{
			_appContext.UpdateService.LaunchInstaller(_installerToLaunchAfterClose);
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error(LogCategory.Update, "インストーラーを起動できませんでした", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
		}
	}

	// ==============================================
	// メニューの構築
	// ==============================================

	/// <summary>
	/// ファイル、編集、テーブル、表示、設定、ヘルプのメニューを作る
	/// 項目の実行は Web 層へのイベントに留め、ショートカットの実処理は Web 層が持つ
	/// </summary>
	/// <param name="recentFilesMenuItem">後から中身を入れ替える「最近使ったファイル」項目</param>
	/// <returns>ウィンドウ上部に置くメニュー。項目 0 のときは空のまま返さない</returns>
	private MenuStrip BuildMenuStrip(out ToolStripMenuItem recentFilesMenuItem)
	{
		var menuStrip = new MenuStrip { Dock = DockStyle.Top };

		var fileMenu = new ToolStripMenuItem("ファイル(&F)");
		var newFileItem = new ToolStripMenuItem("新規作成(&N)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuNewFile));
		var openFileItem = new ToolStripMenuItem("開く(&O)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuOpenFile));
		fileMenu.DropDownItems.Add(newFileItem);
		fileMenu.DropDownItems.Add(openFileItem);
		recentFilesMenuItem = new ToolStripMenuItem("最近使ったファイル");
		fileMenu.DropDownItems.Add(recentFilesMenuItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		var saveItem = new ToolStripMenuItem("上書き保存(&S)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuSave));
		var saveAsItem = new ToolStripMenuItem("名前を付けて保存(&A)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuSaveAs));
		var exportHtmlItem = new ToolStripMenuItem("HTMLとしてエクスポート(&H)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuExportHtml));
		var exportPdfItem = new ToolStripMenuItem("PDFとしてエクスポート(&P)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuExportPdf));
		var printItem = new ToolStripMenuItem("印刷(&I)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuPrint));
		fileMenu.DropDownItems.Add(saveItem);
		fileMenu.DropDownItems.Add(saveAsItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		fileMenu.DropDownItems.Add(exportHtmlItem);
		fileMenu.DropDownItems.Add(exportPdfItem);
		fileMenu.DropDownItems.Add(printItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		fileMenu.DropDownItems.Add("文字コードを指定して再読込(&R)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuReloadWithEncoding));
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		fileMenu.DropDownItems.Add("終了(&X)", null, (_, _) => Close());

		var editMenu = new ToolStripMenuItem("編集(&E)");
		var findItem = new ToolStripMenuItem(
			"検索(&F)...",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuFind))
		{
			ShortcutKeyDisplayString = "Ctrl+F",
		};
		var replaceItem = new ToolStripMenuItem(
			"置換(&R)...",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuReplace))
		{
			ShortcutKeyDisplayString = "Ctrl+R",
		};
		var findNextItem = new ToolStripMenuItem(
			"次を検索(&N)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuFindNext))
		{
			ShortcutKeyDisplayString = "F3",
		};
		var findPreviousItem = new ToolStripMenuItem(
			"前を検索(&P)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuFindPrevious))
		{
			ShortcutKeyDisplayString = "Shift+F3",
		};
		editMenu.DropDownItems.Add(findItem);
		editMenu.DropDownItems.Add(replaceItem);
		editMenu.DropDownItems.Add(new ToolStripSeparator());
		editMenu.DropDownItems.Add(findNextItem);
		editMenu.DropDownItems.Add(findPreviousItem);

		var tableMenu = new ToolStripMenuItem("テーブル(&T)");
		tableMenu.DropDownItems.Add(CreateTableMenuItem("表を挿入(&I)...", "insertTable"));
		tableMenu.DropDownItems.Add(new ToolStripSeparator());

		var tableRowsMenu = new ToolStripMenuItem("行(&R)");
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択数と同じ行を上に追加(&A)", "insertTableRowsBefore"));
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択数と同じ行を下に追加(&B)", "insertTableRowsAfter"));
		tableRowsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択した行を削除(&D)", "deleteTableRows"));
		tableRowsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択した行を上へ移動(&U)", "moveTableRowsUp"));
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択した行を下へ移動(&N)", "moveTableRowsDown"));

		var tableColumnsMenu = new ToolStripMenuItem("列(&C)");
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択数と同じ列を左に追加(&L)", "insertTableColumnsBefore"));
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択数と同じ列を右に追加(&R)", "insertTableColumnsAfter"));
		tableColumnsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択した列を削除(&D)", "deleteTableColumns"));
		tableColumnsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択した列を左へ移動(&P)", "moveTableColumnsLeft"));
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択した列を右へ移動(&N)", "moveTableColumnsRight"));

		var tableCellsMenu = new ToolStripMenuItem("セル(&L)");
		tableCellsMenu.DropDownItems.Add(CreateTableMenuItem("セルを結合(&M)", "mergeTableCells"));
		tableCellsMenu.DropDownItems.Add(CreateTableMenuItem("結合を解除(&U)", "unmergeTableCells"));
		tableCellsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableCellsMenu.DropDownItems.Add(CreateTableMenuItem("左詰め(&L)", "alignTableCellLeft"));
		tableCellsMenu.DropDownItems.Add(CreateTableMenuItem("中央揃え(&C)", "alignTableCellCenter"));
		tableCellsMenu.DropDownItems.Add(CreateTableMenuItem("右詰め(&R)", "alignTableCellRight"));
		tableCellsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableCellsMenu.DropDownItems.Add(CreateTableMenuItem("上詰め(&T)", "valignTableCellTop"));
		tableCellsMenu.DropDownItems.Add(CreateTableMenuItem("上下中央(&E)", "valignTableCellMiddle"));
		tableCellsMenu.DropDownItems.Add(CreateTableMenuItem("下詰め(&B)", "valignTableCellBottom"));

		tableMenu.DropDownItems.Add(tableRowsMenu);
		tableMenu.DropDownItems.Add(tableColumnsMenu);
		tableMenu.DropDownItems.Add(tableCellsMenu);

		var viewMenu = new ToolStripMenuItem("表示(&V)");
		var toggleViewModeItem = new ToolStripMenuItem(
			"ソース / ライブプレビュー切替(&E)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuToggleViewMode));
		// ショートカット本体は Web 層（config keybindings）が処理する。表示のみ付与する
		toggleViewModeItem.ShortcutKeyDisplayString = "Ctrl+E";
		viewMenu.DropDownItems.Add(toggleViewModeItem);
		var toggleOutlineItem = new ToolStripMenuItem(
			"アウトラインを表示 / 非表示(&O)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuToggleOutline));
		toggleOutlineItem.ShortcutKeyDisplayString = "Ctrl+Shift+O";
		viewMenu.DropDownItems.Add(toggleOutlineItem);
		viewMenu.DropDownItems.Add(new ToolStripSeparator());
		viewMenu.DropDownItems.Add("見出しをすべて折りたたむ(&C)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuCollapseAllHeadings));
		viewMenu.DropDownItems.Add("見出しをすべて展開(&X)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuExpandAllHeadings));
		viewMenu.DropDownItems.Add(new ToolStripSeparator());

		var splitHorizontalItem = new ToolStripMenuItem(
			"上下に分割(&H)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuSplitHorizontal))
		{
			ShortcutKeyDisplayString = "Ctrl+Shift+-",
		};
		var splitVerticalItem = new ToolStripMenuItem(
			"左右に分割(&V)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuSplitVertical))
		{
			ShortcutKeyDisplayString = "Ctrl+Shift+\\",
		};
		var unsplitItem = new ToolStripMenuItem(
			"分割解除(&U)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuUnsplit))
		{
			ShortcutKeyDisplayString = "Ctrl+Shift+U",
		};
		viewMenu.DropDownItems.Add(splitHorizontalItem);
		viewMenu.DropDownItems.Add(splitVerticalItem);
		viewMenu.DropDownItems.Add(unsplitItem);

		var settingsMenu = new ToolStripMenuItem("設定(&S)");
		settingsMenu.DropDownItems.Add("設定を開く(&S)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuOpenSettings));
		settingsMenu.DropDownItems.Add(new ToolStripSeparator());
		settingsMenu.DropDownItems.Add("CSSスニペットを再読込(&R)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuReloadCssSnippets));
		settingsMenu.DropDownItems.Add("CSSスニペットフォルダを開く(&O)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuOpenSnippetsFolder));

		var helpMenu = new ToolStripMenuItem("ヘルプ(&H)");
		helpMenu.DropDownItems.Add("開発者ツール(&D)", null, (_, _) =>
		{
			_webView.CoreWebView2?.OpenDevToolsWindow();
		});
		helpMenu.DropDownItems.Add(new ToolStripSeparator());
		helpMenu.DropDownItems.Add("更新を確認(&U)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuCheckForUpdates));
		helpMenu.DropDownItems.Add(new ToolStripSeparator());
		helpMenu.DropDownItems.Add("バージョン情報(&A)", null, (_, _) =>
		{
			string version = GetDisplayVersion();
			MessageBox.Show($"TMS-MDEditor\nVersion {version}", "バージョン情報", MessageBoxButtons.OK, MessageBoxIcon.Information);
		});

		_shortcutMenuItems["newFile"]         = newFileItem;
		_shortcutMenuItems["openFile"]        = openFileItem;
		_shortcutMenuItems["save"]            = saveItem;
		_shortcutMenuItems["saveAs"]          = saveAsItem;
		_shortcutMenuItems["exportHtml"]      = exportHtmlItem;
		_shortcutMenuItems["exportPdf"]       = exportPdfItem;
		_shortcutMenuItems["print"]           = printItem;
		_shortcutMenuItems["find"]            = findItem;
		_shortcutMenuItems["replace"]         = replaceItem;
		_shortcutMenuItems["findNext"]        = findNextItem;
		_shortcutMenuItems["findPrev"]        = findPreviousItem;
		_shortcutMenuItems["toggleViewMode"]  = toggleViewModeItem;
		_shortcutMenuItems["toggleOutline"]   = toggleOutlineItem;
		_shortcutMenuItems["splitHorizontal"] = splitHorizontalItem;
		_shortcutMenuItems["splitVertical"]   = splitVerticalItem;
		_shortcutMenuItems["unsplit"]         = unsplitItem;

		menuStrip.Items.Add(fileMenu);
		menuStrip.Items.Add(editMenu);
		menuStrip.Items.Add(tableMenu);
		menuStrip.Items.Add(viewMenu);
		menuStrip.Items.Add(settingsMenu);
		menuStrip.Items.Add(helpMenu);

		return menuStrip;
	}

	/// <summary>
	/// 最近使ったファイルのサブメニューを、現在の設定で作り直す
	/// 0 件のときは項目を無効にする。UI スレッド以外から呼ぶとそちらへ移す
	/// </summary>
	internal void RefreshRecentFilesMenu()
	{
		if (InvokeRequired)
		{
			BeginInvoke(RefreshRecentFilesMenu);
			return;
		}

		_recentFilesMenuItem.DropDownItems.Clear();
		IReadOnlyList<string> recentFiles = _appContext.RecentFilesService.List(_appContext.Config);

		if (recentFiles.Count == 0)
		{
			_recentFilesMenuItem.Enabled = false;
			return;
		}

		_recentFilesMenuItem.Enabled = true;

		foreach (string filePath in recentFiles)
		{
			string displayName = filePath;
			_recentFilesMenuItem.DropDownItems.Add(displayName, null, (_, _) =>
			{
				PostBridgeEvent(BridgeEventName.AppOpenFiles, new { files = new[] { filePath } });
			});
		}
	}

	/// <summary>
	/// 表示用のバージョンを、情報バージョンから + より前だけ取る
	/// 属性が無いときはアセンブリバージョン、それも無ければ unknown
	/// </summary>
	/// <returns>画面と app:ready に出すバージョン文字列</returns>
	private static string GetDisplayVersion()
	{
		string version = typeof(MainForm).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
			?? typeof(MainForm).Assembly.GetName().Version?.ToString()
			?? "unknown";

		return version.Split('+')[0];
	}

	// ==============================================
	// 外部からの起動要求
	// ==============================================

	/// <summary>
	/// 切り離し元ウィンドウが保存したタブ状態を読み込む
	/// 起動引数に転送パスが無いときは null。ファイルの削除は読み込み側が行う
	/// </summary>
	/// <param name="args">このプロセスの起動引数。--detached-tab が無ければ null を返す</param>
	/// <returns>タブ状態の JSON。切り離し起動でなければ null</returns>
	private JsonElement? LoadDetachedTab(string[] args)
	{
		string? transferPath = StartupArguments.GetDetachedTabPath(args);
		return transferPath is null ? null : LoadDetachedTabFile(transferPath);
	}

	/// <summary>
	/// 転送ファイルの JSON をタブ状態として読む。読めたあとも失敗したあともファイルは削除する
	/// 読めないときは null を返し、ウィンドウは開いたままにする
	/// </summary>
	/// <param name="transferPath">タブ JSON の絶対パス。存在しなくても例外にせず null</param>
	/// <returns>タブ状態の JSON。読めないときは null</returns>
	private JsonElement? LoadDetachedTabFile(string transferPath)
	{
		try
		{
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(transferPath));
			return document.RootElement.Clone();
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error(LogCategory.Shell, "切り離しタブ状態の読み込みに失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			return null;
		}
		finally
		{
			// 転送ファイルは一度だけ読む一時媒体なので、成功・失敗にかかわらず回収する
			try
			{
				if (File.Exists(transferPath)) File.Delete(transferPath);
			}
			catch (Exception ex)
			{
				_appContext.Logger.Warn(LogCategory.Shell, "切り離しタブ状態ファイルを削除できませんでした", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			}
		}
	}

	/// <summary>
	/// 他ウィンドウから届いたタブを、Web 層の準備ができていればすぐ送り、未準備なら届いた順で保持する
	/// ファイルを読めないときは false。読めたときはこのウィンドウを前面化する
	/// </summary>
	/// <param name="request">転送ファイルのパスと、画面座標のドロップ位置</param>
	/// <returns>タブを受け取れたとき true。WM_COPYDATA の結果に使う</returns>
	private bool ReceiveDetachedTab(DetachedTabTransferRequest request)
	{
		JsonElement? tab = LoadDetachedTabFile(request.TransferPath);
		if (tab is null) return false;

		var pending = new PendingDetachedTab(tab.Value, request.ScreenX, request.ScreenY);
		// Web初期化前なら座標付き要求を保持し、ready後に同じ順序で届ける
		if (_webReady)
		{
			PostDetachedTab(pending);
		}
		else
		{
			_pendingDetachedTabs.Add(pending);
		}

		if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
		Show();
		BringToFront();
		Activate();
		WindowInterop.ActivateWindow(Handle);
		return true;
	}

	/// <summary>
	/// 保持していたタブ転送を、WebView 内の座標に変換して Web 層へ送る
	/// 準備前に呼ぶと通知は捨てられる
	/// </summary>
	/// <param name="pending">タブ JSON と、画面座標のドロップ位置</param>
	private void PostDetachedTab(PendingDetachedTab pending)
	{
		// Win32の画面座標をWebView内座標へ変換し、ドロップ先ペイン判定へ渡す
		Point clientPoint = _webView.PointToClient(new Point(pending.ScreenX, pending.ScreenY));
		PostBridgeEvent(BridgeEventName.AppReceiveDetachedTab, new
		{
			tab = pending.Tab,
			clientX = clientPoint.X,
			clientY = clientPoint.Y,
		});
	}

	/// <summary>
	/// 後続プロセスのファイル引数を Web 層へ開き、このウィンドウを前面化する
	/// ファイルが無くても前面化はする。準備前の通知は捨てられる
	/// </summary>
	/// <param name="args">後続プロセスのコマンドライン</param>
	private void HandleExternalOpenRequest(string[] args)
	{
		string[] files = StartupArguments.ResolveFilePaths(args);
		if (files.Length > 0)
		{
			PostBridgeEvent(BridgeEventName.AppOpenFiles, new { files });
		}

		if (WindowState == FormWindowState.Minimized)
		{
			WindowState = FormWindowState.Normal;
		}

		Show();
		BringToFront();
		Activate();
	}

	/// <summary>
	/// ハンドル作成前に溜めた起動要求からファイルパスを取り出し、キューを空にする
	/// 同時に届く要求とぶつからないよう、一覧のロックを取る
	/// </summary>
	/// <returns>開くファイルの絶対パス。重複は除かない</returns>
	private string[] DrainPendingExternalOpenRequests()
	{
		lock (_pendingExternalOpenRequests)
		{
			string[] files = _pendingExternalOpenRequests
				.SelectMany(StartupArguments.ResolveFilePaths)
				.ToArray();
			_pendingExternalOpenRequests.Clear();
			return files;
		}
	}

	/// <summary>
	/// Web 層の準備前に届いたタブ転送。ready 後に、届いた順で画面座標をクライアント座標へ直して送る
	/// </summary>
	/// <param name="Tab">切り離したタブの JSON。クローン済みで、元の文書が破棄されても残る</param>
	/// <param name="ScreenX">ドロップ位置の画面 X。ピクセル</param>
	/// <param name="ScreenY">ドロップ位置の画面 Y。ピクセル</param>
	private sealed record PendingDetachedTab(JsonElement Tab, int ScreenX, int ScreenY);
}
