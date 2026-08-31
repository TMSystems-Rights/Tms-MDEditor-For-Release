using System.Text.Json;
using System.Text.Json.Nodes;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// dataDir 配下 config.json の読み書き・移行
/// </summary>
internal sealed class ConfigStore
{
	public const int CurrentSchemaVersion = 7;

	private const string ConfigBackupPrefix = "config";
	private const string LegacyDefaultReplaceShortcut = "Ctrl+H";
	private const string LegacyDefaultUnsplitShortcut = "Ctrl+Shift+0";
	private const string LegacyDefaultUnderlinePattern = "~([^~\\n]+)~";
	private const string DefaultUnderlinePattern = "_v(.+?)_v";

	private static readonly HashSet<string> ResettableSettingKeys =
	[
		"theme",
		"editorFontFamily",
		"editorFontSize",
		"showLineNumbers",
		"showEolMarkers",
		"wordWrap",
		"defaultViewMode",
		"tabSize",
		"largeFileThresholdMb",
		"loadRemoteImages",
		"newFileEncoding",
		"newFileEol",
		"externalChangeBehavior",
		"instanceMode",
		"restoreSessionOnStartup",
		"closeAppWhenLastTabClosed",
		"outline.side",
		"export.style",
		"export.outline.enabled",
		"export.outline.side",
		"externalBrowser.mode",
		"externalBrowser.customCommand",
		"update.checkOnStartup",
		"update.skippedVersion",
		"update.lastCheckedAt",
		"cssSnippets.enabled",
		"search.restoreCalloutFoldStateOnMove",
		"keybindings.newFile",
		"keybindings.openFile",
		"keybindings.save",
		"keybindings.saveAs",
		"keybindings.closeTab",
		"keybindings.nextTab",
		"keybindings.prevTab",
		"keybindings.find",
		"keybindings.replace",
		"keybindings.findNext",
		"keybindings.findPrev",
		"keybindings.toggleViewMode",
		"keybindings.toggleOutline",
		"keybindings.splitHorizontal",
		"keybindings.splitVertical",
		"keybindings.unsplit",
		"keybindings.toggleCheckbox",
		"keybindings.exportHtml",
		"keybindings.exportPdf",
		"keybindings.print",
		"contextMenu.editorOrder",
		"contextMenu.editorHidden",
		"contextMenu.tabOrder",
		"contextMenu.tabHidden",
	];

	private readonly Logger _logger;
	private readonly BootstrapConfigStore _bootstrapConfigStore;
	private AppConfigDocument? _cachedConfig;
	private string? _cachedDataDir;

	/// <summary>
	/// 設定ストアを初期化する
	/// </summary>
	/// <param name="logger">ロガー</param>
	/// <param name="bootstrapConfigStore">ブートストラップ設定ストア</param>
	public ConfigStore(Logger logger, BootstrapConfigStore bootstrapConfigStore)
	{
		_logger               = logger;
		_bootstrapConfigStore = bootstrapConfigStore;
	}

	/// <summary>
	/// キャッシュ済み設定を取得する
	/// </summary>
	public AppConfigDocument? CachedConfig => _cachedConfig;

	/// <summary>
	/// キャッシュ済み dataDir を取得する
	/// </summary>
	public string? CachedDataDir => _cachedDataDir;

	/// <summary>
	/// 設定を読み込む
	/// </summary>
	/// <returns>読込結果</returns>
	public LoadConfigResult Load()
	{
		try
		{
			BootstrapConfigDocument bootstrap = _bootstrapConfigStore.Load();
			string dataDir                    = bootstrap.DataDir;
			if (AppPaths.IsPortable)
			{
				string portableDataDir = AppPaths.DefaultDataDir;
				if (!Path.GetFullPath(dataDir).Equals(Path.GetFullPath(portableDataDir), StringComparison.OrdinalIgnoreCase))
				{
					_logger.Warn("config", "ポータブル版のため dataDir を exe 隣の data に固定しました", new Dictionary<string, object?>
					{
						["ignored"] = dataDir,
						["dataDir"] = portableDataDir,
					});
					dataDir = portableDataDir;
					_bootstrapConfigStore.Save(new BootstrapConfigDocument
					{
						SchemaVersion = BootstrapConfigStore.CurrentSchemaVersion,
						DataDir       = portableDataDir,
					});
				}
			}
			else
			{
				TryApplyPendingMigration(bootstrap);
			}
			if (!Directory.Exists(dataDir) && !IsDefaultDataDir(dataDir))
			{
				_cachedDataDir = dataDir;
				return new LoadConfigResult
				{
					Success = false,
					Config  = CreateDefaultConfig(),
					Message = $"dataDir が見つかりません。設定を変更または復旧してください: {dataDir}",
				};
			}

			EnsureDataDirectories(dataDir);

			string configPath = AppPaths.GetConfigPath(dataDir);

			if (!File.Exists(configPath))
			{
				AppConfigDocument created = CreateDefaultConfig();
				SaveInternal(dataDir, created, createBackup: false);
				_cachedConfig  = created;
				_cachedDataDir  = dataDir;

				return new LoadConfigResult
				{
					Success = true,
					Config  = created,
				};
			}

			try
			{
				AppConfigDocument parsed = JsonFileHelper.Read<AppConfigDocument>(configPath);
				AppConfigDocument config = NormalizeConfig(parsed);
				if (ShouldPersistNormalizedConfig(parsed, config))
				{
					SaveInternal(dataDir, config, createBackup: true);
				}

				_cachedConfig = config;
				_cachedDataDir = dataDir;

				return new LoadConfigResult
				{
					Success = true,
					Config  = config,
				};
			}
			catch (Exception ex)
			{
				_logger.Warn("config", "config.json の解析に失敗しました。バックアップ復旧を試行します", new Dictionary<string, object?> { ["error"] = ex.Message });

				AppConfigDocument? restored = JsonFileHelper.TryRestoreLatestBackup<AppConfigDocument>(
					AppPaths.GetBackupDirectory(dataDir),
					ConfigBackupPrefix,
					IsValidConfig);

				if (restored is not null)
				{
					AppConfigDocument normalized = NormalizeConfig(restored);
					SaveInternal(dataDir, normalized, createBackup: false);
					_cachedConfig = normalized;
					_cachedDataDir = dataDir;

					return new LoadConfigResult
					{
						Success             = true,
						Config              = normalized,
						Message             = "設定ファイルをバックアップから復旧しました。",
						RecoveredFromBackup = true,
					};
				}

				AppConfigDocument fallback = CreateDefaultConfig();
				SaveInternal(dataDir, fallback, createBackup: false);
				_cachedConfig = fallback;
				_cachedDataDir = dataDir;

				return new LoadConfigResult
				{
					Success = false,
					Config  = fallback,
					Message = "設定ファイルの読み込みに失敗したため、既定値を使用します。",
				};
			}
		}
		catch (Exception ex)
		{
			_logger.Error("config", "設定の読み込みに失敗しました", new Dictionary<string, object?> { ["error"] = ex.Message });
			AppConfigDocument fallback = CreateDefaultConfig();
			_cachedConfig = fallback;

			return new LoadConfigResult
			{
				Success = false,
				Config  = fallback,
				Message = ex.Message,
			};
		}
	}

	/// <summary>
	/// 設定を保存する
	/// </summary>
	/// <param name="config">設定</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult Save(AppConfigDocument config)
	{
		try
		{
			string dataDir               = GetCurrentDataDir();
			if (!Directory.Exists(dataDir) && !IsDefaultDataDir(dataDir))
			{
				return new SaveConfigResult
				{
					Success = false,
					Message = $"dataDir が見つかりません。設定を変更または復旧してください: {dataDir}",
				};
			}

			AppConfigDocument normalized = NormalizeConfig(config);
			SaveInternal(dataDir, normalized, createBackup: true);
			_cachedConfig = normalized;
			_cachedDataDir = dataDir;

			return new SaveConfigResult
			{
				Success = true,
				Config  = normalized,
			};
		}
		catch (Exception ex)
		{
			_logger.Error("config", "設定の保存に失敗しました", new Dictionary<string, object?> { ["error"] = ex.Message });

			return new SaveConfigResult
			{
				Success = false,
				Message = $"設定の保存に失敗しました。{ex.Message}",
			};
		}
	}

	/// <summary>
	/// settings の一部を更新する
	/// </summary>
	/// <param name="partialSettings">更新内容</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult UpdateSettings(JsonElement partialSettings)
	{
		AppConfigDocument current = _cachedConfig ?? Load().Config;
		AppSettings merged        = MergeSettings(current.Settings, partialSettings);

		return Save(new AppConfigDocument
		{
			SchemaVersion     = current.SchemaVersion,
			Window            = current.Window,
			Settings          = merged,
			CustomDecorations = current.CustomDecorations,
			RecentFiles       = current.RecentFiles,
		});
	}

	/// <summary>
	/// 設定項目を既定値へリセットする
	/// </summary>
	/// <param name="itemKey">settings 配下 dot 記法キー</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult ResetSettingItem(string itemKey)
	{
		if (itemKey.Equals("dataDir", StringComparison.OrdinalIgnoreCase))
		{
			MigrateDataDirResult migrateResult = MigrateDataDir(BootstrapConfigStore.GetDefaultDataDir());

			return new SaveConfigResult
			{
				Success = migrateResult.Success,
				Message = migrateResult.Message,
				Config  = _cachedConfig,
			};
		}

		if (!ResettableSettingKeys.Contains(itemKey))
		{
			return new SaveConfigResult
			{
				Success = false,
				Message = $"不明な設定項目です: {itemKey}",
			};
		}

		AppConfigDocument current  = _cachedConfig ?? Load().Config;
		AppConfigDocument defaults = CreateDefaultConfig();
		object? defaultValue       = GetSettingValue(defaults.Settings, itemKey);

		if (defaultValue is null)
		{
			return new SaveConfigResult
			{
				Success = false,
				Message = $"既定値が見つかりません: {itemKey}",
			};
		}

		AppSettings nextSettings = SetSettingValue(current.Settings, itemKey, defaultValue);

		return Save(new AppConfigDocument
		{
			SchemaVersion     = current.SchemaVersion,
			Window            = current.Window,
			Settings          = NormalizeSettings(nextSettings),
			CustomDecorations = current.CustomDecorations,
			RecentFiles       = current.RecentFiles,
		});
	}

	/// <summary>
	/// settings を既定値へリセットする（window / recentFiles / customDecorations は保持）
	/// </summary>
	/// <returns>保存結果</returns>
	public SaveConfigResult ResetAllSettings()
	{
		AppConfigDocument current  = _cachedConfig ?? Load().Config;
		AppConfigDocument defaults = CreateDefaultConfig();

		return Save(new AppConfigDocument
		{
			SchemaVersion     = CurrentSchemaVersion,
			Window            = current.Window,
			Settings          = defaults.Settings,
			CustomDecorations = current.CustomDecorations,
			RecentFiles       = current.RecentFiles,
		});
	}

	/// <summary>
	/// dataDir 参照情報を取得する
	/// </summary>
	/// <returns>参照情報</returns>
	public DataDirInfo GetDataDirInfo()
	{
		BootstrapConfigDocument bootstrap = _bootstrapConfigStore.Load();

		return new DataDirInfo
		{
			DataDir        = bootstrap.DataDir,
			DefaultDataDir = BootstrapConfigStore.GetDefaultDataDir(),
			IsPortable     = AppPaths.IsPortable,
		};
	}

	/// <summary>
	/// dataDir を移行する
	/// </summary>
	/// <param name="newDataDir">新しい dataDir</param>
	/// <returns>移行結果</returns>
	public MigrateDataDirResult MigrateDataDir(string newDataDir)
	{
		if (AppPaths.IsPortable)
		{
			return new MigrateDataDirResult
			{
				Success = false,
				Message = "ポータブル版ではデータ保存先を変更できません。",
			};
		}

		string normalized = Path.GetFullPath(newDataDir.Trim());

		if (string.IsNullOrWhiteSpace(normalized))
		{
			return new MigrateDataDirResult
			{
				Success = false,
				Message = "保存先フォルダが指定されていません。",
			};
		}

		BootstrapConfigDocument bootstrap = _bootstrapConfigStore.Load();
		string oldDir                       = Path.GetFullPath(bootstrap.DataDir);

		if (normalized.Equals(oldDir, StringComparison.OrdinalIgnoreCase))
		{
			return new MigrateDataDirResult
			{
				Success = true,
				DataDir = normalized,
			};
		}

		string previousDataDir = bootstrap.DataDir;
		bool configUpdated     = false;

		try
		{
			JsonFileHelper.VerifyWritableDirectory(normalized);
			EnsureDataDirectories(normalized);

			CopyMigrationArtifacts(oldDir, normalized);

			bootstrap.DataDir = normalized;
			_bootstrapConfigStore.Save(bootstrap);
			configUpdated = true;

			LoadConfigResult reload = Load();

			_logger.Info("config", "dataDir を移行しました", new Dictionary<string, object?>
			{
				["from"] = oldDir,
				["to"]   = normalized,
			});

			return new MigrateDataDirResult
			{
				Success = reload.Success,
				DataDir = normalized,
				Message = reload.Message,
			};
		}
		catch (Exception ex)
		{
			if (configUpdated)
			{
				try
				{
					bootstrap.DataDir = previousDataDir;
					_bootstrapConfigStore.Save(bootstrap);
					_cachedDataDir = previousDataDir;
					Load();
				}
				catch (Exception rollbackEx)
				{
					_logger.Error("config", "dataDir 移行のロールバックに失敗しました", new Dictionary<string, object?> { ["error"] = rollbackEx.Message });
				}
			}

			_logger.Error("config", "dataDir の移行に失敗しました", new Dictionary<string, object?>
			{
				["error"]  = ex.Message,
				["newDir"] = normalized,
			});

			return new MigrateDataDirResult
			{
				Success = false,
				Message = ex.Message,
			};
		}
	}

	/// <summary>
	/// 既定設定を生成する
	/// </summary>
	/// <returns>既定 config.json</returns>
	public static AppConfigDocument CreateDefaultConfig()
	{
		return new AppConfigDocument
		{
			SchemaVersion = CurrentSchemaVersion,
			Window        = new WindowConfig
			{
				Width  = 1000,
				Height = 700,
			},
			Settings = new AppSettings(),
			// 仕様書 6.8.5 の例（下線）。スタイルは livePreview.css の .tms-underline
			CustomDecorations =
			[
				new CustomDecorationRule
				{
					Name            = "下線",
					Enabled         = true,
					Pattern         = DefaultUnderlinePattern,
					HideDelimiters  = true,
					CssClass        = "tms-underline",
				},
			],
		};
	}

	/// <summary>
	/// 現在の dataDir を取得する
	/// </summary>
	/// <returns>dataDir</returns>
	private string GetCurrentDataDir()
	{
		return _cachedDataDir ?? _bootstrapConfigStore.Load().DataDir;
	}

	/// <summary>
	/// カスタム装飾ルールを更新する
	/// </summary>
	/// <param name="decorations">保存するルール一覧</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult UpdateCustomDecorations(IEnumerable<CustomDecorationRule> decorations)
	{
		AppConfigDocument current = _cachedConfig ?? Load().Config;

		return Save(new AppConfigDocument
		{
			SchemaVersion     = CurrentSchemaVersion,
			Window            = current.Window,
			Settings          = current.Settings,
			CustomDecorations = [.. decorations],
			RecentFiles       = current.RecentFiles,
		});
	}

	/// <summary>
	/// 指定した dataDir が既定値かどうかを判定する。
	/// </summary>
	/// <param name="dataDir">dataDir</param>
	/// <returns>既定値の場合 true</returns>
	private static bool IsDefaultDataDir(string dataDir)
	{
		return Path.GetFullPath(dataDir).Equals(
			Path.GetFullPath(BootstrapConfigStore.GetDefaultDataDir()),
			StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// 設定を保存する（内部）
	/// </summary>
	/// <param name="dataDir">dataDir</param>
	/// <param name="config">設定</param>
	/// <param name="createBackup">バックアップ作成有無</param>
	private void SaveInternal(string dataDir, AppConfigDocument config, bool createBackup)
	{
		EnsureDataDirectories(dataDir);

		string configPath     = AppPaths.GetConfigPath(dataDir);
		string backupDirectory = AppPaths.GetBackupDirectory(dataDir);

		if (createBackup)
		{
			JsonFileHelper.CreateBackup(configPath, backupDirectory, ConfigBackupPrefix);
		}

		JsonFileHelper.WriteAtomic(configPath, config);
	}

	/// <summary>
	/// dataDir 配下の必要フォルダを確保する
	/// </summary>
	/// <param name="dataDir">dataDir</param>
	private static void EnsureDataDirectories(string dataDir)
	{
		Directory.CreateDirectory(dataDir);
		Directory.CreateDirectory(AppPaths.GetBackupDirectory(dataDir));
		Directory.CreateDirectory(AppPaths.GetSnippetsDirectory(dataDir));
	}

	/// <summary>
	/// 移行対象ファイルをコピーする
	/// </summary>
	/// <param name="oldDir">旧 dataDir</param>
	/// <param name="newDir">新 dataDir</param>
	private static void CopyMigrationArtifacts(string oldDir, string newDir)
	{
		CopyFileIfMissing(AppPaths.GetConfigPath(oldDir), AppPaths.GetConfigPath(newDir));
		CopyFileIfMissing(AppPaths.GetSessionPath(oldDir), AppPaths.GetSessionPath(newDir));
		CopyDirectoryIfMissing(AppPaths.GetSnippetsDirectory(oldDir), AppPaths.GetSnippetsDirectory(newDir));
		CopyDirectoryIfMissing(AppPaths.GetBackupDirectory(oldDir), AppPaths.GetBackupDirectory(newDir));
	}

	/// <summary>
	/// インストーラが予約した dataDir 移行を適用する。
	/// </summary>
	/// <param name="bootstrap">ブートストラップ設定</param>
	private void TryApplyPendingMigration(BootstrapConfigDocument bootstrap)
	{
		if (string.IsNullOrWhiteSpace(bootstrap.PendingMigrationSourceDir))
		{
			return;
		}

		string sourceDir = Path.GetFullPath(bootstrap.PendingMigrationSourceDir);
		string targetDir = Path.GetFullPath(bootstrap.DataDir);

		if (sourceDir.Equals(targetDir, StringComparison.OrdinalIgnoreCase) || !Directory.Exists(sourceDir))
		{
			bootstrap.PendingMigrationSourceDir = string.Empty;
			_bootstrapConfigStore.Save(bootstrap);
			return;
		}

		EnsureDataDirectories(targetDir);
		CopyMigrationArtifacts(sourceDir, targetDir);
		bootstrap.PendingMigrationSourceDir = string.Empty;
		_bootstrapConfigStore.Save(bootstrap);

		_logger.Info("config", "インストーラ予約のdataDir移行を適用しました", new Dictionary<string, object?>
		{
			["from"] = sourceDir,
			["to"]   = targetDir,
		});
	}

	/// <summary>
	/// ファイルをコピーする（宛先が無い場合のみ）
	/// </summary>
	/// <param name="sourcePath">コピー元</param>
	/// <param name="targetPath">コピー先</param>
	private static void CopyFileIfMissing(string sourcePath, string targetPath)
	{
		if (File.Exists(targetPath) || !File.Exists(sourcePath))
		{
			return;
		}

		string? targetDir = Path.GetDirectoryName(targetPath);
		if (!string.IsNullOrEmpty(targetDir))
		{
			Directory.CreateDirectory(targetDir);
		}

		File.Copy(sourcePath, targetPath, overwrite: false);
	}

	/// <summary>
	/// ディレクトリをコピーする（宛先が空の場合のみ）
	/// </summary>
	/// <param name="sourceDir">コピー元</param>
	/// <param name="targetDir">コピー先</param>
	private static void CopyDirectoryIfMissing(string sourceDir, string targetDir)
	{
		if (!Directory.Exists(sourceDir))
		{
			Directory.CreateDirectory(targetDir);
			return;
		}

		if (Directory.Exists(targetDir) && Directory.EnumerateFileSystemEntries(targetDir).Any())
		{
			return;
		}

		Directory.CreateDirectory(targetDir);

		foreach (string file in Directory.EnumerateFiles(sourceDir))
		{
			string dest = Path.Combine(targetDir, Path.GetFileName(file));
			if (!File.Exists(dest))
			{
				File.Copy(file, dest, overwrite: false);
			}
		}
	}

	/// <summary>
	/// 設定の妥当性を検証する
	/// </summary>
	/// <param name="config">設定</param>
	/// <returns>妥当なら true</returns>
	private static bool IsValidConfig(AppConfigDocument config)
	{
		return config.SchemaVersion > 0 && config.Settings is not null;
	}

	/// <summary>
	/// 設定を正規化する
	/// </summary>
	/// <param name="config">設定</param>
	/// <returns>正規化後</returns>
	private static AppConfigDocument NormalizeConfig(AppConfigDocument config)
	{
		AppConfigDocument defaults = CreateDefaultConfig();
		AppSettings settings       = NormalizeSettings(config.Settings ?? defaults.Settings);

		// schemaVersion 1 では置換ショートカットの既定値が Ctrl+H だった。
		// schemaVersion 2 への移行時だけ Ctrl+R へ寄せ、移行後のユーザー再設定は尊重する。
		if (config.SchemaVersion < 2 && ShortcutEquals(settings.Keybindings.Replace, LegacyDefaultReplaceShortcut))
		{
			settings.Keybindings.Replace = defaults.Settings.Keybindings.Replace;
		}

		// Ctrl+Shift+0 は Windows の入力言語切替予約により Win32 アプリへ届かない環境がある。
		// schemaVersion 3 への移行時だけ新しい既定値へ寄せ、ユーザー設定は尊重する。
		if (config.SchemaVersion < 3 && ShortcutEquals(settings.Keybindings.Unsplit, LegacyDefaultUnsplitShortcut))
		{
			settings.Keybindings.Unsplit = defaults.Settings.Keybindings.Unsplit;
		}

		// schemaVersion 3 以前は customDecorations: [] が未設定状態として残ることがあった。
		// v4 への移行時だけ既定の下線を補完し、v4 でユーザーが全削除した空配列は保持する。
		List<CustomDecorationRule> decorations = config.CustomDecorations ?? [];
		if (config.SchemaVersion < 4 && decorations.Count == 0)
		{
			decorations = defaults.CustomDecorations;
		}

		// v4 までの既定下線は Markdown の取り消し線記法 ~~...~~ と競合し得るため、
		// 既定値そのものが残っているルールだけを、Obsidian で未使用の _v..._v 記法へ移行する。
		if (config.SchemaVersion < 5)
		{
			foreach (CustomDecorationRule decoration in decorations)
			{
				if (decoration.Name == "下線"
					&& decoration.Pattern == LegacyDefaultUnderlinePattern
					&& decoration.HideDelimiters
					&& decoration.CssClass == "tms-underline")
				{
					decoration.Pattern = DefaultUnderlinePattern;
				}
			}
		}

		return new AppConfigDocument
		{
			SchemaVersion     = CurrentSchemaVersion,
			Window            = NormalizeWindow(config.Window, defaults.Window),
			Settings          = settings,
			CustomDecorations = decorations,
			RecentFiles       = config.RecentFiles ?? [],
		};
	}

	/// <summary>
	/// 読み込み後に正規化結果を config.json へ反映すべきか判定する
	/// </summary>
	/// <param name="parsed">読込直後の設定</param>
	/// <param name="normalized">正規化後の設定</param>
	/// <returns>保存が必要なら true</returns>
	private static bool ShouldPersistNormalizedConfig(AppConfigDocument parsed, AppConfigDocument normalized)
	{
		return parsed.SchemaVersion != normalized.SchemaVersion
			|| (parsed.SchemaVersion < 2 && UsesLegacyDefaultReplaceShortcut(parsed));
	}

	/// <summary>
	/// schemaVersion 1 の置換ショートカット既定値を使っているか判定する
	/// </summary>
	/// <param name="config">設定</param>
	/// <returns>旧既定値なら true</returns>
	private static bool UsesLegacyDefaultReplaceShortcut(AppConfigDocument config)
	{
		AppSettings? settings = config.Settings;
		KeybindingsSettings? keybindings = settings?.Keybindings;

		return keybindings?.Replace is not null
			&& ShortcutEquals(keybindings.Replace, LegacyDefaultReplaceShortcut);
	}

	/// <summary>
	/// ウィンドウ設定を正規化する
	/// </summary>
	/// <param name="window">ウィンドウ設定</param>
	/// <param name="defaults">既定値</param>
	/// <returns>正規化後</returns>
	private static WindowConfig NormalizeWindow(WindowConfig? window, WindowConfig defaults)
	{
		window ??= defaults;

		return new WindowConfig
		{
			Width     = Clamp(window.Width, 600, 4096, defaults.Width),
			Height    = Clamp(window.Height, 400, 4096, defaults.Height),
			Maximized = window.Maximized,
		};
	}

	/// <summary>
	/// settings を正規化する
	/// </summary>
	/// <param name="settings">settings</param>
	/// <returns>正規化後</returns>
	private static AppSettings NormalizeSettings(AppSettings settings)
	{
		AppSettings defaults = CreateDefaultConfig().Settings;

		string theme = settings.Theme is "system" or "dark" or "light" ? settings.Theme : defaults.Theme;
		string defaultViewMode = settings.DefaultViewMode is "live-preview" or "source"
			? settings.DefaultViewMode
			: defaults.DefaultViewMode;
		string newFileEol = settings.NewFileEol is "crlf" or "lf" ? settings.NewFileEol : defaults.NewFileEol;
		string externalChangeBehavior = settings.ExternalChangeBehavior is "auto-reload" or "confirm"
			? settings.ExternalChangeBehavior
			: defaults.ExternalChangeBehavior;
		string instanceMode = settings.InstanceMode is "single-instance" or "new-window"
			? settings.InstanceMode
			: defaults.InstanceMode;
		string externalBrowserMode = settings.ExternalBrowser?.Mode is "default" or "custom"
			? settings.ExternalBrowser.Mode
			: defaults.ExternalBrowser.Mode;
		string outlineSide = settings.Outline?.Side is "left" or "right"
			? settings.Outline!.Side
			: defaults.Outline.Side;
		string exportOutlineSide = settings.Export?.Outline?.Side is "left" or "right"
			? settings.Export.Outline!.Side
			: defaults.Export.Outline.Side;

		return new AppSettings
		{
			Theme                 = theme,
			EditorFontFamily      = string.IsNullOrWhiteSpace(settings.EditorFontFamily) ? defaults.EditorFontFamily : settings.EditorFontFamily,
			EditorFontSize        = Clamp(settings.EditorFontSize, 8, 72, defaults.EditorFontSize),
			ShowLineNumbers       = settings.ShowLineNumbers,
			ShowEolMarkers        = settings.ShowEolMarkers ?? true,
			WordWrap              = settings.WordWrap,
			DefaultViewMode       = defaultViewMode,
			TabSize               = Clamp(settings.TabSize, 1, 8, defaults.TabSize),
			LargeFileThresholdMb  = Clamp(settings.LargeFileThresholdMb, 1, 100, defaults.LargeFileThresholdMb),
			LoadRemoteImages      = settings.LoadRemoteImages,
			NewFileEncoding       = string.IsNullOrWhiteSpace(settings.NewFileEncoding) ? defaults.NewFileEncoding : settings.NewFileEncoding,
			NewFileEol            = newFileEol,
			ExternalChangeBehavior = externalChangeBehavior,
			InstanceMode          = instanceMode,
			RestoreSessionOnStartup = settings.RestoreSessionOnStartup,
			CloseAppWhenLastTabClosed = settings.CloseAppWhenLastTabClosed,
			Outline = new OutlineSettings
			{
				Side = outlineSide,
			},
			Export = new ExportSettings
			{
				Style = settings.Export?.Style is "live-preview" or "clean"
					? settings.Export.Style
					: defaults.Export.Style,
				Outline = new ExportOutlineSettings
				{
					Enabled = settings.Export?.Outline?.Enabled ?? defaults.Export.Outline.Enabled,
					Side    = exportOutlineSide,
				},
			},
			ExternalBrowser = new ExternalBrowserSettings
			{
				Mode          = externalBrowserMode,
				CustomCommand = settings.ExternalBrowser?.CustomCommand?.Trim() ?? string.Empty,
			},
			Update = new UpdateSettings
			{
				CheckOnStartup = settings.Update?.CheckOnStartup ?? defaults.Update.CheckOnStartup,
				SkippedVersion = settings.Update?.SkippedVersion ?? defaults.Update.SkippedVersion,
				LastCheckedAt  = settings.Update?.LastCheckedAt ?? defaults.Update.LastCheckedAt,
			},
			CssSnippets = new CssSnippetsSettings
			{
				Enabled = settings.CssSnippets?.Enabled?
					.Where(item => !string.IsNullOrWhiteSpace(item))
					.Distinct(StringComparer.OrdinalIgnoreCase)
					.ToList() ?? [],
			},
			Search = new SearchSettings
			{
				RestoreCalloutFoldStateOnMove = settings.Search?.RestoreCalloutFoldStateOnMove
					?? defaults.Search.RestoreCalloutFoldStateOnMove,
			},
			Keybindings = NormalizeKeybindings(settings.Keybindings, defaults.Keybindings),
			ContextMenu = NormalizeContextMenu(settings.ContextMenu, defaults.ContextMenu),
		};
	}

	/// <summary>
	/// コンテキストメニュー設定を正規化する
	/// </summary>
	/// <param name="source">元設定</param>
	/// <param name="defaults">既定値</param>
	/// <returns>正規化後</returns>
	private static ContextMenuSettings NormalizeContextMenu(ContextMenuSettings? source, ContextMenuSettings defaults)
	{
		source ??= defaults;

		return new ContextMenuSettings
		{
			EditorOrder  = NormalizeMenuOrder(source.EditorOrder, defaults.EditorOrder),
			EditorHidden = NormalizeHiddenMenuItems(source.EditorHidden, defaults.EditorOrder),
			TabOrder     = NormalizeMenuOrder(source.TabOrder, defaults.TabOrder),
			TabHidden    = NormalizeHiddenMenuItems(source.TabHidden, defaults.TabOrder),
		};
	}

	/// <summary>
	/// 項目順から未知IDと重複を除き、欠落した既定項目を末尾へ補う
	/// </summary>
	/// <param name="source">元の項目順</param>
	/// <param name="defaults">既定の項目順</param>
	/// <returns>正規化した項目順</returns>
	private static List<string> NormalizeMenuOrder(IEnumerable<string>? source, IReadOnlyList<string> defaults)
	{
		HashSet<string> allowed = new(defaults, StringComparer.Ordinal);
		HashSet<string> seen    = new(StringComparer.Ordinal);
		List<string> result     = [];

		foreach (string itemId in source ?? [])
		{
			if (allowed.Contains(itemId) && seen.Add(itemId))
			{
				result.Add(itemId);
			}
		}

		foreach (string itemId in defaults)
		{
			if (seen.Add(itemId))
			{
				result.Add(itemId);
			}
		}

		return result;
	}

	/// <summary>
	/// 非表示項目から未知IDと重複を除く
	/// </summary>
	/// <param name="source">元の非表示項目</param>
	/// <param name="allowedItems">利用可能な項目ID</param>
	/// <returns>正規化した非表示項目</returns>
	private static List<string> NormalizeHiddenMenuItems(IEnumerable<string>? source, IReadOnlyCollection<string> allowedItems)
	{
		HashSet<string> allowed = new(allowedItems, StringComparer.Ordinal);
		return (source ?? [])
			.Where(allowed.Contains)
			.Distinct(StringComparer.Ordinal)
			.ToList();
	}

	/// <summary>
	/// キーバインド設定を正規化する
	/// </summary>
	/// <param name="source">元設定</param>
	/// <param name="defaults">既定値</param>
	/// <returns>正規化後</returns>
	private static KeybindingsSettings NormalizeKeybindings(KeybindingsSettings? source, KeybindingsSettings defaults)
	{
		source ??= defaults;

		return new KeybindingsSettings
		{
			NewFile          = Coalesce(source.NewFile, defaults.NewFile),
			OpenFile         = Coalesce(source.OpenFile, defaults.OpenFile),
			Save             = Coalesce(source.Save, defaults.Save),
			SaveAs           = Coalesce(source.SaveAs, defaults.SaveAs),
			CloseTab         = Coalesce(source.CloseTab, defaults.CloseTab),
			NextTab          = Coalesce(source.NextTab, defaults.NextTab),
			PrevTab          = Coalesce(source.PrevTab, defaults.PrevTab),
			Find             = Coalesce(source.Find, defaults.Find),
			Replace          = Coalesce(source.Replace, defaults.Replace),
			FindNext         = Coalesce(source.FindNext, defaults.FindNext),
			FindPrev         = Coalesce(source.FindPrev, defaults.FindPrev),
			ToggleViewMode   = Coalesce(source.ToggleViewMode, defaults.ToggleViewMode),
			ToggleOutline    = Coalesce(source.ToggleOutline, defaults.ToggleOutline),
			SplitHorizontal  = Coalesce(source.SplitHorizontal, defaults.SplitHorizontal),
			SplitVertical    = Coalesce(source.SplitVertical, defaults.SplitVertical),
			Unsplit          = Coalesce(source.Unsplit, defaults.Unsplit),
			ToggleCheckbox   = Coalesce(source.ToggleCheckbox, defaults.ToggleCheckbox),
			ExportHtml       = Coalesce(source.ExportHtml, defaults.ExportHtml),
			ExportPdf        = Coalesce(source.ExportPdf, defaults.ExportPdf),
			Print            = Coalesce(source.Print, defaults.Print),
		};
	}

	/// <summary>
	/// JSON から settings をマージする
	/// </summary>
	/// <param name="current">現在値</param>
	/// <param name="partial">部分更新</param>
	/// <returns>マージ結果</returns>
	private static AppSettings MergeSettings(AppSettings current, JsonElement partial)
	{
		JsonSerializerOptions options = new()
		{
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		};

		JsonNode currentNode = JsonSerializer.SerializeToNode(current, options)
			?? throw new InvalidOperationException("Failed to serialize current settings.");
		JsonNode patchNode = JsonSerializer.SerializeToNode(partial, options)
			?? throw new InvalidOperationException("Failed to serialize patch settings.");

		MergeJsonNodes(currentNode, patchNode);

		AppSettings? merged = currentNode.Deserialize<AppSettings>(options);
		return NormalizeSettings(merged ?? current);
	}

	/// <summary>
	/// JSON ノードを再帰マージする
	/// </summary>
	/// <param name="target">マージ先</param>
	/// <param name="patch">更新値</param>
	private static void MergeJsonNodes(JsonNode target, JsonNode patch)
	{
		if (target is not JsonObject targetObject || patch is not JsonObject patchObject)
		{
			return;
		}

		foreach (KeyValuePair<string, JsonNode?> property in patchObject)
		{
			if (property.Value is JsonObject patchChild && targetObject[property.Key] is JsonObject targetChild)
			{
				MergeJsonNodes(targetChild, patchChild);
				continue;
			}

			targetObject[property.Key] = property.Value?.DeepClone();
		}
	}

	/// <summary>
	/// dot 記法で settings 値を取得する
	/// </summary>
	/// <param name="settings">settings</param>
	/// <param name="itemKey">キー</param>
	/// <returns>値</returns>
	private static object? GetSettingValue(AppSettings settings, string itemKey)
	{
		JsonElement element = JsonSerializer.SerializeToElement(settings, new JsonSerializerOptions
		{
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		});

		JsonElement? current = NavigateJson(element, itemKey);
		return current?.ValueKind switch
		{
			JsonValueKind.String  => current.Value.GetString(),
			JsonValueKind.Number  => current.Value.TryGetInt32(out int number) ? number : current.Value.GetDouble(),
			JsonValueKind.True    => true,
			JsonValueKind.False   => false,
			JsonValueKind.Array   => current.Value.EnumerateArray().Select(item => item.GetString() ?? string.Empty).ToList(),
			_                     => null,
		};
	}

	/// <summary>
	/// dot 記法で settings 値を設定する
	/// </summary>
	/// <param name="settings">settings</param>
	/// <param name="itemKey">キー</param>
	/// <param name="value">値</param>
	/// <returns>更新後 settings</returns>
	private static AppSettings SetSettingValue(AppSettings settings, string itemKey, object value)
	{
		JsonNode? root = JsonSerializer.SerializeToNode(settings, new JsonSerializerOptions
		{
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		}) ?? new JsonObject();

		string[] parts = itemKey.Split('.');
		JsonNode current = root;

		for (int index = 0; index < parts.Length - 1; index++)
		{
			if (current[parts[index]] is not JsonObject child)
			{
				child = new JsonObject();
				current[parts[index]] = child;
			}

			current = child;
		}

		current[parts[^1]] = JsonSerializer.SerializeToNode(value);
		AppSettings? next = root.Deserialize<AppSettings>(new JsonSerializerOptions
		{
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		});

		return next ?? settings;
	}

	/// <summary>
	/// JSON を dot 記法で辿る
	/// </summary>
	/// <param name="source">JSON</param>
	/// <param name="itemKey">キー</param>
	/// <returns>値</returns>
	private static JsonElement? NavigateJson(JsonElement source, string itemKey)
	{
		JsonElement current = source;

		foreach (string part in itemKey.Split('.'))
		{
			if (!current.TryGetProperty(part, out JsonElement next))
			{
				return null;
			}

			current = next;
		}

		return current;
	}

	/// <summary>
	/// 数値を範囲内に収める
	/// </summary>
	/// <param name="value">値</param>
	/// <param name="min">最小</param>
	/// <param name="max">最大</param>
	/// <param name="fallback">代替値</param>
	/// <returns>調整後</returns>
	private static int Clamp(int value, int min, int max, int fallback)
	{
		if (value < min || value > max)
		{
			return fallback;
		}

		return value;
	}

	/// <summary>
	/// 空文字列を既定値で置換する
	/// </summary>
	/// <param name="value">値</param>
	/// <param name="fallback">既定値</param>
	/// <returns>結果</returns>
	private static string Coalesce(string? value, string fallback)
	{
		return string.IsNullOrWhiteSpace(value) ? fallback : value;
	}

	/// <summary>
	/// ショートカット文字列を大文字小文字を無視して比較する
	/// </summary>
	/// <param name="left">左辺</param>
	/// <param name="right">右辺</param>
	/// <returns>同じショートカットなら true</returns>
	private static bool ShortcutEquals(string left, string right)
	{
		return string.Equals(left.Trim(), right, StringComparison.OrdinalIgnoreCase);
	}
}
