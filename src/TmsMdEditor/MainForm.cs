using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using TmsMdEditor.Bridge;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor;

/// <summary>
/// メインウィンドウ。WinForms メニューバーと WebView2 ホストを提供する。
/// </summary>
internal sealed class MainForm : Form
{
	private const int MinFormWidth  = 600;
	private const int MinFormHeight = 400;

	private readonly string[] _startupArgs;
	private readonly AppContext _appContext;
	private readonly BridgeRouter _bridgeRouter;
	private readonly PrintExportService _printExportService;
	private readonly WebView2 _webView;
	private readonly MenuStrip _menuStrip;
	private readonly bool _isSessionOwner;
	private readonly ToolStripMenuItem _recentFilesMenuItem;
	private readonly Dictionary<string, ToolStripMenuItem> _shortcutMenuItems = [];
	private readonly List<string[]> _pendingExternalOpenRequests = [];
	private readonly List<PendingDetachedTab> _pendingDetachedTabs = [];

	private bool _webReady;
	private bool _closeDecisionPending;
	private bool _allowCloseAfterDecision;
	private bool _activateAfterShown;
	private string? _installerToLaunchAfterClose;

	/// <summary>
	/// メインフォームを初期化する
	/// </summary>
	/// <param name="startupArgs">起動時引数</param>
	/// <param name="appContext">アプリコンテキスト</param>
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
		_menuStrip.MenuActivate += (_, _) => PostBridgeEvent("ui:dismissContextMenus");
		RefreshSettingsMenuShortcutDisplays();

		ApplyWindowStateFromConfig();

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

	/// <inheritdoc />
	protected override void WndProc(ref Message message)
	{
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
	/// ウィンドウタイトルを更新する
	/// </summary>
	/// <param name="title">タイトル</param>
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
	/// Web 層からのクローズ判断を反映する
	/// </summary>
	/// <param name="allowClose">クローズ可否</param>
	public void CompleteCloseDecision(bool allowClose)
	{
		if (InvokeRequired)
		{
			BeginInvoke(() => CompleteCloseDecision(allowClose));
			return;
		}

		_allowCloseAfterDecision = allowClose;
		_closeDecisionPending    = false;

		if (allowClose)
		{
			Close();
		}
	}

	/// <summary>
	/// Web 層へイベント通知を送る
	/// </summary>
	/// <param name="eventName">イベント名</param>
	/// <param name="payload">ペイロード</param>
	public void PostBridgeEvent(string eventName, object? payload = null)
	{
		if (InvokeRequired)
		{
			BeginInvoke(() => PostBridgeEvent(eventName, payload));
			return;
		}

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

	/// <summary>通常の終了確認後にインストーラーを起動するよう予約する</summary>
	/// <param name="installerPath">ダウンロード済みインストーラーパス</param>
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
	/// 後続プロセスから転送されたファイルを既存ウィンドウで開き、前面化する。
	/// </summary>
	/// <param name="args">後続プロセスのコマンドライン引数</param>
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

	/// <summary>
	/// 設定済みショートカットをメニュー表示へ反映する。
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

	private void SetShortcutDisplay(string key, string shortcut)
	{
		if (_shortcutMenuItems.TryGetValue(key, out ToolStripMenuItem? item))
		{
			item.ShortcutKeyDisplayString = shortcut;
		}
	}

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

	private async void OnFormLoadAsync(object? sender, EventArgs e)
	{
		Load -= OnFormLoadAsync;

		try
		{
			await InitializeWebViewAsync();
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error("shell", "WebView2 の初期化に失敗しました", new Dictionary<string, object?> { ["error"] = ex.Message });
			MessageBox.Show(
				$"WebView2 Runtime の初期化に失敗しました。\n\n{ex.Message}",
				"TMS-MDEditor",
				MessageBoxButtons.OK,
				MessageBoxIcon.Error);
			Close();
		}
	}

	private void OnFormShown(object? sender, EventArgs e)
	{
		if (!_activateAfterShown) return;
		_activateAfterShown = false;
		BeginInvoke(() =>
		{
			Show();
			BringToFront();
			Activate();
			WindowInterop.ActivateWindow(Handle);
		});
	}

	private void OnFormClosing(object? sender, FormClosingEventArgs e)
	{
		if (_closeDecisionPending)
		{
			e.Cancel = true;
			return;
		}

		if (_allowCloseAfterDecision)
		{
			Rectangle bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
			_appContext.PersistWindowState(bounds.Width, bounds.Height, WindowState == FormWindowState.Maximized);
			return;
		}

		if (!_webReady)
		{
			return;
		}

		e.Cancel               = true;
		_closeDecisionPending  = true;
		PostBridgeEvent("app:queryClose");
	}

	/// <inheritdoc />
	protected override void OnFormClosed(FormClosedEventArgs e)
	{
		_printExportService.Dispose();
		base.OnFormClosed(e);
	}

	private async Task InitializeWebViewAsync()
	{
		string userDataFolder = Path.Combine(
			Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
			Path.GetFileName(AppPaths.AppDataRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)),
			"webview2");

		Directory.CreateDirectory(userDataFolder);

		var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
		await _webView.EnsureCoreWebView2Async(environment);

		CoreWebView2 core = _webView.CoreWebView2
			?? throw new InvalidOperationException("CoreWebView2 が初期化されていません。");

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

		string virtualHost = AppPaths.WebViewVirtualHost;
		core.SetVirtualHostNameToFolderMapping(
			virtualHost,
			webDistPath,
			CoreWebView2HostResourceAccessKind.Allow);

		core.WebMessageReceived += OnWebMessageReceived;
		core.NavigationCompleted += OnNavigationCompleted;

		core.Navigate($"https://{virtualHost}/index.html");
		_appContext.Logger.Info("shell", "WebView2 を初期化しました", new Dictionary<string, object?>
		{
			["webDistPath"]  = webDistPath,
			["virtualHost"]  = virtualHost,
		});
	}

	private void OnExternalFileChanged(ExternalFileChange change)
	{
		if (IsDisposed || Disposing) return;
		if (InvokeRequired)
		{
			BeginInvoke(() => OnExternalFileChanged(change));
			return;
		}
		PostBridgeEvent("app:externalFileChanged", new
		{
			filePath = change.FilePath,
			kind     = change.Kind.ToString().ToLowerInvariant(),
		});
	}

	private void ResetWebViewZoom()
	{
		if (Math.Abs(_webView.ZoomFactor - 1.0) < 0.0001)
		{
			return;
		}

		_webView.ZoomFactor = 1.0;
	}

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
			? "menu:splitHorizontal"
			: ShortcutKeyMatcher.Matches(e, keybindings.SplitVertical)
				? "menu:splitVertical"
				: ShortcutKeyMatcher.Matches(e, keybindings.Unsplit)
					? "menu:unsplit"
					: ShortcutKeyMatcher.Matches(e, keybindings.ToggleOutline)
						? "menu:toggleOutline"
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

	private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
	{
		try
		{
			string[] droppedPaths = ExtractDroppedFilePaths(e);
			if (droppedPaths.Length > 0)
			{
				PostBridgeEvent("app:openFiles", new { files = droppedPaths });
				return;
			}

			using JsonDocument document = JsonDocument.Parse(e.WebMessageAsJson);
			JsonElement root = document.RootElement;

			if (!root.TryGetProperty("method", out JsonElement methodElement))
			{
				return;
			}

			string? method = methodElement.GetString();
			if (string.Equals(method, "file:drop", StringComparison.Ordinal))
			{
				_appContext.Logger.Warn("shell", "ドロップファイルのパスを取得できませんでした");
				return;
			}

			string? responseJson = await _bridgeRouter.HandleRequestAsync(root);
			if (responseJson is not null)
			{
				_webView.CoreWebView2?.PostWebMessageAsJson(responseJson);
			}
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error("shell", "WebMessage の処理に失敗しました", new Dictionary<string, object?> { ["error"] = ex.Message });
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

	private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
	{
		if (!e.IsSuccess)
		{
			_appContext.Logger.Error("shell", "Web 層の読み込みに失敗しました", new Dictionary<string, object?> { ["webErrorStatus"] = e.WebErrorStatus.ToString() });
			return;
		}

		DataDirInfo dataDirInfo = _appContext.ConfigStore.GetDataDirInfo();
		string[] startupFiles   = StartupArguments.ResolveFilePaths(_startupArgs)
			.Concat(DrainPendingExternalOpenRequests())
			.Distinct(StringComparer.OrdinalIgnoreCase)
			.ToArray();
		JsonElement? detachedTab = LoadDetachedTab(_startupArgs);
		SessionLoadResult sessionLoad = _isSessionOwner && _appContext.Config.Settings.RestoreSessionOnStartup
			? _appContext.SessionStore.Load()
			: new SessionLoadResult { Success = true };

		_webView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
		{
			@event  = "app:ready",
			payload = new
			{
				version = GetDisplayVersion(),
				args    = _startupArgs,
				files   = startupFiles,
				detachedTab,
				isSessionOwner = _isSessionOwner,
				session = sessionLoad.Session,
				sessionLoadMessage = sessionLoad.Message,
				config  = new
				{
					dataDir             = dataDirInfo.DataDir,
					defaultDataDir      = dataDirInfo.DefaultDataDir,
					theme               = _appContext.Config.Settings.Theme,
					loadMessage         = _appContext.ConfigLoadMessage,
					settings            = _appContext.Config.Settings,
					customDecorations   = _appContext.Config.CustomDecorations,
				},
			},
		}, BridgeJson.Options));

		_webReady = true;
		foreach (PendingDetachedTab pending in _pendingDetachedTabs)
		{
			PostDetachedTab(pending);
		}
		_pendingDetachedTabs.Clear();
		RefreshRecentFilesMenu();
		_appContext.Logger.Info("shell", "Web 層の読み込みが完了しました");
		_bridgeRouter.StartStartupUpdateCheck();
	}

	private void OnFormClosed(object? sender, FormClosedEventArgs e)
	{
		if (string.IsNullOrWhiteSpace(_installerToLaunchAfterClose)) return;

		try
		{
			_appContext.UpdateService.LaunchInstaller(_installerToLaunchAfterClose);
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error("update", "インストーラーを起動できませんでした", new Dictionary<string, object?> { ["error"] = ex.Message });
		}
	}

	private MenuStrip BuildMenuStrip(out ToolStripMenuItem recentFilesMenuItem)
	{
		var menuStrip = new MenuStrip { Dock = DockStyle.Top };

		var fileMenu = new ToolStripMenuItem("ファイル(&F)");
		var newFileItem = new ToolStripMenuItem("新規作成(&N)", null, (_, _) => PostBridgeEvent("menu:newFile"));
		var openFileItem = new ToolStripMenuItem("開く(&O)...", null, (_, _) => PostBridgeEvent("menu:openFile"));
		fileMenu.DropDownItems.Add(newFileItem);
		fileMenu.DropDownItems.Add(openFileItem);
		recentFilesMenuItem = new ToolStripMenuItem("最近使ったファイル");
		fileMenu.DropDownItems.Add(recentFilesMenuItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		var saveItem = new ToolStripMenuItem("上書き保存(&S)", null, (_, _) => PostBridgeEvent("menu:save"));
		var saveAsItem = new ToolStripMenuItem("名前を付けて保存(&A)...", null, (_, _) => PostBridgeEvent("menu:saveAs"));
		var exportHtmlItem = new ToolStripMenuItem("HTMLとしてエクスポート(&H)...", null, (_, _) => PostBridgeEvent("menu:exportHtml"));
		var exportPdfItem = new ToolStripMenuItem("PDFとしてエクスポート(&P)...", null, (_, _) => PostBridgeEvent("menu:exportPdf"));
		var printItem = new ToolStripMenuItem("印刷(&I)...", null, (_, _) => PostBridgeEvent("menu:print"));
		fileMenu.DropDownItems.Add(saveItem);
		fileMenu.DropDownItems.Add(saveAsItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		fileMenu.DropDownItems.Add(exportHtmlItem);
		fileMenu.DropDownItems.Add(exportPdfItem);
		fileMenu.DropDownItems.Add(printItem);
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		fileMenu.DropDownItems.Add("文字コードを指定して再読込(&R)...", null, (_, _) => PostBridgeEvent("menu:reloadWithEncoding"));
		fileMenu.DropDownItems.Add(new ToolStripSeparator());
		fileMenu.DropDownItems.Add("終了(&X)", null, (_, _) => Close());

		var editMenu = new ToolStripMenuItem("編集(&E)");
		var findItem = new ToolStripMenuItem(
			"検索(&F)...",
			null,
			(_, _) => PostBridgeEvent("menu:find"))
		{
			ShortcutKeyDisplayString = "Ctrl+F",
		};
		var replaceItem = new ToolStripMenuItem(
			"置換(&R)...",
			null,
			(_, _) => PostBridgeEvent("menu:replace"))
		{
			ShortcutKeyDisplayString = "Ctrl+R",
		};
		var findNextItem = new ToolStripMenuItem(
			"次を検索(&N)",
			null,
			(_, _) => PostBridgeEvent("menu:findNext"))
		{
			ShortcutKeyDisplayString = "F3",
		};
		var findPreviousItem = new ToolStripMenuItem(
			"前を検索(&P)",
			null,
			(_, _) => PostBridgeEvent("menu:findPrevious"))
		{
			ShortcutKeyDisplayString = "Shift+F3",
		};
		editMenu.DropDownItems.Add(findItem);
		editMenu.DropDownItems.Add(replaceItem);
		editMenu.DropDownItems.Add(new ToolStripSeparator());
		editMenu.DropDownItems.Add(findNextItem);
		editMenu.DropDownItems.Add(findPreviousItem);

		var viewMenu = new ToolStripMenuItem("表示(&V)");
		var toggleViewModeItem = new ToolStripMenuItem(
			"ソース / ライブプレビュー切替(&E)",
			null,
			(_, _) => PostBridgeEvent("menu:toggleViewMode"));
		// ショートカット本体は Web 層（config keybindings）が処理する。表示のみ付与する。
		toggleViewModeItem.ShortcutKeyDisplayString = "Ctrl+E";
		viewMenu.DropDownItems.Add(toggleViewModeItem);
		var toggleOutlineItem = new ToolStripMenuItem(
			"アウトラインを表示 / 非表示(&O)",
			null,
			(_, _) => PostBridgeEvent("menu:toggleOutline"));
		toggleOutlineItem.ShortcutKeyDisplayString = "Ctrl+Shift+O";
		viewMenu.DropDownItems.Add(toggleOutlineItem);
		viewMenu.DropDownItems.Add(new ToolStripSeparator());

		var splitHorizontalItem = new ToolStripMenuItem(
			"上下に分割(&H)",
			null,
			(_, _) => PostBridgeEvent("menu:splitHorizontal"))
		{
			ShortcutKeyDisplayString = "Ctrl+Shift+-",
		};
		var splitVerticalItem = new ToolStripMenuItem(
			"左右に分割(&V)",
			null,
			(_, _) => PostBridgeEvent("menu:splitVertical"))
		{
			ShortcutKeyDisplayString = "Ctrl+Shift+\\",
		};
		var unsplitItem = new ToolStripMenuItem(
			"分割解除(&U)",
			null,
			(_, _) => PostBridgeEvent("menu:unsplit"))
		{
			ShortcutKeyDisplayString = "Ctrl+Shift+U",
		};
		viewMenu.DropDownItems.Add(splitHorizontalItem);
		viewMenu.DropDownItems.Add(splitVerticalItem);
		viewMenu.DropDownItems.Add(unsplitItem);

		var settingsMenu = new ToolStripMenuItem("設定(&S)");
		settingsMenu.DropDownItems.Add("設定を開く(&S)...", null, (_, _) => PostBridgeEvent("menu:openSettings"));
		settingsMenu.DropDownItems.Add(new ToolStripSeparator());
		settingsMenu.DropDownItems.Add("CSSスニペットを再読込(&R)", null, (_, _) => PostBridgeEvent("menu:reloadCssSnippets"));
		settingsMenu.DropDownItems.Add("CSSスニペットフォルダを開く(&O)", null, (_, _) => PostBridgeEvent("menu:openSnippetsFolder"));

		var helpMenu = new ToolStripMenuItem("ヘルプ(&H)");
		helpMenu.DropDownItems.Add("開発者ツール(&D)", null, (_, _) =>
		{
			_webView.CoreWebView2?.OpenDevToolsWindow();
		});
		helpMenu.DropDownItems.Add(new ToolStripSeparator());
		helpMenu.DropDownItems.Add("更新を確認(&U)", null, (_, _) => PostBridgeEvent("menu:checkForUpdates"));
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
		menuStrip.Items.Add(viewMenu);
		menuStrip.Items.Add(settingsMenu);
		menuStrip.Items.Add(helpMenu);

		return menuStrip;
	}

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
				PostBridgeEvent("app:openFiles", new { files = new[] { filePath } });
			});
		}
	}

	private static string GetDisplayVersion()
	{
		string version = typeof(MainForm).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
			?? typeof(MainForm).Assembly.GetName().Version?.ToString()
			?? "unknown";

		return version.Split('+')[0];
	}

	/// <summary>切り離し元ウィンドウが保存したタブ状態を読み込む</summary>
	private JsonElement? LoadDetachedTab(string[] args)
	{
		string? transferPath = StartupArguments.GetDetachedTabPath(args);
		return transferPath is null ? null : LoadDetachedTabFile(transferPath);
	}

	private JsonElement? LoadDetachedTabFile(string transferPath)
	{
		try
		{
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(transferPath));
			return document.RootElement.Clone();
		}
		catch (Exception ex)
		{
			_appContext.Logger.Error("shell", "切り離しタブ状態の読み込みに失敗しました", new Dictionary<string, object?> { ["error"] = ex.Message });
			return null;
		}
		finally
		{
			try
			{
				if (File.Exists(transferPath)) File.Delete(transferPath);
			}
			catch (Exception ex)
			{
				_appContext.Logger.Warn("shell", "切り離しタブ状態ファイルを削除できませんでした", new Dictionary<string, object?> { ["error"] = ex.Message });
			}
		}
	}

	private bool ReceiveDetachedTab(DetachedTabTransferRequest request)
	{
		JsonElement? tab = LoadDetachedTabFile(request.TransferPath);
		if (tab is null) return false;

		var pending = new PendingDetachedTab(tab.Value, request.ScreenX, request.ScreenY);
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

	private void PostDetachedTab(PendingDetachedTab pending)
	{
		Point clientPoint = _webView.PointToClient(new Point(pending.ScreenX, pending.ScreenY));
		PostBridgeEvent("app:receiveDetachedTab", new
		{
			tab = pending.Tab,
			clientX = clientPoint.X,
			clientY = clientPoint.Y,
		});
	}

	private void HandleExternalOpenRequest(string[] args)
	{
		string[] files = StartupArguments.ResolveFilePaths(args);
		if (files.Length > 0)
		{
			PostBridgeEvent("app:openFiles", new { files });
		}

		if (WindowState == FormWindowState.Minimized)
		{
			WindowState = FormWindowState.Normal;
		}

		Show();
		BringToFront();
		Activate();
	}

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

	private sealed record PendingDetachedTab(JsonElement Tab, int ScreenX, int ScreenY);
}
