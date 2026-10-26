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
		// 開いているファイルの外部変更を Web 層へ渡す
		_appContext.FileWatcherService.FileChanged += OnExternalFileChanged;
		// 編集画面のホスト。クライアント領域いっぱいに置き、Explorer からのドロップを HTML5 へ渡す
		_webView      = new WebView2
		{
			// クライアント領域の残り全体。メニューの下に広がる
			Dock              = DockStyle.Fill,
			// true: Web 層の HTML5 drop で Explorer からのファイルパスを受け取る
			AllowExternalDrop = true,
		};
		_menuStrip    = BuildMenuStrip(out _recentFilesMenuItem);
		// シェルメニューを開いたとき、Web 層のコンテキストメニューを閉じる
		_menuStrip.MenuActivate += (_, _) => PostBridgeEvent(BridgeEventName.UiDismissContextMenus);
		RefreshSettingsMenuShortcutDisplays();

		ApplyWindowStateFromConfig();
		ApplyWindowIcon();

		MinimumSize   = new Size(MinFormWidth, MinFormHeight);
		// 切り離し起動のドロップ位置。ピクセル。オプションが無い、または整数でなければ null で画面中央になる
		Point? detachedWindowPoint = StartupArguments.GetDetachedWindowPoint(startupArgs);
		// 座標が取れたとき。dropPoint はスクリーン座標、ピクセル。null では画面中央のまま
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

		// WebView がフォーカスを得たとき、開いているシェルメニューを閉じる
		_webView.GotFocus += (_, _) => DismissShellMenus();
		// WebView が先に取るキーのうち、分割と Alt をシェルで処理する
		_webView.KeyDown  += OnWebViewKeyDown;
		// ブラウザ側のズームを 1 倍へ戻す。アプリの表示倍率と混ぜない
		_webView.ZoomFactorChanged += (_, _) => ResetWebViewZoom();

		// ハンドルができたあとで WebView2 を初期化する。失敗時はメッセージを出して閉じる
		Load        += OnFormLoadAsync;
		// 切り離し起動のときだけ、表示完了後に前面化する
		Shown       += OnFormShown;
		// 閉じる操作を、未保存確認が終わるまでキャンセルする
		FormClosing += OnFormClosing;
		// 閉じたあと、予約してあったインストーラーを起動する
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
		// WM_COPYDATA のタブ転送を読めて、かつ中身があるときだけ結果を返す。どちらかが欠けると既定のウィンドウ処理へ渡す
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
		// UI スレッド以外から来たとき。メニュー操作は UI スレッドへ移す
		if (InvokeRequired)
		{
			BeginInvoke(DismissShellMenus);
			return;
		}

		foreach (ToolStripItem item in _menuStrip.Items)
		{
			// 開いているドロップダウンのときだけ閉じる。区切りや無効項目はメニューではない
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
		// UI スレッド以外から来たとき。タイトル変更は UI スレッドへ移す
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
		// UI スレッド以外から来たとき。閉じる判断は UI スレッドへ移す
		if (InvokeRequired)
		{
			BeginInvoke(() => CompleteCloseDecision(allowClose));
			return;
		}

		// 2回目のFormClosingで再度Web層へ問い合わせないよう、判断結果を先に記録する
		_allowCloseAfterDecision = allowClose;
		_closeDecisionPending    = false;

		// 閉じてよいと答えたとき。FormClosing を再入する
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
		// UI スレッド以外から来たとき。WebView への送信は UI スレッドへ移す
		if (InvokeRequired)
		{
			BeginInvoke(() => PostBridgeEvent(eventName, payload));
			return;
		}

		// 初期化前の通知は受信側が存在しないため送らず、必要なものは呼び出し側でキューイングする
		// Web 層の準備ができていて、かつ CoreWebView2 があるときだけ送る。どちらかが欠けると捨てる
		if (!_webReady || _webView.CoreWebView2 is null)
		{
			return;
		}

		// イベント名と追加データ。準備前は作らない
		string json = JsonSerializer.Serialize(new
		{
			// BridgeEventName の値。空でも JSON には載せる
			@event  = eventName,
			// 追加データ。省略時は null
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
		// UI スレッド以外から来たとき。閉じる操作は UI スレッドへ移す
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
		// 破棄中のとき。ファイルも前面化も行わない
		if (IsDisposed || Disposing)
		{
			return;
		}

		// ハンドルがまだ無いとき。作成後に配信できるようキューへ溜める
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
		// UI スレッド以外から来たとき。メニュー表示の更新は UI スレッドへ移す
		if (InvokeRequired)
		{
			BeginInvoke(RefreshSettingsMenuShortcutDisplays);
			return;
		}

		// いまのキー設定。空の表記はメニュー表示を消す
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
		// そのキーに対応するメニュー項目があるとき。未知のキーは表示を変えない
		if (_shortcutMenuItems.TryGetValue(key, out ToolStripMenuItem? item))
		{
			item.ShortcutKeyDisplayString = shortcut;
		}
	}

	/// <summary>Web側の現在状態に合わせて上部テーブルメニューの活性状態を更新する</summary>
	/// <param name="state">操作IDごとの活性状態</param>
	internal void UpdateTableMenuState(JsonElement state)
	{
		// UI スレッド以外から来たとき。JSON は呼び出し後に破棄されるので複製して移す
		if (InvokeRequired)
		{
			// UI スレッドへ渡す複製。元の JsonElement はメソッドを抜けると無効になる
			JsonElement cloned = state.Clone();
			BeginInvoke(() => UpdateTableMenuState(cloned));
			return;
		}

		foreach ((string action, ToolStripMenuItem item) in _tableMenuItems)
		{
			// 状態がオブジェクトで、その操作 ID があり、値が true のときだけ有効。一つでも欠けると無効
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
		// クリックで操作 ID を Web 層へ渡す項目。初期は無効で、選択状態の通知が来るまで押せない
		var item = new ToolStripMenuItem(text, null, (_, _) => PostBridgeEvent(
			BridgeEventName.MenuTableAction,
			new { action }))
		{
			// false のあいだは選択が無い。UpdateTableMenuState が true にする
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
		// 前回終了時のサイズ。幅と高さはピクセル
		WindowConfig window = _appContext.Config.Window;
		Text            = "TMS-MDEditor";
		Width           = window.Width;
		Height          = window.Height;

		// 前回、最大化して閉じたとき。通常サイズのまま開くときは入らない
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
		// exe のアプリアイコン。リソースが無いときは null で、アイコンは変えない
		Icon? windowIcon = WindowIcon.Load();
		// アイコンを読めなかったとき。既定のウィンドウアイコンのままにする
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
		// 前面化を予約していないとき。通常起動は何もしない
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

		// 閉じてよいと分かったあとの再入。確認をやり直さず、通常表示のサイズを保存して閉じる
		if (_allowCloseAfterDecision)
		{
			// 最大化中はRestoreBoundsを保存し、次回の通常表示サイズが最大化領域にならないようにする
			// 通常表示なら今の外側。最大化中は復元サイズ。幅と高さはピクセル
			Rectangle bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
			_appContext.PersistWindowState(bounds.Width, bounds.Height, WindowState == FormWindowState.Maximized);
			return;
		}

		// Web 層の準備前。未保存確認の相手がいないので、確認せず閉じる
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
		// WebView2 のユーザーデータ。ポータブルとインストールで場所が分かれる
		string userDataFolder = AppPaths.WebView2UserDataDirectory;

		Directory.CreateDirectory(userDataFolder);

		// そのフォルダを使う WebView2 環境。ブラウザ実行ファイルはランタイムの既定
		var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
		await _webView.EnsureCoreWebView2Async(environment);

		// 初期化済みのコア。null ならこのあと資産も開けない
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

		// 本体の配置直下にある Web 資産。フォルダが無いときは例外
		string webDistPath = Path.Combine(System.AppContext.BaseDirectory, "webdist");
		// 配布した Web 資産が無いとき。ページは開かず、呼び出し側がダイアログを出す
		if (!Directory.Exists(webDistPath))
		{
			throw new DirectoryNotFoundException($"Web 資産が見つかりません: {webDistPath}");
		}

		// file://制約を避けつつローカル資産だけを配信するため、固定仮想ホストへ割り当てる
		// ローカル資産を載せる仮想ホスト名。https のホスト部に使う
		string virtualHost = AppPaths.WebViewVirtualHost;
		core.SetVirtualHostNameToFolderMapping(
			virtualHost,
			webDistPath,
			CoreWebView2HostResourceAccessKind.Allow);

		// Web 層からのメッセージを、ドロップファイルかブリッジ要求として処理する
		core.WebMessageReceived += OnWebMessageReceived;
		// 最初のページ読み込みが成功したとき、起動情報を Web 層へ渡す
		core.NavigationCompleted += OnNavigationCompleted;

		core.Navigate($"https://{virtualHost}/index.html");
		// 初期化に使った資産フォルダと仮想ホスト
		_appContext.Logger.Info(LogCategory.Shell, "WebView2 を初期化しました", new Dictionary<string, object?>
		{
			// 配信した Web 資産のフォルダ。無いときはここまで来ない
			[LogProperty.WebDistPath] = webDistPath,
			// 仮想ホスト名。https のホスト部
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
		// 破棄中のとき。外部変更は Web 層へ送らない
		if (IsDisposed || Disposing) return;
		// UI スレッド以外から来たとき。通知は UI スレッドへ移す
		if (InvokeRequired)
		{
			BeginInvoke(() => OnExternalFileChanged(change));
			return;
		}
		// 変わったファイルの絶対パスと、変更・削除・改名の種別
		PostBridgeEvent(BridgeEventName.AppExternalFileChanged, new
		{
			// 監視中ファイルの絶対パス
			filePath = change.FilePath,
			// changed、deleted、renamed の小文字。列挙名のままでは Web 層と揃わない
			kind     = change.Kind.ToString().ToLowerInvariant(),
		});
	}

	/// <summary>
	/// WebView の表示倍率を 1 に戻す。既に 1 なら何もしない
	/// ブラウザ側のズームを、アプリの表示設定と混ぜないために使う
	/// </summary>
	private void ResetWebViewZoom()
	{
		// すでに 1 倍のとき。再設定すると表示がちらつくので何もしない
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
		// 分割かアウトラインのショートカットに一致したとき。Web 層へ渡し、キーは WebView に残さない
		if (TryHandleSplitShortcut(e))
		{
			return;
		}

		// Alt が無く、かつキーが Menu 系でもないとき。Web 層へ渡して戻る。どちらかが欠けるとアクセスキー処理へ進む
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
		// 一致した分割・アウトラインのイベント名。対象外は null
		string? eventName = GetSplitShortcutEventName(e);
		// 対象外のキーのとき。Handled は変えず false
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
		// いまのキー設定。空の表記は一致しない
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
		// フォーム全体で一致した分割・アウトラインのイベント名。対象外は null
		string? eventName = GetSplitShortcutEventName(new KeyEventArgs(keyData));
		// 対象外のキーのとき。基底のコマンドキー処理へ返す
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

		// Alt 単体のとき。先頭の最上位メニューを選択する。文字キーでは入らない
		if (key is Keys.Menu or Keys.LMenu or Keys.RMenu)
		{
			// 最上位メニューが 1 つ以上あるとき。空のメニューでは何も選択しない
			if (_menuStrip.Items.Count > 0)
			{
				_menuStrip.Items[0].Select();
			}

			return;
		}

		// A から Z、0 から 9 のアクセスキー。対象外は NUL
		char mnemonic = GetMnemonicCharacter(key);
		// 文字にならないキーのとき。メニューは開かない
		if (mnemonic == '\0')
		{
			return;
		}

		foreach (ToolStripItem item in _menuStrip.Items)
		{
			// 最上位項目がメニューで、かつアクセスキーが押された文字と一致するとき。どちらかが欠けると次の項目を見る
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
		// A から Z のとき。キーコードそのものを大文字として返す
		if (key >= Keys.A && key <= Keys.Z)
		{
			return (char)key;
		}

		// 数字キーのとき。D0 からの差分を文字の 0 から 9 にする
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
			// & でない文字はアクセスキーの開始ではない
			if (text[index] != '&')
			{
				continue;
			}

			// 次も & のとき。エスケープなのでアクセスキーにせず 1 文字飛ばす
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
			// 追加オブジェクトから取れた実在ファイル。0 件なら JSON のブリッジ要求として読む
			string[] droppedPaths = ExtractDroppedFilePaths(e);
			// ドロップされたファイルが 1 件以上あるとき。ブリッジ要求としては扱わない
			if (droppedPaths.Length > 0)
			{
				PostBridgeEvent(BridgeEventName.AppOpenFiles, new { files = droppedPaths });
				return;
			}

			// Web 層が送った JSON。壊れていれば catch がログだけ残す
			using JsonDocument document = JsonDocument.Parse(e.WebMessageAsJson);
			// ルートオブジェクト。method が無ければブリッジへ渡さない
			JsonElement root = document.RootElement;

			// method が無いメッセージ。通知や不明な JSON はここで捨てる
			if (!root.TryGetProperty(BridgeProperty.Method, out JsonElement methodElement))
			{
				return;
			}

			// メソッド名。null は file:drop とは一致しない
			string? method = methodElement.GetString();
			// ドロップ専用の method なのにパスが取れなかったとき。通常の file API には渡さない
			if (string.Equals(method, BridgeMethod.FileDrop, StringComparison.Ordinal))
			{
				_appContext.Logger.Warn(LogCategory.Shell, "ドロップファイルのパスを取得できませんでした");
				return;
			}

			// method付きJSONだけをBridgeへルーティングし、要求IDを含む応答を同じWebViewへ返す
			// ルーターの応答 JSON。id の無い通知は null で、Web 層へは返さない
			string? responseJson = await _bridgeRouter.HandleRequestAsync(root);
			// 応答 JSON があるとき。通知だけの要求は送らない
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
		// 追加オブジェクトが無い、または 0 件のとき。どちらか一方でもファイルパスは空
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
		// ページ読み込みが失敗したとき。ready にはせず、ログだけ残す
		if (!e.IsSuccess)
		{
			_appContext.Logger.Error(LogCategory.Shell, "Web 層の読み込みに失敗しました", new Dictionary<string, object?> { [LogProperty.WebErrorStatus] = e.WebErrorStatus.ToString() });
			return;
		}

		// Web層が最初の描画を一度で組み立てられるよう、起動情報・設定・復元状態をまとめて渡す
		// 現在と既定のデータ保存先。設定ファイルは読み直さない
		DataDirInfo dataDirInfo = _appContext.ConfigStore.GetDataDirInfo();
		// 起動引数と、ハンドル作成前に溜めた要求から集めた絶対パス。重複は除く。0 件なら空
		string[] startupFiles   = StartupArguments.ResolveFilePaths(_startupArgs)
			.Concat(DrainPendingExternalOpenRequests())
			.Distinct(StringComparer.OrdinalIgnoreCase)
			.ToArray();
		// 切り離し起動のタブ JSON。--detached-tab が無ければ null
		JsonElement? detachedTab = LoadDetachedTab(_startupArgs);
		// 所有者であり、かつ起動時復元がオンのときだけセッションを読む。どちらかが欠けると Session は null の成功結果
		SessionLoadResult sessionLoad = _isSessionOwner && _appContext.Config.Settings.RestoreSessionOnStartup
			? _appContext.SessionStore.Load()
			: new SessionLoadResult
			{
				// 復元しない起動。失敗ではないので Web 層は空のセッションで続ける
				Success = true,
			};
		// ノートごとのカーソル位置とスクロール位置。読めなければ空の文書
		NoteViewPositionLoadResult noteViewPositions = _appContext.NoteViewPositionStore.Load();

		// app:ready。起動情報、復元、設定を一度に渡す
		_webView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
		{
			// 起動完了のイベント名
			@event  = BridgeEventName.AppReady,
			// Web 層の初期化に必要な一式
			payload = new
			{
				// 画面に出すバージョン。+ より前。属性が無ければ unknown
				version = GetDisplayVersion(),
				// true ならポータブル配置。更新は公式ページ案内になる
				isPortable = AppPaths.IsPortable,
				// このプロセスの生の起動引数。空でも配列は渡す
				args    = _startupArgs,
				// 開くファイルの絶対パス。0 件なら空
				files   = startupFiles,
				// 切り離しタブの JSON。通常起動は null
				detachedTab,
				// true のときだけ次回起動用のタブ構成を保存する
				isSessionOwner = _isSessionOwner,
				// 復元するセッション。復元しない、または失敗時は null
				session = sessionLoad.Session,
				// セッション読込の説明。問題が無ければ null
				sessionLoadMessage = sessionLoad.Message,
				// ノート位置の文書。空でも null にはしない
				noteViewPositions = noteViewPositions.Document,
				// データ保存先と、メモリ上の設定
				config  = new
				{
					// いま使うデータ保存先。空のときは既定
					dataDir             = dataDirInfo.DataDir,
					// インストール時の既定保存先。ポータブルでは本体横
					defaultDataDir      = dataDirInfo.DefaultDataDir,
					// true ならポータブル配置。payload 側と同じ値
					isPortable          = AppPaths.IsPortable,
					// system、dark、light。未知の値は読込時に system へ戻してある
					theme               = _appContext.Config.Settings.Theme,
					// 設定読込でユーザーへ見せるメッセージ。問題が無ければ null
					loadMessage         = _appContext.ConfigLoadMessage,
					// エディタとシェルの設定一式
					settings            = _appContext.Config.Settings,
					// カスタム装飾。不正な正規表現も保存したまま渡す
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
		// 予約したインストーラーが無いとき。何も起動しない
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
		// ウィンドウ上端に固定するメニューバー
		var menuStrip = new MenuStrip { Dock = DockStyle.Top };

		// ファイル操作の最上位メニュー。アクセスキーは F
		var fileMenu = new ToolStripMenuItem("ファイル(&F)");
		// 新規タブを作る。クリックは menu:newFile を Web 層へ渡す
		var newFileItem = new ToolStripMenuItem("新規作成(&N)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuNewFile));
		// ファイルを開くダイアログを出す。クリックは menu:openFile を Web 層へ渡す
		var openFileItem = new ToolStripMenuItem("開く(&O)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuOpenFile));
		fileMenu.DropDownItems.Add(newFileItem);
		fileMenu.DropDownItems.Add(openFileItem);
		// 最近使ったファイルの入れ物。中身は後から入れ替え、構築時点では空
		recentFilesMenuItem = new ToolStripMenuItem("最近使ったファイル");
		fileMenu.DropDownItems.Add(recentFilesMenuItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		// 現在のタブを上書き保存する。クリックは menu:save を Web 層へ渡す
		var saveItem = new ToolStripMenuItem("上書き保存(&S)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuSave));
		// 名前を付けて保存する。クリックは menu:saveAs を Web 層へ渡す
		var saveAsItem = new ToolStripMenuItem("名前を付けて保存(&A)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuSaveAs));
		// HTML として書き出す。クリックは menu:exportHtml を Web 層へ渡す
		var exportHtmlItem = new ToolStripMenuItem("HTMLとしてエクスポート(&H)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuExportHtml));
		// PDF として書き出す。クリックは menu:exportPdf を Web 層へ渡す
		var exportPdfItem = new ToolStripMenuItem("PDFとしてエクスポート(&P)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuExportPdf));
		// 印刷画面を出す。クリックは menu:print を Web 層へ渡す
		var printItem = new ToolStripMenuItem("印刷(&I)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuPrint));
		fileMenu.DropDownItems.Add(saveItem);
		fileMenu.DropDownItems.Add(saveAsItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		fileMenu.DropDownItems.Add(exportHtmlItem);
		fileMenu.DropDownItems.Add(exportPdfItem);
		fileMenu.DropDownItems.Add(printItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		// 現在のファイルを選んだ文字コードで読み直す。クリックは menu:reloadWithEncoding を Web 層へ渡す
		fileMenu.DropDownItems.Add("文字コードを指定して再読込(&R)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuReloadWithEncoding));
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		// ウィンドウを閉じる。未保存確認は FormClosing が行う
		fileMenu.DropDownItems.Add("終了(&X)", null, (_, _) => Close());

		// 検索と置換の最上位メニュー。アクセスキーは E
		var editMenu = new ToolStripMenuItem("編集(&E)");
		// 検索パネルを開く。クリックは menu:find。表示中のショートカットは後で設定値に差し替える
		var findItem = new ToolStripMenuItem(
			"検索(&F)...",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuFind))
		{
			// 設定読込前の仮表示。RefreshSettingsMenuShortcutDisplays が上書きする
			ShortcutKeyDisplayString = "Ctrl+F",
		};
		// 置換パネルを開く。クリックは menu:replace。仮表示は Ctrl+R
		var replaceItem = new ToolStripMenuItem(
			"置換(&R)...",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuReplace))
		{
			// 設定読込前の仮表示。RefreshSettingsMenuShortcutDisplays が上書きする
			ShortcutKeyDisplayString = "Ctrl+R",
		};
		// 次の一致へ移る。クリックは menu:findNext。仮表示は F3
		var findNextItem = new ToolStripMenuItem(
			"次を検索(&N)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuFindNext))
		{
			// 設定読込前の仮表示。RefreshSettingsMenuShortcutDisplays が上書きする
			ShortcutKeyDisplayString = "F3",
		};
		// 前の一致へ移る。クリックは menu:findPrevious。仮表示は Shift+F3
		var findPreviousItem = new ToolStripMenuItem(
			"前を検索(&P)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuFindPrevious))
		{
			// 設定読込前の仮表示。RefreshSettingsMenuShortcutDisplays が上書きする
			ShortcutKeyDisplayString = "Shift+F3",
		};
		editMenu.DropDownItems.Add(findItem);
		editMenu.DropDownItems.Add(replaceItem);
		editMenu.DropDownItems.Add(new ToolStripSeparator());
		editMenu.DropDownItems.Add(findNextItem);
		editMenu.DropDownItems.Add(findPreviousItem);

		// 表操作の最上位メニュー。項目は選択があるまで無効
		var tableMenu = new ToolStripMenuItem("テーブル(&T)");
		tableMenu.DropDownItems.Add(CreateTableMenuItem("表を挿入(&I)...", "insertTable"));
		tableMenu.DropDownItems.Add(new ToolStripSeparator());

		// 行操作をまとめるサブメニュー
		var tableRowsMenu = new ToolStripMenuItem("行(&R)");
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択数と同じ行を上に追加(&A)", "insertTableRowsBefore"));
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択数と同じ行を下に追加(&B)", "insertTableRowsAfter"));
		tableRowsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択した行を削除(&D)", "deleteTableRows"));
		tableRowsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択した行を上へ移動(&U)", "moveTableRowsUp"));
		tableRowsMenu.DropDownItems.Add(CreateTableMenuItem("選択した行を下へ移動(&N)", "moveTableRowsDown"));

		// 列操作をまとめるサブメニュー
		var tableColumnsMenu = new ToolStripMenuItem("列(&C)");
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択数と同じ列を左に追加(&L)", "insertTableColumnsBefore"));
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択数と同じ列を右に追加(&R)", "insertTableColumnsAfter"));
		tableColumnsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択した列を削除(&D)", "deleteTableColumns"));
		tableColumnsMenu.DropDownItems.Add(new ToolStripSeparator());
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択した列を左へ移動(&P)", "moveTableColumnsLeft"));
		tableColumnsMenu.DropDownItems.Add(CreateTableMenuItem("選択した列を右へ移動(&N)", "moveTableColumnsRight"));

		// セルの結合と揃えをまとめるサブメニュー
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

		// 表示切替の最上位メニュー。アクセスキーは V
		var viewMenu = new ToolStripMenuItem("表示(&V)");
		// ソースとライブプレビューを切り替える。クリックは menu:toggleViewMode
		var toggleViewModeItem = new ToolStripMenuItem(
			"ソース / ライブプレビュー切替(&E)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuToggleViewMode));
		// ショートカット本体は Web 層（config keybindings）が処理する。表示のみ付与する
		toggleViewModeItem.ShortcutKeyDisplayString = "Ctrl+E";
		viewMenu.DropDownItems.Add(toggleViewModeItem);
		// アウトラインの表示を切り替える。クリックは menu:toggleOutline
		var toggleOutlineItem = new ToolStripMenuItem(
			"アウトラインを表示 / 非表示(&O)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuToggleOutline));
		// メニューに出す仮のショートカット。実処理は Web 層が持ち、後で設定値に差し替える
		toggleOutlineItem.ShortcutKeyDisplayString = "Ctrl+Shift+O";
		viewMenu.DropDownItems.Add(toggleOutlineItem);
		viewMenu.DropDownItems.Add(new ToolStripSeparator());
		// 見出しをすべて折りたたむ。クリックは menu:collapseAllHeadings
		viewMenu.DropDownItems.Add("見出しをすべて折りたたむ(&C)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuCollapseAllHeadings));
		// 見出しをすべて展開する。クリックは menu:expandAllHeadings
		viewMenu.DropDownItems.Add("見出しをすべて展開(&X)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuExpandAllHeadings));
		viewMenu.DropDownItems.Add(new ToolStripSeparator());

		// ペインを上下に分割する。クリックは menu:splitHorizontal。仮表示は Ctrl+Shift+-
		var splitHorizontalItem = new ToolStripMenuItem(
			"上下に分割(&H)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuSplitHorizontal))
		{
			// 設定読込前の仮表示。RefreshSettingsMenuShortcutDisplays が上書きする
			ShortcutKeyDisplayString = "Ctrl+Shift+-",
		};
		// ペインを左右に分割する。クリックは menu:splitVertical。仮表示は Ctrl+Shift+\
		var splitVerticalItem = new ToolStripMenuItem(
			"左右に分割(&V)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuSplitVertical))
		{
			// 設定読込前の仮表示。RefreshSettingsMenuShortcutDisplays が上書きする
			ShortcutKeyDisplayString = "Ctrl+Shift+\\",
		};
		// 分割を解除する。クリックは menu:unsplit。仮表示は Ctrl+Shift+U
		var unsplitItem = new ToolStripMenuItem(
			"分割解除(&U)",
			null,
			(_, _) => PostBridgeEvent(BridgeEventName.MenuUnsplit))
		{
			// 設定読込前の仮表示。RefreshSettingsMenuShortcutDisplays が上書きする
			ShortcutKeyDisplayString = "Ctrl+Shift+U",
		};
		viewMenu.DropDownItems.Add(splitHorizontalItem);
		viewMenu.DropDownItems.Add(splitVerticalItem);
		viewMenu.DropDownItems.Add(unsplitItem);

		// 設定とスニペットの最上位メニュー。アクセスキーは S
		var settingsMenu = new ToolStripMenuItem("設定(&S)");
		// 設定画面を開く。クリックは menu:openSettings
		settingsMenu.DropDownItems.Add("設定を開く(&S)...", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuOpenSettings));
		settingsMenu.DropDownItems.Add(new ToolStripSeparator());
		// CSS スニペットをディスクから読み直す。クリックは menu:reloadCssSnippets
		settingsMenu.DropDownItems.Add("CSSスニペットを再読込(&R)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuReloadCssSnippets));
		// スニペットの保存フォルダを開く。クリックは menu:openSnippetsFolder
		settingsMenu.DropDownItems.Add("CSSスニペットフォルダを開く(&O)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuOpenSnippetsFolder));

		// ヘルプの最上位メニュー。アクセスキーは H
		var helpMenu = new ToolStripMenuItem("ヘルプ(&H)");
		// 開発者ツールを開く。CoreWebView2 が無いときは何もしない
		helpMenu.DropDownItems.Add("開発者ツール(&D)", null, (_, _) =>
		{
			_webView.CoreWebView2?.OpenDevToolsWindow();
		});
		helpMenu.DropDownItems.Add(new ToolStripSeparator());
		// 更新を手動で確認する。クリックは menu:checkForUpdates
		helpMenu.DropDownItems.Add("更新を確認(&U)", null, (_, _) => PostBridgeEvent(BridgeEventName.MenuCheckForUpdates));
		helpMenu.DropDownItems.Add(new ToolStripSeparator());
		// バージョン情報を出す。情報バージョンの + より前を表示する
		helpMenu.DropDownItems.Add("バージョン情報(&A)", null, (_, _) =>
		{
			// 情報バージョンの + より前。属性が無ければ unknown
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
		// UI スレッド以外から来たとき。メニューの作り直しは UI スレッドへ移す
		if (InvokeRequired)
		{
			BeginInvoke(RefreshRecentFilesMenu);
			return;
		}

		_recentFilesMenuItem.DropDownItems.Clear();
		// 新しい順の絶対パス。0 件なら項目を無効にする
		IReadOnlyList<string> recentFiles = _appContext.RecentFilesService.List(_appContext.Config);

		// 一覧が空のとき。サブメニューは開けない
		if (recentFiles.Count == 0)
		{
			_recentFilesMenuItem.Enabled = false;
			return;
		}

		_recentFilesMenuItem.Enabled = true;

		foreach (string filePath in recentFiles)
		{
			// 項目の表示文字列。ファイル名には縮めず絶対パスのまま出す
			string displayName = filePath;
			// そのファイルを開く。クリックは app:openFiles へパス 1 件を渡す
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
		// 情報バージョン。無ければアセンブリバージョン。それも無ければ unknown
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
		// 転送ファイルのパス。印が無い、または値が無いときは null
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
			// タブ状態の JSON。読んだあと finally でファイルを消す
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
				// まだ残っているときだけ消す。既に無ければ削除失敗にしない
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
		// 読めたタブ JSON。読めなければ null で、前面化もしない
		JsonElement? tab = LoadDetachedTabFile(request.TransferPath);
		// 転送ファイルを読めなかったとき。WM_COPYDATA の結果は 0
		if (tab is null) return false;

		// 画面座標付きの保留。ready 前はキューへ、ready 後はそのまま送る
		var pending = new PendingDetachedTab(tab.Value, request.ScreenX, request.ScreenY);
		// Web初期化前なら座標付き要求を保持し、ready後に同じ順序で届ける
		// Web 層の準備ができているとき。未準備なら届いた順で保持する
		if (_webReady)
		{
			PostDetachedTab(pending);
		}
		else
		{
			_pendingDetachedTabs.Add(pending);
		}

		// 最小化されているとき。前面化する前に通常表示へ戻す
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
		// 画面座標を WebView 内のピクセルへ変換した位置。準備前の送信は捨てられる
		Point clientPoint = _webView.PointToClient(new Point(pending.ScreenX, pending.ScreenY));
		// 受け取ったタブと、WebView 内のドロップ位置。ピクセル
		PostBridgeEvent(BridgeEventName.AppReceiveDetachedTab, new
		{
			// クローン済みのタブ JSON
			tab = pending.Tab,
			// WebView 内の水平位置。ピクセル
			clientX = clientPoint.X,
			// WebView 内の垂直位置。ピクセル
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
		// 後続プロセスの引数から実在するファイルだけを絶対パスにした一覧。0 件でも前面化する
		string[] files = StartupArguments.ResolveFilePaths(args);
		// 開くファイルが 1 件以上あるとき。無ければ前面化だけ行う
		if (files.Length > 0)
		{
			PostBridgeEvent(BridgeEventName.AppOpenFiles, new { files });
		}

		// 最小化されているとき。前面化する前に通常表示へ戻す
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
			// 溜めていた起動要求から実在するファイルの絶対パスを集めた一覧。重複は除かない
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
