// ==============================================
// dataDir の config.json を読み書きする
// ==============================================

// 設定文書のキャッシュと、ブートストラップが指す dataDir をこの型が持つ
// ホストは読み書きと項目リセットを頼み、ファイルの原子的置換は JsonFileHelper が行う

using System.Text.Json;
using System.Text.Json.Nodes;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// config.json を読み、欠落を既定で埋め、スキーマ差分を保存し直す
/// dataDir が無ければ既定へは移さず失敗を返し、壊れたファイルはバックアップから戻す
/// </summary>
internal sealed class ConfigStore
{
	// ==============================================
	// スキーマとキャッシュ
	// ==============================================

	/// <summary>
	/// このストアが書く schemaVersion。読み込み時の移行判断にも使う
	/// </summary>
	public const int CurrentSchemaVersion = 9;

	/// <summary>
	/// 設定バックアップのファイル名接頭辞。世代の削除もこの名前だけで行う
	/// </summary>
	private const string ConfigBackupPrefix = "config";

	/// <summary>
	/// schemaVersion 1 の置換ショートカット既定値。移行時だけ新しい既定へ寄せる
	/// </summary>
	private const string LegacyDefaultReplaceShortcut = "Ctrl+H";

	/// <summary>
	/// schemaVersion 2 までの分割解除ショートカット。Windows へ届かない予約と重なるため、移行時だけ置き換える
	/// </summary>
	private const string LegacyDefaultUnsplitShortcut = "Ctrl+Shift+0";

	/// <summary>
	/// schemaVersion 4 までの既定下線パターン。取り消し線記法と競合するため、残っているときだけ置き換える
	/// </summary>
	private const string LegacyDefaultUnderlinePattern = "~([^~\\n]+)~";

	/// <summary>
	/// 現行の既定下線パターン。新規と、旧既定のままのルールへ書く
	/// </summary>
	private const string DefaultUnderlinePattern = "_v(.+?)_v";

	/// <summary>
	/// 個別リセットを許す settings の dot 記法キー。dataDir はここへ入れず、移行で扱う
	/// 実行中は増やさない
	/// </summary>
	private static readonly HashSet<string> ResettableSettingKeys =
	[
		"theme",
		"editorFontFamily",
		"codeFontFamily",
		"editorFontSize",
		"showLineNumbers",
		"showEolMarkers",
		"wordWrap",
		"defaultViewMode",
		"tabSize",
		"largeFileThresholdMb",
		"loadRemoteImages",
		"attachmentFolder",
		"imageBorder.width",
		"imageBorder.color",
		"imageBorder.hoverWidth",
		"imageBorder.hoverColor",
		"newFileEncoding",
		"newFileEol",
		"externalChangeBehavior",
		"instanceMode",
		"restoreSessionOnStartup",
		"closeAppWhenLastTabClosed",
		"outline.visible",
		"outline.side",
		"outline.width",
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
		"keybindings.pastePlain",
		"contextMenu.editorOrder",
		"contextMenu.editorHidden",
		"contextMenu.tabOrder",
		"contextMenu.tabHidden",
	];

	/// <summary>
	/// 読み書きの失敗と dataDir の固定を記録するログ。設定ファイルは所有しない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// app-config.json の dataDir を読むストア。config.json 本体はここが書く
	/// </summary>
	private readonly BootstrapConfigStore _bootstrapConfigStore;

	/// <summary>
	/// 最後に読み書きした設定。未ロードは null。保存のたびに正規化後の値へ置き換える
	/// </summary>
	private AppConfigDocument? _cachedConfig;

	/// <summary>
	/// キャッシュが指す dataDir。未ロードは null。ブートストラップとずれたままにしない
	/// </summary>
	private string? _cachedDataDir;

	// ==============================================
	// 読み込みと保存
	// ==============================================

	/// <summary>
	/// ログとブートストラップを受け取る。最初の Load まで config.json は読まない
	/// </summary>
	/// <param name="logger">読み書きの失敗を記録するログ</param>
	/// <param name="bootstrapConfigStore">dataDir の読み書き先。このストアでは破棄しない</param>
	public ConfigStore(Logger logger, BootstrapConfigStore bootstrapConfigStore)
	{
		_logger               = logger;
		_bootstrapConfigStore = bootstrapConfigStore;
	}

	/// <summary>
	/// 最後に読み書きした設定。Load 前は null。呼び出し側はこれを変更してもファイルへは戻らない
	/// </summary>
	public AppConfigDocument? CachedConfig => _cachedConfig;

	/// <summary>
	/// キャッシュが指す dataDir。Load 前は null
	/// </summary>
	public string? CachedDataDir => _cachedDataDir;

	/// <summary>
	/// config.json を読む。無ければ既定を作り、壊れればバックアップ、それも無ければ既定で起動を続ける
	/// </summary>
	/// <returns>成否、正規化済み設定、利用者向けメッセージ。例外は出さない</returns>
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
					_logger.Warn(LogCategory.Config, "ポータブル版のため dataDir を exe 隣の data に固定しました", new Dictionary<string, object?>
					{
						[LogProperty.Ignored] = dataDir,
						[LogProperty.DataDir] = portableDataDir,
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
				_logger.Warn(LogCategory.Config, "config.json の解析に失敗しました。バックアップ復旧を試行します", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });

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
			_logger.Error(LogCategory.Config, "設定の読み込みに失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
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
	/// 正規化した設定を、現在の dataDir へバックアップ付きで書く。dataDir が無く既定でもなければ保存しない
	/// </summary>
	/// <param name="config">保存する設定。schema と欠落は正規化で埋める。引数自体は変更しない</param>
	/// <returns>成否と正規化後の設定。失敗時はメッセージを入れ、例外は出さない</returns>
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
			_logger.Error(LogCategory.Config, "設定の保存に失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });

			return new SaveConfigResult
			{
				Success = false,
				Message = $"設定の保存に失敗しました。{ex.Message}",
			};
		}
	}

	/// <summary>
	/// settings の一部だけを現在値へ重ねて保存する。オブジェクトは再帰し、配列とスカラーは置き換える
	/// </summary>
	/// <param name="partialSettings">camelCase の差分。無いキーは現在値のまま</param>
	/// <returns>正規化して保存した結果。キャッシュが無ければ先に Load する</returns>
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
	/// 1 項目を既定へ戻して保存する。dataDir だけはファイル移動になり、未知のキーは保存しない
	/// </summary>
	/// <param name="itemKey">settings 配下の dot 記法。dataDir はブートストラップ側の移行</param>
	/// <returns>保存または移行の成否。未知キーと既定値なしは失敗メッセージ</returns>
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
	/// 現在の dataDir、既定 dataDir、ポータブルかを返す。フォルダの有無は見ない
	/// </summary>
	/// <returns>ブートストラップを読み直した参照情報。キャッシュは更新しない</returns>
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
	/// dataDir を移し、設定とセッションとスニペットを足りない分だけコピーする。ポータブルは拒否する
	/// </summary>
	/// <param name="newDataDir">移動先。空白は失敗。相対パスはカレントから絶対パスにする</param>
	/// <returns>成否と移動後の dataDir。ブートストラップ更新後に失敗したら元の dataDir へ戻す</returns>
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

			_logger.Info(LogCategory.Config, "dataDir を移行しました", new Dictionary<string, object?>
			{
				[LogProperty.From] = oldDir,
				[LogProperty.To]   = normalized,
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
					_logger.Error(LogCategory.Config, "dataDir 移行のロールバックに失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = rollbackEx.Message });
				}
			}

			_logger.Error(LogCategory.Config, "dataDir の移行に失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Error]  = ex.Message,
				[LogProperty.NewDir] = normalized,
			});

			return new MigrateDataDirResult
			{
				Success = false,
				Message = ex.Message,
			};
		}
	}

	// ==============================================
	// 既定値とファイル操作
	// ==============================================

	/// <summary>
	/// 未保存の既定 config を作る。ウィンドウサイズ、下線の装飾、現行 schema だけを持ち、最近使ったファイルは空
	/// </summary>
	/// <returns>ファイルへまだ書いていない既定。呼び出しのたびに新しいインスタンス</returns>
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
	/// 保存先 dataDir を、キャッシュが無ければブートストラップから読む
	/// </summary>
	/// <returns>現在の dataDir。フォルダの有無は見ない</returns>
	private string GetCurrentDataDir()
	{
		return _cachedDataDir ?? _bootstrapConfigStore.Load().DataDir;
	}

	/// <summary>
	/// カスタム装飾だけを差し替えて保存する。ウィンドウ、settings、最近使ったファイルは維持する
	/// </summary>
	/// <param name="decorations">保存するルール。空なら空のまま残し、schema は現行にする</param>
	/// <returns>保存結果。キャッシュが無ければ先に Load する</returns>
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
	/// 指定した dataDir が既定値かどうかを判定する
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
	/// 必要フォルダを作り、必要ならバックアップしてから config.json を原子的に書く。キャッシュは更新しない
	/// </summary>
	/// <param name="dataDir">書く dataDir。無ければ作る</param>
	/// <param name="config">書く設定。正規化済みであることを呼び出し側が保証する</param>
	/// <param name="createBackup">既存ファイルを世代バックアップするとき true。新規作成時は false</param>
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
	/// dataDir と backups、snippets を作る。既にあってもそのまま成功する
	/// </summary>
	/// <param name="dataDir">作る dataDir</param>
	private static void EnsureDataDirectories(string dataDir)
	{
		Directory.CreateDirectory(dataDir);
		Directory.CreateDirectory(AppPaths.GetBackupDirectory(dataDir));
		Directory.CreateDirectory(AppPaths.GetSnippetsDirectory(dataDir));
	}

	/// <summary>
	/// 設定、セッション、表示位置、スニペット、バックアップを、宛先に無いものだけコピーする
	/// </summary>
	/// <param name="oldDir">コピー元 dataDir。無くても各ファイルのコピーはスキップする</param>
	/// <param name="newDir">コピー先 dataDir</param>
	private static void CopyMigrationArtifacts(string oldDir, string newDir)
	{
		CopyFileIfMissing(AppPaths.GetConfigPath(oldDir), AppPaths.GetConfigPath(newDir));
		CopyFileIfMissing(AppPaths.GetSessionPath(oldDir), AppPaths.GetSessionPath(newDir));
		CopyFileIfMissing(AppPaths.GetNoteViewPositionsPath(oldDir), AppPaths.GetNoteViewPositionsPath(newDir));
		CopyDirectoryIfMissing(AppPaths.GetSnippetsDirectory(oldDir), AppPaths.GetSnippetsDirectory(newDir));
		CopyDirectoryIfMissing(AppPaths.GetBackupDirectory(oldDir), AppPaths.GetBackupDirectory(newDir));
	}

	/// <summary>
	/// インストーラが予約した dataDir 移行を適用する
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

		_logger.Info(LogCategory.Config, "インストーラ予約のdataDir移行を適用しました", new Dictionary<string, object?>
		{
			[LogProperty.From] = sourceDir,
			[LogProperty.To]   = targetDir,
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
	/// バックアップ復旧に使ってよいかを、schema が正で settings があるかだけで見る
	/// </summary>
	/// <param name="config">復旧候補。中身の各項目は見ない</param>
	/// <returns>schemaVersion が 1 以上で settings があれば true</returns>
	private static bool IsValidConfig(AppConfigDocument config)
	{
		return config.SchemaVersion > 0 && config.Settings is not null;
	}

	// ==============================================
	// 正規化
	// ==============================================

	/// <summary>
	/// 欠落を既定で埋め、schema が古いときだけショートカット、下線、アウトライン初期表示を移行する
	/// 旧下線ルールの Pattern は、渡された同じインスタンスを書き換える
	/// </summary>
	/// <param name="config">読み込んだ設定。空の装飾は旧 schema のときだけ既定リストへ差し替える</param>
	/// <returns>現行 schema の新しい文書。ウィンドウと settings は新しいインスタンス</returns>
	private static AppConfigDocument NormalizeConfig(AppConfigDocument config)
	{
		AppConfigDocument defaults = CreateDefaultConfig();
		AppSettings settings       = NormalizeSettings(config.Settings ?? defaults.Settings);

		// schemaVersion 1 では置換ショートカットの既定値が Ctrl+H だった
		// schemaVersion 2 への移行時だけ Ctrl+R へ寄せ、移行後のユーザー再設定は尊重する
		if (config.SchemaVersion < 2 && ShortcutEquals(settings.Keybindings.Replace, LegacyDefaultReplaceShortcut))
		{
			settings.Keybindings.Replace = defaults.Settings.Keybindings.Replace;
		}

		// Ctrl+Shift+0 は Windows の入力言語切替予約により Win32 アプリへ届かない環境がある
		// schemaVersion 3 への移行時だけ新しい既定値へ寄せ、ユーザー設定は尊重する
		if (config.SchemaVersion < 3 && ShortcutEquals(settings.Keybindings.Unsplit, LegacyDefaultUnsplitShortcut))
		{
			settings.Keybindings.Unsplit = defaults.Settings.Keybindings.Unsplit;
		}

		// schemaVersion 3 以前は customDecorations: [] が未設定状態として残ることがあった
		// v4 への移行時だけ既定の下線を補完し、v4 でユーザーが全削除した空配列は保持する
		List<CustomDecorationRule> decorations = config.CustomDecorations ?? [];
		if (config.SchemaVersion < 4 && decorations.Count == 0)
		{
			decorations = defaults.CustomDecorations;
		}

		// v4 までの既定下線は Markdown の取り消し線記法 ~~...~~ と競合し得るため、
		// 既定値そのものが残っているルールだけを、Obsidian で未使用の _v..._v 記法へ移行する
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

		// v8 以前には起動時のアウトライン表示設定がなく、常に非表示だった
		// 既存ユーザーの表示状態は維持し、新規インストールだけ新しい既定値（表示）を使う
		if (config.SchemaVersion < 9)
		{
			settings.Outline.Visible = false;
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
	/// ウィンドウ幅と高さを許可範囲の外なら既定へ戻す。範囲内の最大化はそのまま残す
	/// </summary>
	/// <param name="window">読み込んだウィンドウ設定。null は既定を使う</param>
	/// <param name="defaults">幅 600 未満や 4096 超、高さ 400 未満のときの代替</param>
	/// <returns>範囲を確認した新しいウィンドウ設定</returns>
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

	// ----------------------------------------------
	// settings
	// ----------------------------------------------

	/// <summary>
	/// 列挙と数値を許可範囲へ戻し、空のフォントや文字コードは既定にする。未知の列挙値は既定へ落とす
	/// </summary>
	/// <param name="settings">読み込んだ settings。null プロパティは既定で埋める</param>
	/// <returns>新しい settings。引数は変更しない</returns>
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
			CodeFontFamily        = string.IsNullOrWhiteSpace(settings.CodeFontFamily) ? defaults.CodeFontFamily : settings.CodeFontFamily.Trim(),
			EditorFontSize        = Clamp(settings.EditorFontSize, 8, 72, defaults.EditorFontSize),
			ShowLineNumbers       = settings.ShowLineNumbers,
			ShowEolMarkers        = settings.ShowEolMarkers ?? true,
			WordWrap              = settings.WordWrap,
			DefaultViewMode       = defaultViewMode,
			TabSize               = Clamp(settings.TabSize, 1, 8, defaults.TabSize),
			LargeFileThresholdMb  = Clamp(settings.LargeFileThresholdMb, 1, 100, defaults.LargeFileThresholdMb),
			LoadRemoteImages      = settings.LoadRemoteImages,
			AttachmentFolder      = settings.AttachmentFolder?.Trim() ?? string.Empty,
			ImageBorder           = NormalizeImageBorder(settings.ImageBorder, defaults.ImageBorder),
			NewFileEncoding       = string.IsNullOrWhiteSpace(settings.NewFileEncoding) ? defaults.NewFileEncoding : settings.NewFileEncoding,
			NewFileEol            = newFileEol,
			ExternalChangeBehavior = externalChangeBehavior,
			InstanceMode          = instanceMode,
			RestoreSessionOnStartup = settings.RestoreSessionOnStartup,
			CloseAppWhenLastTabClosed = settings.CloseAppWhenLastTabClosed,
			Outline = new OutlineSettings
			{
				Visible = settings.Outline?.Visible ?? defaults.Outline.Visible,
				Side    = outlineSide,
				// ウィンドウ最大幅まで本文の最低幅を残して拡張できるよう、UI側の可動範囲を狭めない
				Width   = Clamp(settings.Outline?.Width ?? defaults.Outline.Width, 180, 4096, defaults.Outline.Width),
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
	/// 画像枠線の太さを範囲外なら既定へ戻し、色は 16 進でなければ代替にする
	/// </summary>
	/// <param name="source">読み込んだ枠線。null は既定</param>
	/// <param name="defaults">太さと通常色の代替。ホバー色の空は許す</param>
	/// <returns>新しい枠線設定</returns>
	private static ImageBorderSettings NormalizeImageBorder(ImageBorderSettings? source, ImageBorderSettings defaults)
	{
		source ??= defaults;

		return new ImageBorderSettings
		{
			Width      = Clamp(source.Width, 0, 8, defaults.Width),
			Color      = NormalizeCssHexColor(source.Color, defaults.Color, allowEmpty: false),
			HoverWidth = Clamp(source.HoverWidth, 0, 16, defaults.HoverWidth),
			HoverColor = NormalizeCssHexColor(source.HoverColor, string.Empty, allowEmpty: true),
		};
	}

	/// <summary>
	/// CSS の 16 進色を、空と不正で分けて返す。前後の空白は除く
	/// </summary>
	/// <param name="value">入力。null は空として扱う</param>
	/// <param name="fallback">空を許さないとき、または形式が違うときの代替</param>
	/// <param name="allowEmpty">空をそのまま空文字で残すとき true。ホバー色用</param>
	/// <returns>#RGB、#RRGGBB、#RRGGBBAA のどれか、空、または代替</returns>
	private static string NormalizeCssHexColor(string? value, string fallback, bool allowEmpty)
	{
		string trimmed = value?.Trim() ?? string.Empty;
		if (trimmed.Length == 0)
		{
			return allowEmpty ? string.Empty : fallback;
		}

		return IsCssHexColor(trimmed) ? trimmed : fallback;
	}

	/// <summary>
	/// `#RGB` / `#RRGGBB` / `#RRGGBBAA` か判定する
	/// </summary>
	/// <param name="value">値</param>
	/// <returns>該当すれば true</returns>
	private static bool IsCssHexColor(string value)
	{
		if (value.Length is not (4 or 7 or 9) || value[0] != '#')
		{
			return false;
		}

		for (int index = 1; index < value.Length; index++)
		{
			char character = value[index];
			if (character is not (>= '0' and <= '9' or >= 'A' and <= 'F' or >= 'a' and <= 'f'))
			{
				return false;
			}
		}

		return true;
	}

	// ----------------------------------------------
	// コンテキストメニュー
	// ----------------------------------------------

	/// <summary>
	/// エディタとタブの項目順と非表示一覧から、未知の ID と重複を除き、欠落した既定項目を補う
	/// </summary>
	/// <param name="source">読み込んだメニュー設定。null は既定</param>
	/// <param name="defaults">許す ID と、欠けたときに足す順</param>
	/// <returns>新しいメニュー設定</returns>
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
				InsertMissingMenuItem(result, itemId);
			}
		}

		return PlaceMenuItemAfter(
			PlaceMenuItemAfter(
				PlaceMenuItemAfter(result, "pastePlain", "paste", defaults),
				"mergeTableCells",
				"toggleCheckbox",
				defaults),
			"unmergeTableCells",
			"mergeTableCells",
			defaults);
	}

	/// <summary>
	/// 欠落した既定項目を挿入する。貼り付け系は「貼り付け」の次へ置く
	/// </summary>
	/// <param name="result">構築中の順序</param>
	/// <param name="itemId">追加する項目</param>
	private static void InsertMissingMenuItem(List<string> result, string itemId)
	{
		if (itemId == "pastePlain")
		{
			int pasteIndex = result.IndexOf("paste");
			if (pasteIndex >= 0)
			{
				result.Insert(pasteIndex + 1, itemId);
				return;
			}
		}

		if (itemId == "mergeTableCells")
		{
			int checkboxIndex = result.IndexOf("toggleCheckbox");
			if (checkboxIndex >= 0)
			{
				result.Insert(checkboxIndex + 1, itemId);
				return;
			}
		}

		if (itemId == "unmergeTableCells")
		{
			int mergeIndex = result.IndexOf("mergeTableCells");
			if (mergeIndex >= 0)
			{
				result.Insert(mergeIndex + 1, itemId);
				return;
			}
		}

		result.Add(itemId);
	}

	/// <summary>
	/// 保存順が既定と同一なら、指定項目を基準項目の次へ移す
	/// </summary>
	/// <param name="order">現在の順序</param>
	/// <param name="itemId">移動する項目</param>
	/// <param name="afterId">直前に置く項目</param>
	/// <param name="defaults">既定順</param>
	/// <returns>補正後の順序</returns>
	private static List<string> PlaceMenuItemAfter(
		List<string> order,
		string itemId,
		string afterId,
		IReadOnlyList<string> defaults)
	{
		int itemIndex  = order.IndexOf(itemId);
		int afterIndex = order.IndexOf(afterId);
		if (itemIndex < 0 || afterIndex < 0 || itemIndex == afterIndex + 1)
		{
			return order;
		}

		List<string> withoutItem    = order.Where(id => id != itemId).ToList();
		List<string> defaultWithout = defaults.Where(id => id != itemId).ToList();
		if (!withoutItem.SequenceEqual(defaultWithout, StringComparer.Ordinal))
		{
			return order;
		}

		withoutItem.Insert(withoutItem.IndexOf(afterId) + 1, itemId);
		return withoutItem;
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
	/// 空のショートカットだけを既定へ戻す。空でない利用者の割り当ては形式を検査しない
	/// </summary>
	/// <param name="source">読み込んだキーバインド。null は既定</param>
	/// <param name="defaults">空文字のときの代替</param>
	/// <returns>新しいキーバインド</returns>
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
			PastePlain       = Coalesce(source.PastePlain, defaults.PastePlain),
		};
	}

	// ----------------------------------------------
	// JSON の部分更新
	// ----------------------------------------------

	/// <summary>
	/// 差分 JSON を現在の settings へ重ね、その後に正規化する。オブジェクトは再帰し、それ以外は置き換える
	/// </summary>
	/// <param name="current">マージ先の現在値</param>
	/// <param name="partial">camelCase の差分</param>
	/// <returns>正規化後の settings</returns>
	/// <exception cref="InvalidOperationException">現在値または差分を JSON へ変換できない</exception>
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
	/// オブジェクト同士はキーごとに再帰し、配列とスカラーはパッチ側で置き換える
	/// </summary>
	/// <param name="target">マージ先。オブジェクトでなければ何もしない</param>
	/// <param name="patch">更新値。オブジェクトでなければ何もしない</param>
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
	/// settings を camelCase の JSON にして、dot 記法の位置の値を返す
	/// </summary>
	/// <param name="settings">読む settings</param>
	/// <param name="itemKey">theme や outline.width のようなキー。途中が無ければ null</param>
	/// <returns>文字列、数値、bool、文字列配列。オブジェクトや null は null</returns>
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
	/// dot 記法の位置へ値を書き、settings へ戻す。途中のオブジェクトが無ければ作る
	/// </summary>
	/// <param name="settings">更新前の settings。引数は変更しない</param>
	/// <param name="itemKey">書き込むキー。最後の区間がプロパティ名</param>
	/// <param name="value">書く値。JSON 化できる必要がある</param>
	/// <returns>更新後の settings。逆直列化に失敗したら引数をそのまま返す</returns>
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
	/// JSON オブジェクトを dot 記法でたどる。途中が無ければ失敗
	/// </summary>
	/// <param name="source">起点の JSON</param>
	/// <param name="itemKey">ピリオド区切りのプロパティ名</param>
	/// <returns>たどり着いた要素。無ければ null</returns>
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

	// ----------------------------------------------
	// 値の補正
	// ----------------------------------------------

	/// <summary>
	/// 範囲外の数値を代替へ戻す。端へ切り詰めはしない
	/// </summary>
	/// <param name="value">調べる値</param>
	/// <param name="min">含む下限</param>
	/// <param name="max">含む上限</param>
	/// <param name="fallback">範囲外のときに返す既定</param>
	/// <returns>範囲内なら value、範囲外なら fallback</returns>
	private static int Clamp(int value, int min, int max, int fallback)
	{
		if (value < min || value > max)
		{
			return fallback;
		}

		return value;
	}

	/// <summary>
	/// 空白だけの文字列を既定へ戻す。空白以外はそのまま返す
	/// </summary>
	/// <param name="value">設定値。null も既定にする</param>
	/// <param name="fallback">空のときの代替。トリムはしない</param>
	/// <returns>空でなければ value、空なら fallback</returns>
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
