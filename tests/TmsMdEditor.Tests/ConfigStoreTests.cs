// ==============================================
// アプリ設定の保存とスキーマ移行
// ==============================================

// 一時ディレクトリ上の設定で、既定値、正規化、スキーマ移行、data ディレクトリの移動、バックアップ復旧を固定する

using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// AppData を一時ディレクトリへ差し替えて、設定ストアの読込と保存を検証する
/// ポータブル状態は各テストの前後で戻す
/// </summary>
public class ConfigStoreTests : IDisposable
{
	/// <summary>
	/// 設定ファイルを置く一時ルート。テストごとに作り、Dispose で削除する
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// 設定ストアへ渡す実ロガー。ログの文面は検証しない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// data ディレクトリの指示を読む実ストア
	/// </summary>
	private readonly BootstrapConfigStore _bootstrapConfigStore;

	/// <summary>
	/// 検証対象。一時ルートを AppData にしたあとに使う
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// ポータブル状態を戻し、一時ディレクトリを AppData の代わりにする
	/// 設定ファイルはこの時点では作らない
	/// </summary>
	public ConfigStoreTests()
	{
		PortableRuntime.ResetForTests();
		_tempRoot              = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-test-{Guid.NewGuid():N}");
		_logger                = new Logger();
		_bootstrapConfigStore  = new BootstrapConfigStore(_logger);
		_configStore           = new ConfigStore(_logger, _bootstrapConfigStore);
		AppPaths.SetOverrideAppDataRoot(_tempRoot);
	}

	/// <summary>
	/// ポータブル状態と AppData の差し替えを戻し、一時ディレクトリが残っていれば削除する
	/// </summary>
	public void Dispose()
	{
		PortableRuntime.ResetForTests();
		AppPaths.SetOverrideAppDataRoot(null);

		// 一時ディレクトリが残っているときだけ削除する。無いときは何もしない
		if (Directory.Exists(_tempRoot))
		{
			Directory.Delete(_tempRoot, recursive: true);
		}
	}

	/// <summary>
	/// 初回の読込でブートストラップと設定ファイルを作り、テーマは system、セッション復元はオフ、下線の装飾が1件入る
	/// </summary>
	[Fact]
	public void Load_creates_default_config_and_bootstrap_files()
	{
		// 初回読込で作った既定設定。失敗時は Success が false
		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success);
		Assert.True(File.Exists(AppPaths.BootstrapConfigPath));
		Assert.True(File.Exists(AppPaths.GetConfigPath(AppPaths.DefaultDataDir)));
		Assert.Equal("system", result.Config.Settings.Theme);
		Assert.False(result.Config.Settings.RestoreSessionOnStartup);
		Assert.Single(result.Config.CustomDecorations);
		Assert.Equal("下線", result.Config.CustomDecorations[0].Name);
		Assert.Equal("_v(.+?)_v", result.Config.CustomDecorations[0].Pattern);
		Assert.Equal("tms-underline", result.Config.CustomDecorations[0].CssClass);
	}

	/// <summary>
	/// PascalCase の DataDir でもブートストラップの保存先として読み、その場所に設定ファイルを作る
	/// </summary>
	[Fact]
	public void Load_reads_legacy_pascal_case_bootstrap_data_dir()
	{
		// PascalCase の DataDir が指す、まだ設定の無いディレクトリ
		string customDataDir = Path.Combine(_tempRoot, "legacy-installer-data");
		Directory.CreateDirectory(customDataDir);
		Directory.CreateDirectory(AppPaths.AppDataRoot);
		File.WriteAllText(
			AppPaths.BootstrapConfigPath,
			$$"""
			{"SchemaVersion":1,"DataDir":"{{customDataDir.Replace("\\", "\\\\")}}"}
			""");

		// PascalCase の DataDir を保存先として読んだ結果。失敗時は Message に理由がある
		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success, result.Message);
		Assert.Equal(customDataDir, _bootstrapConfigStore.Load().DataDir);
		Assert.True(File.Exists(AppPaths.GetConfigPath(customDataDir)));
	}

	/// <summary>
	/// テーマの更新は保存され、再読込でも残り、バックアップが1件以上できる
	/// </summary>
	[Fact]
	public void Save_persists_settings_and_creates_backup()
	{
		_configStore.Load();

		// テーマを dark にした保存結果。失敗時は Success が false
		SaveConfigResult saveResult = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"theme":"dark"}""").RootElement);

		Assert.True(saveResult.Success);
		Assert.Equal("dark", saveResult.Config?.Settings.Theme);

		// 保存後に読み直した設定。テーマは dark のまま
		LoadConfigResult reload = _configStore.Load();
		Assert.Equal("dark", reload.Config.Settings.Theme);
		Assert.True(Directory.EnumerateFiles(AppPaths.GetBackupDirectory(AppPaths.DefaultDataDir)).Any());
	}

	/// <summary>
	/// 外部ブラウザの指定が無い初期設定は、既定のブラウザでコマンドは空である
	/// </summary>
	[Fact]
	public void Load_supplies_default_external_browser_settings()
	{
		// 外部ブラウザ項目の無い初期設定。コマンドは空
		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success, result.Message);
		Assert.Equal("default", result.Config.Settings.ExternalBrowser.Mode);
		Assert.Equal(string.Empty, result.Config.Settings.ExternalBrowser.CustomCommand);
	}

	/// <summary>
	/// 初期のコンテキストメニューには copy、openLink、closeOthers があり、エディタ側の非表示項目は空である
	/// </summary>
	[Fact]
	public void Load_supplies_default_context_menu_settings()
	{
		// コンテキストメニューの初期設定。エディタ側の非表示は空
		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success, result.Message);
		Assert.Contains("copy", result.Config.Settings.ContextMenu.EditorOrder);
		Assert.Contains("openLink", result.Config.Settings.ContextMenu.EditorOrder);
		Assert.Contains("closeOthers", result.Config.Settings.ContextMenu.TabOrder);
		Assert.Empty(result.Config.Settings.ContextMenu.EditorHidden);
	}

	/// <summary>
	/// コンテキストメニューの並びから未知の項目と重複を除き、非表示は既知の copy だけが残る
	/// </summary>
	[Fact]
	public void UpdateSettings_normalizes_context_menu_order_and_hidden_items()
	{
		_configStore.Load();

		// 未知の項目と重複を含む並びと非表示を渡した保存結果
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse(
				"""{"contextMenu":{"editorOrder":["copy","unknown","copy"],"editorHidden":["copy","unknown","copy"]}}""")
				.RootElement);

		Assert.True(update.Success, update.Message);
		// 未知と重複を除いたメニュー設定。非表示は copy だけ
		ContextMenuSettings settings = Assert.IsType<ContextMenuSettings>(update.Config?.Settings.ContextMenu);
		Assert.Equal("copy", settings.EditorOrder[0]);
		Assert.Equal(settings.EditorOrder.Count, settings.EditorOrder.Distinct().Count());
		Assert.DoesNotContain("unknown", settings.EditorOrder);
		Assert.Equal(["copy"], settings.EditorHidden);
	}

	/// <summary>
	/// 末尾へ足した pastePlain は paste の直後へ戻る
	/// </summary>
	[Fact]
	public void UpdateSettings_places_appended_paste_plain_after_paste()
	{
		_configStore.Load();
		// 正規化の基準にする既定の並び。pastePlain の位置を見る
		List<string> defaults = new ContextMenuSettings().EditorOrder;
		// pastePlain を除いて末尾へ足した並び。保存後は既定の位置へ戻る
		List<string> appended = [.. defaults.Where(item => item != "pastePlain"), "pastePlain"];
		// editorOrder だけを渡す更新 JSON。他の項目は既定のまま
		string payload = "{\"contextMenu\":{\"editorOrder\":"
			+ System.Text.Json.JsonSerializer.Serialize(appended)
			+ "}}";

		// 末尾へ足した並びを保存した結果。失敗時は Message に理由がある
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse(payload).RootElement);

		Assert.True(update.Success, update.Message);
		// 正規化後のメニュー設定。pastePlain は paste の直後
		ContextMenuSettings settings = Assert.IsType<ContextMenuSettings>(update.Config?.Settings.ContextMenu);
		// paste の位置。0 未満なら paste が落ちている
		int pasteIndex = settings.EditorOrder.IndexOf("paste");
		Assert.True(pasteIndex >= 0);
		Assert.Equal("pastePlain", settings.EditorOrder[pasteIndex + 1]);
		// 末尾に足した並びでも、保存後の全体は既定の項目順と一致する
		Assert.Equal(defaults, settings.EditorOrder);
	}

	/// <summary>
	/// カスタムのブラウザコマンドは、引用符付きの引数を含めて保存される
	/// </summary>
	[Fact]
	public void UpdateSettings_persists_custom_external_browser_settings()
	{
		// カスタムコマンドを載せる前の初期設定
		LoadConfigResult load = _configStore.Load();
		Assert.True(load.Success, load.Message);

		// 引用符付き引数を含むカスタムコマンドの保存結果
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse(
				"""{"externalBrowser":{"mode":"custom","customCommand":"firefox -p \"MyProfile_TMSystems\""}}""")
				.RootElement);

		Assert.True(update.Success, update.Message);
		Assert.Equal("custom", update.Config?.Settings.ExternalBrowser.Mode);
		Assert.Equal(@"firefox -p ""MyProfile_TMSystems""", update.Config?.Settings.ExternalBrowser.CustomCommand);
	}

	/// <summary>
	/// 起動時にセッションを復元する指定は保存され、再読込でもオンのままである
	/// </summary>
	[Fact]
	public void UpdateSettings_persists_session_restore_preference()
	{
		_configStore.Load();

		// 起動時復元をオンにした保存結果。再読込でもオンのまま
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"restoreSessionOnStartup":true}""").RootElement);

		Assert.True(update.Success, update.Message);
		Assert.True(update.Config?.Settings.RestoreSessionOnStartup);
		Assert.True(_configStore.Load().Config.Settings.RestoreSessionOnStartup);
	}

	/// <summary>
	/// セッション復元の項目が無い設定はオフになり、スキーマは現行へ上がる
	/// </summary>
	[Fact]
	public void Load_defaults_missing_session_restore_preference_to_off()
	{
		Directory.CreateDirectory(AppPaths.DefaultDataDir);
		File.WriteAllText(
			AppPaths.GetConfigPath(AppPaths.DefaultDataDir),
			"""{"schemaVersion":6,"settings":{}}""");

		// 復元項目の無い設定を現行スキーマへ読んだ結果。復元はオフ
		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success, result.Message);
		Assert.False(result.Config.Settings.RestoreSessionOnStartup);
		Assert.Equal(ConfigStore.CurrentSchemaVersion, result.Config.SchemaVersion);
	}

	/// <summary>
	/// 書き出し様式が無い設定は live-preview になり、同時に欠けている表示と操作の既定も埋まる
	/// </summary>
	[Fact]
	public void Load_defaults_missing_export_style_to_live_preview()
	{
		Directory.CreateDirectory(AppPaths.DefaultDataDir);
		File.WriteAllText(
			AppPaths.GetConfigPath(AppPaths.DefaultDataDir),
			"""{"schemaVersion":7,"settings":{}}""");

		// 様式の無い設定を読んだ結果。live-preview と、欠けていた既定が入る
		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success, result.Message);
		Assert.Equal("live-preview", result.Config.Settings.Export.Style);
		// NOTE: 様式以外に、アウトライン、書き出しのショートカット、コードフォント、添付先、画像枠も欠けていれば既定で埋まる
		Assert.True(result.Config.Settings.Export.Outline.Enabled);
		Assert.Equal("right", result.Config.Settings.Export.Outline.Side);
		Assert.Equal("right", result.Config.Settings.Outline.Side);
		Assert.Equal("Ctrl+Shift+H", result.Config.Settings.Keybindings.ExportHtml);
		Assert.Equal("Ctrl+Shift+P", result.Config.Settings.Keybindings.ExportPdf);
		Assert.Equal("Ctrl+P", result.Config.Settings.Keybindings.Print);
		Assert.Equal("Consolas, \"Cascadia Mono\", \"Meiryo UI\", monospace", result.Config.Settings.CodeFontFamily);
		Assert.Equal(string.Empty, result.Config.Settings.AttachmentFolder);
		Assert.Equal(1, result.Config.Settings.ImageBorder.Width);
		Assert.Equal("#888888", result.Config.Settings.ImageBorder.Color);
		Assert.Equal(3, result.Config.Settings.ImageBorder.HoverWidth);
		Assert.Equal(string.Empty, result.Config.Settings.ImageBorder.HoverColor);
	}

	/// <summary>
	/// 指定したコード用フォントは保存され、再読込でも同じ文字列で残る
	/// </summary>
	[Fact]
	public void UpdateSettings_persists_code_font_family()
	{
		_configStore.Load();

		// 指定したコード用フォントの保存結果。再読込でも同じ文字列
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse(
				"""{"codeFontFamily":"\"HackGen Console NF\", monospace"}"""
			).RootElement);

		Assert.True(update.Success, update.Message);
		Assert.Equal("\"HackGen Console NF\", monospace", update.Config?.Settings.CodeFontFamily);
		Assert.Equal("\"HackGen Console NF\", monospace", _configStore.Load().Config.Settings.CodeFontFamily);
	}

	/// <summary>
	/// 画像枠の幅、色、ホバー幅、ホバー色は、渡した値で保存される
	/// </summary>
	[Fact]
	public void UpdateSettings_persists_image_border()
	{
		_configStore.Load();

		// 幅、色、ホバー幅、ホバー色を渡した保存結果
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse(
				"""{"imageBorder":{"width":2,"color":"#444444","hoverWidth":5,"hoverColor":"#2563eb"}}"""
			).RootElement);

		Assert.True(update.Success, update.Message);
		Assert.Equal(2, update.Config?.Settings.ImageBorder.Width);
		Assert.Equal("#444444", update.Config?.Settings.ImageBorder.Color);
		Assert.Equal(5, update.Config?.Settings.ImageBorder.HoverWidth);
		Assert.Equal("#2563eb", update.Config?.Settings.ImageBorder.HoverColor);
	}

	/// <summary>
	/// 範囲外の幅と16進でない色は既定へ戻り、更新自体は成功する
	/// </summary>
	[Fact]
	public void UpdateSettings_rejects_invalid_image_border_color()
	{
		_configStore.Load();

		// 範囲外の幅と16進でない色を渡した保存結果。更新自体は成功し、値は既定へ戻る
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse(
				"""{"imageBorder":{"color":"red","hoverColor":"url(x)","width":99}}"""
			).RootElement);

		Assert.True(update.Success, update.Message);
		Assert.Equal(1, update.Config?.Settings.ImageBorder.Width);
		Assert.Equal("#888888", update.Config?.Settings.ImageBorder.Color);
		Assert.Equal(string.Empty, update.Config?.Settings.ImageBorder.HoverColor);
	}

	/// <summary>
	/// 空白だけのコード用フォントは、コンソール系の既定フォントへ戻る
	/// </summary>
	[Fact]
	public void UpdateSettings_blank_code_font_family_falls_back_to_default()
	{
		_configStore.Load();

		// 空白だけのフォントを渡した保存結果。コンソール系の既定へ戻る
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"codeFontFamily":"   "}""").RootElement);

		Assert.True(update.Success, update.Message);
		Assert.Equal("Consolas, \"Cascadia Mono\", \"Meiryo UI\", monospace", update.Config?.Settings.CodeFontFamily);
	}

	/// <summary>
	/// 書き出し様式 clean は保存され、再読込でも clean のままである
	/// </summary>
	[Fact]
	public void UpdateSettings_persists_export_style()
	{
		_configStore.Load();

		// clean を渡した保存結果。再読込でも clean のまま
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"export":{"style":"clean"}}""").RootElement);

		Assert.True(update.Success, update.Message);
		Assert.Equal("clean", update.Config?.Settings.Export.Style);
		Assert.Equal("clean", _configStore.Load().Config.Settings.Export.Style);
	}

	/// <summary>
	/// アウトラインの非表示、左配置、幅 1200 と、書き出しアウトラインのオフと左配置が保存される
	/// </summary>
	[Fact]
	public void UpdateSettings_persists_outline_side_and_export_outline()
	{
		_configStore.Load();

		// アウトラインと書き出しアウトラインの配置を渡した保存結果。様式は渡していない
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse(
				"""{"outline":{"visible":false,"side":"left","width":1200},"export":{"outline":{"enabled":false,"side":"left"}}}"""
			).RootElement);

		Assert.True(update.Success, update.Message);
		Assert.False(update.Config?.Settings.Outline.Visible);
		Assert.Equal("left", update.Config?.Settings.Outline.Side);
		Assert.Equal(1200, update.Config?.Settings.Outline.Width);
		Assert.False(update.Config?.Settings.Export.Outline.Enabled);
		Assert.Equal("left", update.Config?.Settings.Export.Outline.Side);

		// 保存後に読み直した設定。渡していない様式は live-preview のまま
		LoadConfigResult reload = _configStore.Load();
		Assert.False(reload.Config.Settings.Outline.Visible);
		Assert.Equal("left", reload.Config.Settings.Outline.Side);
		Assert.Equal(1200, reload.Config.Settings.Outline.Width);
		Assert.False(reload.Config.Settings.Export.Outline.Enabled);
		Assert.Equal("left", reload.Config.Settings.Export.Outline.Side);
		// 書き出し様式は渡していないので、live-preview のまま残る
		Assert.Equal("live-preview", reload.Config.Settings.Export.Style);
	}

	/// <summary>
	/// 範囲外のアウトライン幅は 300 へ戻る
	/// </summary>
	[Fact]
	public void UpdateSettings_restores_default_for_invalid_outline_width()
	{
		_configStore.Load();

		// 範囲外の幅を渡した保存結果。幅は 300 へ戻る
		SaveConfigResult update = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"outline":{"width":9999}}""").RootElement);

		Assert.True(update.Success, update.Message);
		Assert.Equal(300, update.Config?.Settings.Outline.Width);
	}

	/// <summary>
	/// 新規の既定設定では、起動時のアウトラインは表示である
	/// </summary>
	[Fact]
	public void CreateDefaultConfig_shows_outline_on_startup()
	{
		// 新規インストールの既定設定。起動時のアウトラインは表示
		AppConfigDocument config = ConfigStore.CreateDefaultConfig();

		Assert.True(config.Settings.Outline.Visible);
	}

	/// <summary>
	/// 表示指定の無い既存設定は、移行後もアウトラインを非表示のままにする
	/// </summary>
	[Fact]
	public void Load_migrates_existing_install_to_keep_outline_hidden()
	{
		Directory.CreateDirectory(AppPaths.DefaultDataDir);
		File.WriteAllText(
			AppPaths.GetConfigPath(AppPaths.DefaultDataDir),
			"""{"schemaVersion":8,"settings":{"outline":{"side":"left"}}}""");

		// 表示指定の無い既存設定を移行した読込結果。アウトラインは非表示のまま
		LoadConfigResult result = _configStore.Load();

		Assert.True(result.Success, result.Message);
		Assert.False(result.Config.Settings.Outline.Visible);
		Assert.Equal("left", result.Config.Settings.Outline.Side);
		Assert.Equal(ConfigStore.CurrentSchemaVersion, result.Config.SchemaVersion);

		// ファイルへ残った移行後の設定。表示は false のまま
		AppConfigDocument persisted = JsonFileHelper.Read<AppConfigDocument>(AppPaths.GetConfigPath(AppPaths.DefaultDataDir));
		Assert.False(persisted.Settings.Outline.Visible);
	}

	/// <summary>
	/// outline.visible を初期化すると、起動時のアウトラインは表示へ戻る
	/// </summary>
	[Fact]
	public void ResetSettingItem_restores_outline_startup_visibility()
	{
		_configStore.Load();
		_configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"outline":{"visible":false}}""").RootElement);

		// outline.visible を初期化した結果。起動時の表示は true へ戻る
		SaveConfigResult reset = _configStore.ResetSettingItem("outline.visible");

		Assert.True(reset.Success, reset.Message);
		Assert.True(reset.Config?.Settings.Outline.Visible);
	}

	/// <summary>
	/// 日本語名の装飾ルールはパターンとクラス名ごと保存され、再読込でも残る
	/// </summary>
	[Fact]
	public void UpdateCustomDecorations_persists_japanese_rule()
	{
		// 装飾を置き換える前の初期設定。既定の下線が1件ある
		LoadConfigResult load = _configStore.Load();
		Assert.True(load.Success, load.Message);

		// 日本語名のルール1件で置き換えた保存結果
		SaveConfigResult update = _configStore.UpdateCustomDecorations(
		[
			// パターンとクラス名を持つ日本語の装飾。有効のまま保存する
			new CustomDecorationRule
			{
				// 保存後も残すルール名
				Name           = "重要・要確認",
				// 有効。false だと装飾を適用しない
				Enabled        = true,
				// 隅付き括弧の中を取るパターン。改行は含めない
				Pattern        = "【([^】\\n]+)】",
				// 区切り文字を表示しない
				HideDelimiters = true,
				// 適用する CSS クラス。空だと装飾が付かない
				CssClass       = "tms-important-ja",
			},
		]);

		Assert.True(update.Success, update.Message);
		// 保存された唯一のルール。名前、パターン、クラスを見る
		CustomDecorationRule rule = Assert.Single(update.Config?.CustomDecorations ?? []);
		Assert.Equal("重要・要確認", rule.Name);
		Assert.Equal("【([^】\\n]+)】", rule.Pattern);
		Assert.Equal("tms-important-ja", rule.CssClass);

		// 再読込した設定。ルール名が残る
		LoadConfigResult reload = _configStore.Load();
		Assert.Equal("重要・要確認", Assert.Single(reload.Config.CustomDecorations).Name);
	}

	/// <summary>
	/// 空の装飾リストを明示して保存すると、既定の下線は復活せず空のまま残る
	/// </summary>
	[Fact]
	public void UpdateCustomDecorations_keeps_explicitly_empty_list()
	{
		// 空リストで置き換える前の初期設定。既定の下線がある
		LoadConfigResult load = _configStore.Load();
		Assert.True(load.Success, load.Message);

		// 空リストを明示して保存した結果。既定の下線は復活しない
		SaveConfigResult update = _configStore.UpdateCustomDecorations([]);

		Assert.True(update.Success, update.Message);
		Assert.Empty(update.Config?.CustomDecorations ?? []);
		Assert.Equal(ConfigStore.CurrentSchemaVersion, update.Config?.SchemaVersion);

		// 再読込した設定。装飾は空のまま
		LoadConfigResult reload = _configStore.Load();
		Assert.Empty(reload.Config.CustomDecorations);
	}

	/// <summary>
	/// インストーラが指示した移行元から設定を移し、移行元の指定は空になる
	/// </summary>
	[Fact]
	public void Load_applies_pending_installer_data_dir_migration()
	{
		// 移行元になる初期設定。この時点の data が移動元
		LoadConfigResult initial = _configStore.Load();
		Assert.True(initial.Success, initial.Message);

		// 移行後も残る dark を書いた保存結果
		SaveConfigResult saveResult = _configStore.UpdateSettings(
			System.Text.Json.JsonDocument.Parse("""{"theme":"dark"}""").RootElement);
		Assert.True(saveResult.Success, saveResult.Message);

		// インストーラが移す元の data。dark の設定がここにある
		string oldDataDir = AppPaths.DefaultDataDir;
		// インストーラが指示する移動先。まだ設定は無い
		string newDataDir = Path.Combine(_tempRoot, "installer-updated-data");
		Directory.CreateDirectory(newDataDir);

		// 移動先と、まだ空になっていない移行元を同時に指すブートストラップ
		_bootstrapConfigStore.Save(new BootstrapConfigDocument
		{
			// 現行のブートストラップスキーマ。古い版のままでは移行指示を読まない
			SchemaVersion             = BootstrapConfigStore.CurrentSchemaVersion,
			// 移行後に設定を置く data
			DataDir                   = newDataDir,
			// 設定をコピーする元。成功後は空になる
			PendingMigrationSourceDir = oldDataDir,
		});

		// 移行指示を適用した読込結果。テーマは dark のまま
		LoadConfigResult migrated = _configStore.Load();

		Assert.True(migrated.Success, migrated.Message);
		Assert.Equal("dark", migrated.Config.Settings.Theme);
		Assert.True(File.Exists(AppPaths.GetConfigPath(newDataDir)));
		Assert.Equal(string.Empty, _bootstrapConfigStore.Load().PendingMigrationSourceDir);
	}

	/// <summary>
	/// スキーマ1の既定 Ctrl+H は Ctrl+R へ移行し、バックアップが残る
	/// </summary>
	[Fact]
	public void Load_migrates_legacy_default_replace_shortcut_to_ctrl_r()
	{
		// スキーマ1へ戻し、置換を当時の既定 Ctrl+H にした設定。ファイルへ書いてから読み直す
		AppConfigDocument config = _configStore.Load().Config;
		config.SchemaVersion = 1;
		config.Settings.Keybindings.Replace = "Ctrl+H";
		JsonFileHelper.WriteAtomic(AppPaths.GetConfigPath(AppPaths.DefaultDataDir), config);

		// 移行後の読込。スキーマは現行、置換は Ctrl+R
		LoadConfigResult reload = _configStore.Load();

		Assert.True(reload.Success);
		Assert.Equal(ConfigStore.CurrentSchemaVersion, reload.Config.SchemaVersion);
		Assert.Equal("Ctrl+R", reload.Config.Settings.Keybindings.Replace);

		// ファイルへ残った移行後の設定。バックアップとは別
		AppConfigDocument persisted = JsonFileHelper.Read<AppConfigDocument>(AppPaths.GetConfigPath(AppPaths.DefaultDataDir));
		Assert.Equal(ConfigStore.CurrentSchemaVersion, persisted.SchemaVersion);
		Assert.Equal("Ctrl+R", persisted.Settings.Keybindings.Replace);
		Assert.True(Directory.EnumerateFiles(AppPaths.GetBackupDirectory(AppPaths.DefaultDataDir)).Any());
	}

	/// <summary>
	/// スキーマ1でも独自の置換ショートカットは、移行後もそのまま残る
	/// </summary>
	[Fact]
	public void Load_preserves_custom_replace_shortcut_during_schema_migration()
	{
		// スキーマ1でも独自の Ctrl+Alt+R を残す設定
		AppConfigDocument config = _configStore.Load().Config;
		config.SchemaVersion = 1;
		config.Settings.Keybindings.Replace = "Ctrl+Alt+R";
		JsonFileHelper.WriteAtomic(AppPaths.GetConfigPath(AppPaths.DefaultDataDir), config);

		// 移行後の読込。独自の置換ショートカットは変わらない
		LoadConfigResult reload = _configStore.Load();

		Assert.True(reload.Success);
		Assert.Equal(ConfigStore.CurrentSchemaVersion, reload.Config.SchemaVersion);
		Assert.Equal("Ctrl+Alt+R", reload.Config.Settings.Keybindings.Replace);
	}

	/// <summary>
	/// スキーマ2の Ctrl+Shift+0 は、Windows の予約を避けて Ctrl+Shift+U へ移行する
	/// </summary>
	[Fact]
	public void Load_migrates_windows_reserved_unsplit_shortcut()
	{
		// スキーマ2へ戻し、分割解除を予約済みの Ctrl+Shift+0 にした設定
		AppConfigDocument config = _configStore.Load().Config;
		config.SchemaVersion = 2;
		config.Settings.Keybindings.Unsplit = "Ctrl+Shift+0";
		JsonFileHelper.WriteAtomic(AppPaths.GetConfigPath(AppPaths.DefaultDataDir), config);

		// 予約を避けて Ctrl+Shift+U へ移行した読込
		LoadConfigResult reload = _configStore.Load();

		Assert.True(reload.Success);
		Assert.Equal(ConfigStore.CurrentSchemaVersion, reload.Config.SchemaVersion);
		Assert.Equal("Ctrl+Shift+U", reload.Config.Settings.Keybindings.Unsplit);

		// ファイルへ残った移行後の分割解除。Ctrl+Shift+U のまま
		AppConfigDocument persisted = JsonFileHelper.Read<AppConfigDocument>(AppPaths.GetConfigPath(AppPaths.DefaultDataDir));
		Assert.Equal("Ctrl+Shift+U", persisted.Settings.Keybindings.Unsplit);
	}

	/// <summary>
	/// スキーマ2でも独自の分割解除ショートカットは、移行後もそのまま残る
	/// </summary>
	[Fact]
	public void Load_preserves_custom_unsplit_shortcut_during_schema_migration()
	{
		// スキーマ2でも独自の Ctrl+Alt+U を残す設定
		AppConfigDocument config = _configStore.Load().Config;
		config.SchemaVersion = 2;
		config.Settings.Keybindings.Unsplit = "Ctrl+Alt+U";
		JsonFileHelper.WriteAtomic(AppPaths.GetConfigPath(AppPaths.DefaultDataDir), config);

		// 移行後の読込。独自の分割解除は変わらない
		LoadConfigResult reload = _configStore.Load();

		Assert.Equal("Ctrl+Alt+U", reload.Config.Settings.Keybindings.Unsplit);
	}

	/// <summary>
	/// スキーマ3の空の装飾は、下線の既定ルール1件へ移行する
	/// </summary>
	[Fact]
	public void Load_migrates_legacy_empty_custom_decorations_to_default_rule()
	{
		// スキーマ3へ戻し、装飾を空にした設定。空は未設定として既定の下線へ補う
		AppConfigDocument config = _configStore.Load().Config;
		config.SchemaVersion = 3;
		config.CustomDecorations.Clear();
		JsonFileHelper.WriteAtomic(AppPaths.GetConfigPath(AppPaths.DefaultDataDir), config);

		// 空の装飾を既定の下線1件へ補った読込
		LoadConfigResult reload = _configStore.Load();

		Assert.Equal(ConfigStore.CurrentSchemaVersion, reload.Config.SchemaVersion);
		// 補われた既定の下線。パターンは新しい記法
		CustomDecorationRule rule = Assert.Single(reload.Config.CustomDecorations);
		Assert.Equal("下線", rule.Name);
		Assert.Equal("_v(.+?)_v", rule.Pattern);
	}

	/// <summary>
	/// 下線ルールの古いチルダパターンだけを新しいパターンへ替え、無効のままにし、同パターンの独自ルールは変えない
	/// </summary>
	[Fact]
	public void Load_migrates_legacy_default_underline_pattern_without_changing_custom_rule()
	{
		// スキーマ4の下線と、同じチルダパターンの独自ルールを並べた設定
		AppConfigDocument config = _configStore.Load().Config;
		config.SchemaVersion = 4;
		config.CustomDecorations =
		[
			// 名前が下線の既定ルール。パターンだけ新しい記法へ替え、無効のまま残す
			new CustomDecorationRule
			{
				// 移行対象を見分ける既定の名前
				Name           = "下線",
				// 無効のまま移行する。有効には戻さない
				Enabled        = false,
				// 取り消し線と競合し得る古いチルダパターン。これだけを替える
				Pattern        = "~([^~\\n]+)~",
				// 区切りを隠す指定。移行では変えない
				HideDelimiters = true,
				// 下線用の CSS クラス。移行では変えない
				CssClass       = "tms-underline",
			},
			// 同じパターンでも名前が下線ではない独自ルール。パターンは変えない
			new CustomDecorationRule
			{
				// 移行対象から外す独自の名前
				Name           = "独自チルダ",
				// 有効のまま残す
				Enabled        = true,
				// 下線と同じ古いパターン。独自ルールなので残す
				Pattern        = "~([^~\\n]+)~",
				// 区切りを隠す指定。移行では変えない
				HideDelimiters = true,
				// 独自ルールの CSS クラス。移行では変えない
				CssClass       = "tms-custom-tilde",
			},
		];
		JsonFileHelper.WriteAtomic(AppPaths.GetConfigPath(AppPaths.DefaultDataDir), config);

		// 下線だけパターンを替えた読込。独自ルールのパターンは残る
		LoadConfigResult reload = _configStore.Load();

		Assert.Equal("_v(.+?)_v", reload.Config.CustomDecorations[0].Pattern);
		Assert.False(reload.Config.CustomDecorations[0].Enabled);
		Assert.Equal("~([^~\\n]+)~", reload.Config.CustomDecorations[1].Pattern);
	}

	/// <summary>
	/// 設定の移行でブートストラップの data ディレクトリが新しい場所を指し、テーマは残る
	/// </summary>
	[Fact]
	public void MigrateDataDir_copies_config_and_updates_bootstrap_pointer()
	{
		_configStore.Load();
		_configStore.UpdateSettings(System.Text.Json.JsonDocument.Parse("""{"theme":"light"}""").RootElement);
		// 設定に加え、セッションとノート表示位置も移ることを見るため、両方のファイルを置いてから移す
		File.WriteAllText(
			AppPaths.GetSessionPath(AppPaths.DefaultDataDir),
			"""{"schemaVersion":1,"tabs":[{"tabId":"tab-1","filePath":"C:\\docs\\one.md"}]}""");
		File.WriteAllText(
			AppPaths.GetNoteViewPositionsPath(AppPaths.DefaultDataDir),
			"""{"schemaVersion":1,"entries":[{"filePath":"C:\\docs\\one.md","anchor":10}]}""");

		// 移す先。まだ存在しない
		string newDataDir = Path.Combine(_tempRoot, "custom-data");
		// 設定、セッション、表示位置を移した結果。失敗時は Success が false
		MigrateDataDirResult migrateResult = _configStore.MigrateDataDir(newDataDir);

		Assert.True(migrateResult.Success);
		Assert.Equal(newDataDir, migrateResult.DataDir);
		Assert.True(File.Exists(AppPaths.GetConfigPath(newDataDir)));
		Assert.True(File.Exists(AppPaths.GetSessionPath(newDataDir)));
		Assert.Contains("tab-1", File.ReadAllText(AppPaths.GetSessionPath(newDataDir)));
		Assert.True(File.Exists(AppPaths.GetNoteViewPositionsPath(newDataDir)));
		Assert.Contains("one.md", File.ReadAllText(AppPaths.GetNoteViewPositionsPath(newDataDir)));

		// 移動後のブートストラップ。DataDir が新しい場所を指す
		BootstrapConfigDocument bootstrap = _bootstrapConfigStore.Load();
		Assert.Equal(newDataDir, bootstrap.DataDir);

		// 新しい場所から読み直した設定。テーマは light のまま
		LoadConfigResult reload = _configStore.Load();
		Assert.Equal("light", reload.Config.Settings.Theme);
	}

	/// <summary>
	/// 移行済みの data ディレクトリが無いときは失敗し、元のパスを作り直さない
	/// </summary>
	[Fact]
	public void Load_does_not_recreate_missing_custom_data_directory()
	{
		_configStore.Load();
		// 一度移した data。直後に名前を変えて欠落させる
		string customDataDir = Path.Combine(_tempRoot, "custom-data");
		Assert.True(_configStore.MigrateDataDir(customDataDir).Success);

		// 改名後の実体。読込はこちらを探さない
		string renamedDataDir = Path.Combine(_tempRoot, "custom-data-renamed");
		Directory.Move(customDataDir, renamedDataDir);

		// 欠落した data の読込。Success は false で、元のパスは作られない
		LoadConfigResult reload = _configStore.Load();

		Assert.False(reload.Success);
		Assert.Contains("dataDir が見つかりません", reload.Message);
		Assert.False(Directory.Exists(customDataDir));
	}

	/// <summary>
	/// 全設定の初期化後もウィンドウ幅、独自装飾、最近使ったファイルは残り、テーマは system に戻る
	/// </summary>
	[Fact]
	public void ResetAllSettings_keeps_window_and_custom_data()
	{
		// 初期化後も残すウィンドウ幅、装飾、最近使ったファイルを載せた設定。テーマは後で dark にする
		AppConfigDocument config = _configStore.Load().Config;
		config.Window.Width = 1200;
		config.CustomDecorations.Clear();
		// 初期化後も残す独自装飾。名前、パターン、クラスの3つを明示する
		// ルール名。既定の下線とは別で、初期化後もこの名前のまま
		// パターン。初期化では消さない
		// CSS クラス。初期化では消さない
		config.CustomDecorations.Add(new CustomDecorationRule { Name = "underline", Pattern = "~(.+)~", CssClass = "tms-underline" });
		config.RecentFiles.Add("C:\\sample.md");

		// 幅と装飾と最近使ったファイルを書いた保存。失敗すると初期化の前提が崩れる
		SaveConfigResult initialSave = _configStore.Save(config);
		Assert.True(initialSave.Success, initialSave.Message);

		// 初期化で system へ戻ることを見るための dark
		SaveConfigResult themeSave = _configStore.UpdateSettings(System.Text.Json.JsonDocument.Parse("""{"theme":"dark"}""").RootElement);
		Assert.True(themeSave.Success, themeSave.Message);

		// 全設定を初期化した結果。幅、装飾、最近使ったファイルは残る
		SaveConfigResult resetResult = _configStore.ResetAllSettings();

		Assert.True(resetResult.Success, resetResult.Message);
		Assert.Equal(1200, resetResult.Config?.Window.Width);
		Assert.Equal("system", resetResult.Config?.Settings.Theme);
		Assert.Single(resetResult.Config?.CustomDecorations ?? []);
		Assert.Equal("underline", resetResult.Config?.CustomDecorations[0].Name);
		Assert.Single(resetResult.Config?.RecentFiles ?? []);
	}

	/// <summary>
	/// 壊れた設定は最新バックアップから復旧し、テーマは dark に戻る
	/// </summary>
	[Fact]
	public void Load_recovers_from_backup_when_config_is_corrupted()
	{
		_configStore.Load();
		_configStore.UpdateSettings(System.Text.Json.JsonDocument.Parse("""{"theme":"dark"}""").RootElement);
		_configStore.UpdateSettings(System.Text.Json.JsonDocument.Parse("""{"theme":"light"}""").RootElement);

		// 壊す対象の設定ファイル。light の保存の直後に不正な JSON へする
		string configPath = AppPaths.GetConfigPath(AppPaths.DefaultDataDir);
		File.WriteAllText(configPath, "{ invalid json");

		// バックアップから復旧した読込。RecoveredFromBackup が true で、テーマは dark
		LoadConfigResult reload = _configStore.Load();

		Assert.True(reload.Success);
		Assert.True(reload.RecoveredFromBackup);
		// 破損の直前に成功した保存がバックアップを作るため、その一つ前の dark へ戻る
		Assert.Equal("dark", reload.Config.Settings.Theme);
	}
}
