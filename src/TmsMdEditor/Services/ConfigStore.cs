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
			// app-config.json。ポータブルでは dataDir が既に exe 隣へ寄っていることがある
			BootstrapConfigDocument bootstrap = _bootstrapConfigStore.Load();
			// 設定を読む dataDir。ポータブルでずれていれば直後に固定する
			string dataDir                    = bootstrap.DataDir;
			// ポータブルは保存先を exe 隣の data 以外にしない
			if (AppPaths.IsPortable)
			{
				// 今回の exe 隣の data。ブートストラップの値と違えば上書きする
				string portableDataDir = AppPaths.DefaultDataDir;
				// 保存値と exe 隣が違うときだけ警告して固定する。同じなら入らない
				if (!Path.GetFullPath(dataDir).Equals(Path.GetFullPath(portableDataDir), StringComparison.OrdinalIgnoreCase))
				{
					_logger.Warn(LogCategory.Config, "ポータブル版のため dataDir を exe 隣の data に固定しました", new Dictionary<string, object?>
					{
						[LogProperty.Ignored] = dataDir,
						[LogProperty.DataDir] = portableDataDir,
					});
					dataDir = portableDataDir;
					// 保存先を exe 隣へ固定したブートストラップ。版は現行
					_bootstrapConfigStore.Save(new BootstrapConfigDocument
					{
						// ブートストラップの現行版
						SchemaVersion = BootstrapConfigStore.CurrentSchemaVersion,
						// exe 隣の data。別の保存値は捨てる
						DataDir       = portableDataDir,
					});
				}
			}
			else
			{
				TryApplyPendingMigration(bootstrap);
			}
			// フォルダが無く、かつ既定でもない dataDir は既定へ移さず失敗にする。どちらかが欠けても入らない
			if (!Directory.Exists(dataDir) && !IsDefaultDataDir(dataDir))
			{
				_cachedDataDir = dataDir;
				// ファイルは読まず、既定の中身と失敗メッセージを返す
				return new LoadConfigResult
				{
					// 指定先が無い
					Success = false,
					// 起動を続けるための未保存の既定。ファイルへは書いていない
					Config  = CreateDefaultConfig(),
					// 見つからなかった dataDir を含む理由
					Message = $"dataDir が見つかりません。設定を変更または復旧してください: {dataDir}",
				};
			}

			EnsureDataDirectories(dataDir);

			// config.json のパス。フォルダは直前に作ってある
			string configPath = AppPaths.GetConfigPath(dataDir);

			// 初回は既定を作って保存し、バックアップは取らない
			if (!File.Exists(configPath))
			{
				// 未保存の既定。このあと原子的に書く
				AppConfigDocument created = CreateDefaultConfig();
				SaveInternal(dataDir, created, createBackup: false);
				_cachedConfig  = created;
				_cachedDataDir  = dataDir;

				// 初回作成の成功。メッセージは付けない
				return new LoadConfigResult
				{
					// 既定を書けた
					Success = true,
					// 保存した既定
					Config  = created,
				};
			}

			try
			{
				// 読んだ生の設定。壊れていればバックアップへ進む
				AppConfigDocument parsed = JsonFileHelper.Read<AppConfigDocument>(configPath);
				// 欠落と古い schema を埋めた設定。引数は下線移行以外は変えない
				AppConfigDocument config = NormalizeConfig(parsed);
				// 版が上がった、または旧置換ショートカットが残っているときだけ保存し直す
				if (ShouldPersistNormalizedConfig(parsed, config))
				{
					SaveInternal(dataDir, config, createBackup: true);
				}

				_cachedConfig = config;
				_cachedDataDir = dataDir;

				// 正規化済みをキャッシュした成功
				return new LoadConfigResult
				{
					// 読めた、または正規化を書き戻せた
					Success = true,
					// 欠落を埋めた設定
					Config  = config,
				};
			}
			catch (Exception ex)
			{
				_logger.Warn(LogCategory.Config, "config.json の解析に失敗しました。バックアップ復旧を試行します", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });

				// 検証を通過した最新バックアップ。無ければ null で既定へ落とす
				AppConfigDocument? restored = JsonFileHelper.TryRestoreLatestBackup<AppConfigDocument>(
					AppPaths.GetBackupDirectory(dataDir),
					ConfigBackupPrefix,
					IsValidConfig);

				// 使えるバックアップがあるときだけそれを正規化して書き戻す
				if (restored is not null)
				{
					// 復旧値の欠落を埋めた設定
					AppConfigDocument normalized = NormalizeConfig(restored);
					SaveInternal(dataDir, normalized, createBackup: false);
					_cachedConfig = normalized;
					_cachedDataDir = dataDir;

					// バックアップから戻した成功。利用者へその旨を出す
					return new LoadConfigResult
					{
						// 復旧して書けた
						Success             = true,
						// 正規化後の復旧設定
						Config              = normalized,
						// 利用者向け
						Message             = "設定ファイルをバックアップから復旧しました。",
						// バックアップ由来であることを示す
						RecoveredFromBackup = true,
					};
				}

				// バックアップも無いときの未保存の既定
				AppConfigDocument fallback = CreateDefaultConfig();
				SaveInternal(dataDir, fallback, createBackup: false);
				_cachedConfig = fallback;
				_cachedDataDir = dataDir;

				// 既定で起動は続けるが、読み込み自体は失敗
				return new LoadConfigResult
				{
					// 元のファイルは読めなかった
					Success = false,
					// 書き戻した既定
					Config  = fallback,
					// 利用者向け
					Message = "設定ファイルの読み込みに失敗したため、既定値を使用します。",
				};
			}
		}
		catch (Exception ex)
		{
			_logger.Error(LogCategory.Config, "設定の読み込みに失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			// ブートストラップ読み込みなどの外側の失敗。dataDir キャッシュは更新しない
			AppConfigDocument fallback = CreateDefaultConfig();
			_cachedConfig = fallback;

			// 起動は続ける失敗
			return new LoadConfigResult
			{
				// 設定を確定できていない
				Success = false,
				// 未保存の既定。ファイルへは書いていない
				Config  = fallback,
				// 例外メッセージ
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
			// キャッシュが無ければブートストラップの dataDir
			string dataDir               = GetCurrentDataDir();
			// フォルダが無く、既定でもない先へは書かない。どちらかが欠けても入らない
			if (!Directory.Exists(dataDir) && !IsDefaultDataDir(dataDir))
			{
				// ファイルを書いていない失敗
				return new SaveConfigResult
				{
					// 保存していない
					Success = false,
					// 見つからなかった dataDir を含む理由
					Message = $"dataDir が見つかりません。設定を変更または復旧してください: {dataDir}",
				};
			}

			// 欠落を埋めた設定。引数自体は変えない
			AppConfigDocument normalized = NormalizeConfig(config);
			SaveInternal(dataDir, normalized, createBackup: true);
			_cachedConfig = normalized;
			_cachedDataDir = dataDir;

			// バックアップ付きで書けた成功
			return new SaveConfigResult
			{
				// 原子的な置換まで終わった
				Success = true,
				// 正規化後。キャッシュと同じ
				Config  = normalized,
			};
		}
		catch (Exception ex)
		{
			_logger.Error(LogCategory.Config, "設定の保存に失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });

			// 例外は結果に畳む
			return new SaveConfigResult
			{
				// 書けていない
				Success = false,
				// 例外メッセージを続けた理由
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
		// 現在の設定。キャッシュが null のときは先に Load する
		AppConfigDocument current = _cachedConfig ?? Load().Config;
		// 差分を重ねて正規化した settings。他の区画は変えない
		AppSettings merged        = MergeSettings(current.Settings, partialSettings);

		// settings だけ差し替えた保存用の文書
		return Save(new AppConfigDocument
		{
			// 版は現在値のまま。この差分では上げない
			SchemaVersion     = current.SchemaVersion,
			// ウィンドウ配置は差分の対象外
			Window            = current.Window,
			// 差分を正規化した settings
			Settings          = merged,
			// 装飾定義は維持
			CustomDecorations = current.CustomDecorations,
			// 最近使ったファイルは維持
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
		// dataDir だけは値の上書きではなく、既定フォルダへの移動になる
		if (itemKey.Equals("dataDir", StringComparison.OrdinalIgnoreCase))
		{
			// 既定 dataDir への移行結果。ポータブルは拒否される
			MigrateDataDirResult migrateResult = MigrateDataDir(BootstrapConfigStore.GetDefaultDataDir());

			// 移行の成否を設定保存の形で返す
			return new SaveConfigResult
			{
				// 移動できたときだけ true
				Success = migrateResult.Success,
				// 移行側のメッセージ。成功時は null のことがある
				Message = migrateResult.Message,
				// 移動後に読み直したキャッシュ。失敗時は移行前のままのことがある
				Config  = _cachedConfig,
			};
		}

		// 個別リセットを許すキー以外は保存しない
		if (!ResettableSettingKeys.Contains(itemKey))
		{
			// 未知キーの失敗
			return new SaveConfigResult
			{
				// 書いていない
				Success = false,
				// 拒否したキーを含む理由
				Message = $"不明な設定項目です: {itemKey}",
			};
		}

		// 現在の設定。キャッシュが null のときは Load する
		AppConfigDocument current  = _cachedConfig ?? Load().Config;
		// 既定値の取り出し元。ファイルへはまだ書かない
		AppConfigDocument defaults = CreateDefaultConfig();
		// そのキーの既定。オブジェクトや欠落は null でリセットしない
		object? defaultValue       = GetSettingValue(defaults.Settings, itemKey);

		// 既定が取れないキーは保存しない
		if (defaultValue is null)
		{
			// 既定なしの失敗
			return new SaveConfigResult
			{
				// 書いていない
				Success = false,
				// キーを含む理由
				Message = $"既定値が見つかりません: {itemKey}",
			};
		}

		// 1 項目だけ既定へ戻した settings。他の項目は現在値
		AppSettings nextSettings = SetSettingValue(current.Settings, itemKey, defaultValue);

		// 戻した settings だけ差し替えて保存する
		return Save(new AppConfigDocument
		{
			// 版は現在値のまま
			SchemaVersion     = current.SchemaVersion,
			// ウィンドウ配置はリセットしない
			Window            = current.Window,
			// 1 項目を既定へ戻してから範囲を確認した settings
			Settings          = NormalizeSettings(nextSettings),
			// 装飾定義は維持
			CustomDecorations = current.CustomDecorations,
			// 最近使ったファイルは維持
			RecentFiles       = current.RecentFiles,
		});
	}

	/// <summary>
	/// settings を既定値へリセットする（window / recentFiles / customDecorations は保持）
	/// </summary>
	/// <returns>保存の成否。失敗時はメッセージを入れ、例外は出さない</returns>
	public SaveConfigResult ResetAllSettings()
	{
		// ウィンドウと装飾と最近使ったファイルの引き継ぎ元
		AppConfigDocument current  = _cachedConfig ?? Load().Config;
		// settings の既定。他の区画は使わない
		AppConfigDocument defaults = CreateDefaultConfig();

		// settings だけ既定へ戻し、他は現在値を残す
		return Save(new AppConfigDocument
		{
			// リセット時は現行版へ上げる
			SchemaVersion     = CurrentSchemaVersion,
			// ウィンドウ配置は維持
			Window            = current.Window,
			// 既定の settings
			Settings          = defaults.Settings,
			// 装飾定義は維持
			CustomDecorations = current.CustomDecorations,
			// 最近使ったファイルは維持
			RecentFiles       = current.RecentFiles,
		});
	}

	/// <summary>
	/// 現在の dataDir、既定 dataDir、ポータブルかを返す。フォルダの有無は見ない
	/// </summary>
	/// <returns>ブートストラップを読み直した参照情報。キャッシュは更新しない</returns>
	public DataDirInfo GetDataDirInfo()
	{
		// 読み直したブートストラップ。キャッシュは更新しない
		BootstrapConfigDocument bootstrap = _bootstrapConfigStore.Load();

		// 画面が保存先を比べるための参照。フォルダの有無は見ない
		return new DataDirInfo
		{
			// 今の dataDir。ポータブルでは exe 隣
			DataDir        = bootstrap.DataDir,
			// 既定 dataDir。ポータブルでは DataDir と同じ平坦配置
			DefaultDataDir = BootstrapConfigStore.GetDefaultDataDir(),
			// ポータブル切替が有効なら true
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
		// ポータブルは保存先を exe 隣に固定するので移動を拒否する
		if (AppPaths.IsPortable)
		{
			// 移動していない失敗
			return new MigrateDataDirResult
			{
				// 保存先は変えていない
				Success = false,
				// 利用者向け
				Message = "ポータブル版ではデータ保存先を変更できません。",
			};
		}

		// 前後の空白を除いた絶対パス
		string normalized = Path.GetFullPath(newDataDir.Trim());

		// 空白だけの指定は移動先が無い
		if (string.IsNullOrWhiteSpace(normalized))
		{
			// 移動していない失敗
			return new MigrateDataDirResult
			{
				// 保存先は変えていない
				Success = false,
				// 利用者向け
				Message = "保存先フォルダが指定されていません。",
			};
		}

		// 現在のブートストラップ。失敗時の戻し先もここから取る
		BootstrapConfigDocument bootstrap = _bootstrapConfigStore.Load();
		// 比較用の現在 dataDir。絶対パス
		string oldDir                       = Path.GetFullPath(bootstrap.DataDir);

		// 同じフォルダへの指定はコピーせず成功にする
		if (normalized.Equals(oldDir, StringComparison.OrdinalIgnoreCase))
		{
			// 移動の必要が無い成功
			return new MigrateDataDirResult
			{
				// 既にその場所
				Success = true,
				// 指定された絶対パス
				DataDir = normalized,
			};
		}

		// ブートストラップ更新前の dataDir。ロールバックで戻す
		string previousDataDir = bootstrap.DataDir;
		// ブートストラップを新しい dataDir で保存したか。false なら戻しは不要
		bool configUpdated     = false;

		try
		{
			JsonFileHelper.VerifyWritableDirectory(normalized);
			EnsureDataDirectories(normalized);

			CopyMigrationArtifacts(oldDir, normalized);

			bootstrap.DataDir = normalized;
			_bootstrapConfigStore.Save(bootstrap);
			configUpdated = true;

			// 新しい dataDir で読み直した結果。メッセージは移行結果へ引き継ぐ
			LoadConfigResult reload = Load();

			_logger.Info(LogCategory.Config, "dataDir を移行しました", new Dictionary<string, object?>
			{
				[LogProperty.From] = oldDir,
				[LogProperty.To]   = normalized,
			});

			// コピーと読み直しの結果。読み直しが失敗でも dataDir は移っている
			return new MigrateDataDirResult
			{
				// 新しい場所の読み込み成否
				Success = reload.Success,
				// 移動先の絶対パス
				DataDir = normalized,
				// 読み直しのメッセージ。成功時は null のことがある
				Message = reload.Message,
			};
		}
		catch (Exception ex)
		{
			// ブートストラップを更新したあとだけ、元の dataDir へ戻す。更新前の失敗では入らない
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

			// コピーまたは読み直しの失敗。更新済みならブートストラップは戻してある
			return new MigrateDataDirResult
			{
				// 移動を確定していない
				Success = false,
				// 例外メッセージ。ロールバック失敗の詳細はログ
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
		// ファイルへまだ書いていない既定。呼び出しのたびに新しい
		return new AppConfigDocument
		{
			// 新規作成時の現行版
			SchemaVersion = CurrentSchemaVersion,
			// 初回ウィンドウ。最大化は型の既定のまま
			Window        = new WindowConfig
			{
				// 幅。単位は px
				Width  = 1000,
				// 高さ。単位は px
				Height = 700,
			},
			// テーマやショートカットは型の既定
			Settings = new AppSettings(),
			// 仕様書 6.8.5 の例（下線）。スタイルは livePreview.css の .tms-underline
			// 初期状態で有効な下線ルール。利用者が消すまでは 1 件
			CustomDecorations =
			[
				// 既定の下線。旧記法の ~~ とは競合しない
				new CustomDecorationRule
				{
					// 設定画面に出す名前
					Name            = "下線",
					// 初期状態で適用する
					Enabled         = true,
					// 区切りを含む一致パターン
					Pattern         = DefaultUnderlinePattern,
					// プレビューでは区切り文字を隠す
					HideDelimiters  = true,
					// プレビュー側の CSS クラス
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
		// 装飾以外を引き継ぐ現在の設定。キャッシュが null のときは Load する
		AppConfigDocument current = _cachedConfig ?? Load().Config;

		// 装飾だけ差し替え、schema は現行へ上げる
		return Save(new AppConfigDocument
		{
			// 装飾の保存時は現行版にする
			SchemaVersion     = CurrentSchemaVersion,
			// ウィンドウ配置は維持
			Window            = current.Window,
			// settings は維持
			Settings          = current.Settings,
			// 引数の列挙を新しいリストにする。空なら空のまま
			CustomDecorations = [.. decorations],
			// 最近使ったファイルは維持
			RecentFiles       = current.RecentFiles,
		});
	}

	/// <summary>
	/// 欠落した dataDir を既定のまま作ってよいかを、パスの一致で見る
	/// </summary>
	/// <param name="dataDir">ブートストラップに保存されている保存先。空白の有無は見ない</param>
	/// <returns>インストーラ既定、またはポータブルの exe 隣と大文字小文字を無視して同じなら true</returns>
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

		// config.json のパス。フォルダは直前に作ってある
		string configPath     = AppPaths.GetConfigPath(dataDir);
		// 世代バックアップの置き場所。取らないときもパスだけは求める
		string backupDirectory = AppPaths.GetBackupDirectory(dataDir);

		// 既存ファイルがある更新だけ世代を残す。初回作成では入らない
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
		// 予約が空ならインストーラ移行は無い
		if (string.IsNullOrWhiteSpace(bootstrap.PendingMigrationSourceDir))
		{
			return;
		}

		// コピー元。インストーラが予約した旧 dataDir の絶対パス
		string sourceDir = Path.GetFullPath(bootstrap.PendingMigrationSourceDir);
		// コピー先。今の dataDir の絶対パス
		string targetDir = Path.GetFullPath(bootstrap.DataDir);

		// 同じ場所、またはコピー元が無いときは予約だけ消す。どちらでも入る
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
		// 宛先が既にある、またはコピー元が無いときは上書きしない。どちらでも入る
		if (File.Exists(targetPath) || !File.Exists(sourcePath))
		{
			return;
		}

		// 宛先の親フォルダ。ルートなど親が無いときは null
		string? targetDir = Path.GetDirectoryName(targetPath);
		// 親が取れたときだけ作る。null や空では入らない
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
		// コピー元が無いときは空の宛先だけ作る
		if (!Directory.Exists(sourceDir))
		{
			Directory.CreateDirectory(targetDir);
			return;
		}

		// 宛先が既にあり、かつ中身があるときは上書きしない。どちらかが欠けても入らない
		if (Directory.Exists(targetDir) && Directory.EnumerateFileSystemEntries(targetDir).Any())
		{
			return;
		}

		Directory.CreateDirectory(targetDir);

		foreach (string file in Directory.EnumerateFiles(sourceDir))
		{
			// 宛先側の同じファイル名。サブフォルダは見ない
			string dest = Path.Combine(targetDir, Path.GetFileName(file));
			// 同名が無いファイルだけコピーする
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
		// 欠落を埋めるときの既定。ファイルへは書かない
		AppConfigDocument defaults = CreateDefaultConfig();
		// 列挙と範囲を直した settings。引数の settings が null なら既定から作る
		AppSettings settings       = NormalizeSettings(config.Settings ?? defaults.Settings);

		// schemaVersion 1 では置換ショートカットの既定値が Ctrl+H だった
		// schemaVersion 2 への移行時だけ Ctrl+R へ寄せ、移行後のユーザー再設定は尊重する
		// 版が 2 未満で、かつ旧既定のままのときだけ入る。どちらかが欠けても入らない
		if (config.SchemaVersion < 2 && ShortcutEquals(settings.Keybindings.Replace, LegacyDefaultReplaceShortcut))
		{
			settings.Keybindings.Replace = defaults.Settings.Keybindings.Replace;
		}

		// Ctrl+Shift+0 は Windows の入力言語切替予約により Win32 アプリへ届かない環境がある
		// schemaVersion 3 への移行時だけ新しい既定値へ寄せ、ユーザー設定は尊重する
		// 版が 3 未満で、かつ旧既定のままのときだけ入る。どちらかが欠けても入らない
		if (config.SchemaVersion < 3 && ShortcutEquals(settings.Keybindings.Unsplit, LegacyDefaultUnsplitShortcut))
		{
			settings.Keybindings.Unsplit = defaults.Settings.Keybindings.Unsplit;
		}

		// schemaVersion 3 以前は customDecorations: [] が未設定状態として残ることがあった
		// v4 への移行時だけ既定の下線を補完し、v4 でユーザーが全削除した空配列は保持する
		// 装飾一覧。null は空として、v4 未満のときだけ既定を補う
		List<CustomDecorationRule> decorations = config.CustomDecorations ?? [];
		// 版が 4 未満で、かつ一覧が空のときだけ既定の下線を足す。どちらかが欠けても入らない
		if (config.SchemaVersion < 4 && decorations.Count == 0)
		{
			decorations = defaults.CustomDecorations;
		}

		// v4 までの既定下線は Markdown の取り消し線記法 ~~...~~ と競合し得るため、
		// 既定値そのものが残っているルールだけを、Obsidian で未使用の _v..._v 記法へ移行する
		// 版が 5 未満の文書だけ、旧記法の下線を書き換える
		if (config.SchemaVersion < 5)
		{
			foreach (CustomDecorationRule decoration in decorations)
			{
				// 名前、旧パターン、区切り隠し、クラスがすべて既定の下線のときだけ Pattern を変える。一つでも違えば入らない
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
		// 版が 9 未満の既存利用者は、新しい既定の表示を強制しない
		if (config.SchemaVersion < 9)
		{
			settings.Outline.Visible = false;
		}

		// 現行版へ上げ、欠落を埋めた新しい文書。引数の下線 Pattern 以外は変えない
		return new AppConfigDocument
		{
			// 読み込み後の版。古い文書もここまで上げる
			SchemaVersion     = CurrentSchemaVersion,
			// 幅と高さを範囲外なら既定へ戻したウィンドウ
			Window            = NormalizeWindow(config.Window, defaults.Window),
			// 移行と範囲確認を終えた settings
			Settings          = settings,
			// 補完または記法移行のあとの装飾。空のまま残ることもある
			CustomDecorations = decorations,
			// 最近使ったファイル。null は空
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
	/// <param name="config">schemaVersion 1 の文書。settings やキーバインドが無ければ旧既定ではない</param>
	/// <returns>旧既定値なら true</returns>
	private static bool UsesLegacyDefaultReplaceShortcut(AppConfigDocument config)
	{
		// 置換ショートカットを探す settings。文書に無ければ null で旧既定ではない
		AppSettings? settings = config.Settings;
		// settings が null ならキーバインドも null
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

		// 範囲を確認した新しいウィンドウ。引数は変えない
		return new WindowConfig
		{
			// 幅。単位は px。600 未満と 4096 超は既定
			Width     = Clamp(window.Width, 600, 4096, defaults.Width),
			// 高さ。単位は px。400 未満と 4096 超は既定
			Height    = Clamp(window.Height, 400, 4096, defaults.Height),
			// 最大化。範囲の対象外なので読み込み値のまま
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
		// 未知の列挙を落とすときの既定。ファイルへは書かない
		AppSettings defaults = CreateDefaultConfig().Settings;

		// system、dark、light 以外は既定。空も既定
		string theme = settings.Theme is "system" or "dark" or "light" ? settings.Theme : defaults.Theme;
		// live-preview と source 以外は既定
		string defaultViewMode = settings.DefaultViewMode is "live-preview" or "source"
			? settings.DefaultViewMode
			: defaults.DefaultViewMode;
		// crlf と lf 以外は既定
		string newFileEol = settings.NewFileEol is "crlf" or "lf" ? settings.NewFileEol : defaults.NewFileEol;
		// auto-reload と confirm 以外は既定
		string externalChangeBehavior = settings.ExternalChangeBehavior is "auto-reload" or "confirm"
			? settings.ExternalChangeBehavior
			: defaults.ExternalChangeBehavior;
		// single-instance と new-window 以外は既定
		string instanceMode = settings.InstanceMode is "single-instance" or "new-window"
			? settings.InstanceMode
			: defaults.InstanceMode;
		// default と custom 以外、またはブラウザ設定が null なら既定
		string externalBrowserMode = settings.ExternalBrowser?.Mode is "default" or "custom"
			? settings.ExternalBrowser.Mode
			: defaults.ExternalBrowser.Mode;
		// left と right 以外、またはアウトラインが null なら既定
		string outlineSide = settings.Outline?.Side is "left" or "right"
			? settings.Outline!.Side
			: defaults.Outline.Side;
		// 書き出しアウトラインの左右。未設定や未知値は既定
		string exportOutlineSide = settings.Export?.Outline?.Side is "left" or "right"
			? settings.Export.Outline!.Side
			: defaults.Export.Outline.Side;

		// 未知値を既定へ落とした新しい settings。引数は変えない
		return new AppSettings
		{
			// 画面テーマ。未知値は既定
			Theme                 = theme,
			// 本文フォント。空白は既定。前後の空白は残す
			EditorFontFamily      = string.IsNullOrWhiteSpace(settings.EditorFontFamily) ? defaults.EditorFontFamily : settings.EditorFontFamily,
			// コード用フォント。空白は既定。それ以外は前後を除く
			CodeFontFamily        = string.IsNullOrWhiteSpace(settings.CodeFontFamily) ? defaults.CodeFontFamily : settings.CodeFontFamily.Trim(),
			// 本文の文字サイズ。単位は px。8 未満と 72 超は既定
			EditorFontSize        = Clamp(settings.EditorFontSize, 8, 72, defaults.EditorFontSize),
			// 行番号の表示。既定へは落とさない
			ShowLineNumbers       = settings.ShowLineNumbers,
			// 改行記号の表示。未設定は表示する
			ShowEolMarkers        = settings.ShowEolMarkers ?? true,
			// 折り返し。既定へは落とさない
			WordWrap              = settings.WordWrap,
			// 新規タブの表示モード。未知値は既定
			DefaultViewMode       = defaultViewMode,
			// タブ幅。単位は文字数。1 未満と 8 超は既定
			TabSize               = Clamp(settings.TabSize, 1, 8, defaults.TabSize),
			// 大きいファイルとみなすサイズ。単位は MB。1 未満と 100 超は既定
			LargeFileThresholdMb  = Clamp(settings.LargeFileThresholdMb, 1, 100, defaults.LargeFileThresholdMb),
			// 遠隔画像を読むか。既定へは落とさない
			LoadRemoteImages      = settings.LoadRemoteImages,
			// 添付フォルダ。未設定は空。空は添付先が未指定
			AttachmentFolder      = settings.AttachmentFolder?.Trim() ?? string.Empty,
			// 画像枠線。null は既定
			ImageBorder           = NormalizeImageBorder(settings.ImageBorder, defaults.ImageBorder),
			// 新規ファイルの文字コード。空白は既定
			NewFileEncoding       = string.IsNullOrWhiteSpace(settings.NewFileEncoding) ? defaults.NewFileEncoding : settings.NewFileEncoding,
			// 新規ファイルの改行。未知値は既定
			NewFileEol            = newFileEol,
			// 外部変更の扱い。未知値は既定
			ExternalChangeBehavior = externalChangeBehavior,
			// 起動時のインスタンス方針。未知値は既定
			InstanceMode          = instanceMode,
			// 前回のタブを起動時に戻すか
			RestoreSessionOnStartup = settings.RestoreSessionOnStartup,
			// 最後のタブを閉じたときアプリも閉じるか
			CloseAppWhenLastTabClosed = settings.CloseAppWhenLastTabClosed,
			// アウトライン。未設定の各項目は既定
			Outline = new OutlineSettings
			{
				// 表示するか。v9 未満の強制非表示は呼び出し側が後から上書きする
				Visible = settings.Outline?.Visible ?? defaults.Outline.Visible,
				// 左右。未知値は既定
				Side    = outlineSide,
				// ウィンドウ最大幅まで本文の最低幅を残して拡張できるよう、UI側の可動範囲を狭めない
				// 幅。単位は px。180 未満と 4096 超、または未設定は既定
				Width   = Clamp(settings.Outline?.Width ?? defaults.Outline.Width, 180, 4096, defaults.Outline.Width),
			},
			// 書き出し。未知の体裁は既定
			Export = new ExportSettings
			{
				// live-preview と clean 以外、または未設定は既定
				Style = settings.Export?.Style is "live-preview" or "clean"
					? settings.Export.Style
					: defaults.Export.Style,
				// 書き出し時のアウトライン。未設定は既定
				Outline = new ExportOutlineSettings
				{
					// 書き出しに目次を含めるか。未設定は既定
					Enabled = settings.Export?.Outline?.Enabled ?? defaults.Export.Outline.Enabled,
					// 左右。未知値は既定
					Side    = exportOutlineSide,
				},
			},
			// 外部ブラウザ。未設定は既定のモードと空のコマンド
			ExternalBrowser = new ExternalBrowserSettings
			{
				// default か custom。未知値は既定
				Mode          = externalBrowserMode,
				// カスタム起動コマンド。未設定は空で、空はコマンド未指定
				CustomCommand = settings.ExternalBrowser?.CustomCommand?.Trim() ?? string.Empty,
			},
			// 更新確認。未設定は既定
			Update = new UpdateSettings
			{
				// 起動時に確認するか。未設定は既定
				CheckOnStartup = settings.Update?.CheckOnStartup ?? defaults.Update.CheckOnStartup,
				// 利用者が見送った版。未設定は空で、空は見送りなし
				SkippedVersion = settings.Update?.SkippedVersion ?? defaults.Update.SkippedVersion,
				// 前回確認した時刻。未設定は空で、空は未確認
				LastCheckedAt  = settings.Update?.LastCheckedAt ?? defaults.Update.LastCheckedAt,
			},
			// 有効な CSS スニペット。未設定は空
			CssSnippets = new CssSnippetsSettings
			{
				// 空白を除き、大文字小文字を無視して重複を落としたファイル名。null は空
				Enabled = settings.CssSnippets?.Enabled?
					.Where(item => !string.IsNullOrWhiteSpace(item))
					.Distinct(StringComparer.OrdinalIgnoreCase)
					.ToList() ?? [],
			},
			// 検索。未設定の項目は既定
			Search = new SearchSettings
			{
				// 移動時に callout の折りたたみを戻すか。未設定は既定
				RestoreCalloutFoldStateOnMove = settings.Search?.RestoreCalloutFoldStateOnMove
					?? defaults.Search.RestoreCalloutFoldStateOnMove,
			},
			// 空の割り当てだけ既定へ戻したショートカット
			Keybindings = NormalizeKeybindings(settings.Keybindings, defaults.Keybindings),
			// 未知の項目を除いたコンテキストメニュー
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

		// 範囲と色を確認した新しい枠線。引数は変えない
		return new ImageBorderSettings
		{
			// 通常時の太さ。単位は px。0 は枠なし。9 以上は既定
			Width      = Clamp(source.Width, 0, 8, defaults.Width),
			// 通常色。空と不正な 16 進は既定色
			Color      = NormalizeCssHexColor(source.Color, defaults.Color, allowEmpty: false),
			// ホバー時の太さ。単位は px。0 は枠なし。17 以上は既定
			HoverWidth = Clamp(source.HoverWidth, 0, 16, defaults.HoverWidth),
			// ホバー色。空はホバー色なし。不正な 16 進も空にする
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
		// 前後の空白を除いた色。null は空で、空は色の指定が無い
		string trimmed = value?.Trim() ?? string.Empty;
		// 空は、許すときだけ空のまま残し、許さないときは代替へ落とす
		if (trimmed.Length == 0)
		{
			return allowEmpty ? string.Empty : fallback;
		}

		return IsCssHexColor(trimmed) ? trimmed : fallback;
	}

	/// <summary>
	/// `#RGB` / `#RRGGBB` / `#RRGGBBAA` か判定する
	/// </summary>
	/// <param name="value"># で始まる色。前後の空白は呼び出し側が除いている</param>
	/// <returns>該当すれば true</returns>
	private static bool IsCssHexColor(string value)
	{
		// 長さが 4、7、9 のどれでもない、または先頭が # でないときは 16 進色ではない。どちらでも入る
		if (value.Length is not (4 or 7 or 9) || value[0] != '#')
		{
			return false;
		}

		for (int index = 1; index < value.Length; index++)
		{
			// # の次からの 1 文字。数字と A から F 以外は色ではない
			char character = value[index];
			// 数字でも 16 進の英字でもない文字があれば失敗。大文字と小文字のどちらでもなければ入る
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

		// 未知の ID を除いた新しいメニュー設定。引数は変えない
		return new ContextMenuSettings
		{
			// エディタの項目順。欠落した既定項目は補う
			EditorOrder  = NormalizeMenuOrder(source.EditorOrder, defaults.EditorOrder),
			// エディタで隠す項目。未知の ID は捨てる
			EditorHidden = NormalizeHiddenMenuItems(source.EditorHidden, defaults.EditorOrder),
			// タブの項目順。欠落した既定項目は補う
			TabOrder     = NormalizeMenuOrder(source.TabOrder, defaults.TabOrder),
			// タブで隠す項目。未知の ID は捨てる
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
		// 残してよい ID。既定に無いものは捨てる
		HashSet<string> allowed = new(defaults, StringComparer.Ordinal);
		// 既に並べた ID。重複は入れない
		HashSet<string> seen    = new(StringComparer.Ordinal);
		// 未知と重複を除いた順。このあと欠落を補う
		List<string> result     = [];

		foreach (string itemId in source ?? [])
		{
			// 既定にあり、かつまだ並べていない ID だけ残す。どちらかが欠けても入らない
			if (allowed.Contains(itemId) && seen.Add(itemId))
			{
				result.Add(itemId);
			}
		}

		foreach (string itemId in defaults)
		{
			// 保存順に無かった既定項目だけ、専用の位置か末尾へ足す
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
		// プレーンテキスト貼り付けは、通常の貼り付けの直後に置く
		if (itemId == "pastePlain")
		{
			// 貼り付けの位置。無いときは -1 で末尾へ回す
			int pasteIndex = result.IndexOf("paste");
			// 貼り付けがあるときだけその次へ挿入する
			if (pasteIndex >= 0)
			{
				result.Insert(pasteIndex + 1, itemId);
				return;
			}
		}

		// セル結合は、チェックボックス切替の直後に置く
		if (itemId == "mergeTableCells")
		{
			// チェックボックス切替の位置。無いときは -1 で末尾へ回す
			int checkboxIndex = result.IndexOf("toggleCheckbox");
			// チェックボックスがあるときだけその次へ挿入する
			if (checkboxIndex >= 0)
			{
				result.Insert(checkboxIndex + 1, itemId);
				return;
			}
		}

		// セル結合の解除は、セル結合の直後に置く
		if (itemId == "unmergeTableCells")
		{
			// セル結合の位置。無いときは -1 で末尾へ回す
			int mergeIndex = result.IndexOf("mergeTableCells");
			// セル結合があるときだけその次へ挿入する
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
		// 移動する項目の位置。無いときは -1
		int itemIndex  = order.IndexOf(itemId);
		// 基準項目の位置。無いときは -1
		int afterIndex = order.IndexOf(afterId);
		// どちらかが無い、または既に基準の直後なら動かさない。どれか一つでも入る
		if (itemIndex < 0 || afterIndex < 0 || itemIndex == afterIndex + 1)
		{
			return order;
		}

		// 移動項目を除いた現在順。利用者の並び替えが残っているかの比較に使う
		List<string> withoutItem    = order.Where(id => id != itemId).ToList();
		// 移動項目を除いた既定順。これと違えば利用者の並びなので動かさない
		List<string> defaultWithout = defaults.Where(id => id != itemId).ToList();
		// 移動項目以外が既定順でないときは、保存された並びを優先してそのまま返す
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
		// 隠してよい ID。これ以外は非表示一覧から捨てる
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

		// 空の割り当てだけ既定へ戻したキーバインド。空でない値は形式を見ない
		return new KeybindingsSettings
		{
			// 新規ファイル。空は既定
			NewFile          = Coalesce(source.NewFile, defaults.NewFile),
			// ファイルを開く。空は既定
			OpenFile         = Coalesce(source.OpenFile, defaults.OpenFile),
			// 上書き保存。空は既定
			Save             = Coalesce(source.Save, defaults.Save),
			// 名前を付けて保存。空は既定
			SaveAs           = Coalesce(source.SaveAs, defaults.SaveAs),
			// タブを閉じる。空は既定
			CloseTab         = Coalesce(source.CloseTab, defaults.CloseTab),
			// 次のタブ。空は既定
			NextTab          = Coalesce(source.NextTab, defaults.NextTab),
			// 前のタブ。空は既定
			PrevTab          = Coalesce(source.PrevTab, defaults.PrevTab),
			// 検索。空は既定
			Find             = Coalesce(source.Find, defaults.Find),
			// 置換。空は既定。旧既定の移行は呼び出し側
			Replace          = Coalesce(source.Replace, defaults.Replace),
			// 次を検索。空は既定
			FindNext         = Coalesce(source.FindNext, defaults.FindNext),
			// 前を検索。空は既定
			FindPrev         = Coalesce(source.FindPrev, defaults.FindPrev),
			// 表示モード切替。空は既定
			ToggleViewMode   = Coalesce(source.ToggleViewMode, defaults.ToggleViewMode),
			// アウトライン切替。空は既定
			ToggleOutline    = Coalesce(source.ToggleOutline, defaults.ToggleOutline),
			// 左右分割。空は既定
			SplitHorizontal  = Coalesce(source.SplitHorizontal, defaults.SplitHorizontal),
			// 上下分割。空は既定
			SplitVertical    = Coalesce(source.SplitVertical, defaults.SplitVertical),
			// 分割解除。空は既定
			Unsplit          = Coalesce(source.Unsplit, defaults.Unsplit),
			// チェックボックス切替。空は既定
			ToggleCheckbox   = Coalesce(source.ToggleCheckbox, defaults.ToggleCheckbox),
			// HTML 書き出し。空は既定
			ExportHtml       = Coalesce(source.ExportHtml, defaults.ExportHtml),
			// PDF 書き出し。空は既定
			ExportPdf        = Coalesce(source.ExportPdf, defaults.ExportPdf),
			// 印刷。空は既定
			Print            = Coalesce(source.Print, defaults.Print),
			// プレーンテキスト貼り付け。空は既定
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
		// 差分と現在値を同じ camelCase で往復する設定
		JsonSerializerOptions options = new()
		{
			// Web 層のプロパティ名に合わせる
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		};

		// マージ先。直列化できないときは例外で保存しない
		JsonNode currentNode = JsonSerializer.SerializeToNode(current, options)
			?? throw new InvalidOperationException("Failed to serialize current settings.");
		// 差分。直列化できないときは例外で保存しない
		JsonNode patchNode = JsonSerializer.SerializeToNode(partial, options)
			?? throw new InvalidOperationException("Failed to serialize patch settings.");

		MergeJsonNodes(currentNode, patchNode);

		// 重ねたあとの settings。失敗時は null で現在値へ戻す
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
		// 両方オブジェクトのときだけキーごとに重ねる。どちらかが配列やスカラーなら何もしない
		if (target is not JsonObject targetObject || patch is not JsonObject patchObject)
		{
			return;
		}

		foreach (KeyValuePair<string, JsonNode?> property in patchObject)
		{
			// 差分も現在値もオブジェクトのときだけ再帰する。どちらかが欠けても入らない
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
		// camelCase にした settings。途中のキーが無ければ null を返す
		JsonElement element = JsonSerializer.SerializeToElement(settings, new JsonSerializerOptions
		{
			// dot 記法の区間は camelCase のプロパティ名
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		});

		// 指定位置の値。途中が無いときは null でオブジェクト扱いにしない
		JsonElement? current = NavigateJson(element, itemKey);
		// リセットに使える型だけ返す。オブジェクトと null は default で null
		return current?.ValueKind switch
		{
			// 文字列。JSON の null 文字列は null
			JsonValueKind.String  => current.Value.GetString(),
			// 整数に収まる数値は int。それ以外は double
			JsonValueKind.Number  => current.Value.TryGetInt32(out int number) ? number : current.Value.GetDouble(),
			// JSON の true
			JsonValueKind.True    => true,
			// JSON の false。bool の既定 false とは区別して返す
			JsonValueKind.False   => false,
			// 文字列の配列。要素が文字列でなければ空文字
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
		// 書き換える JSON。直列化できなければ空オブジェクトから作る
		JsonNode? root = JsonSerializer.SerializeToNode(settings, new JsonSerializerOptions
		{
			// キーの区間は camelCase
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		}) ?? new JsonObject();

		// dot 記法を区切ったプロパティ名。最後が書き込み先
		string[] parts = itemKey.Split('.');
		// 今たどっているノード。途中が無ければオブジェクトを足しながら進む
		JsonNode current = root;

		for (int index = 0; index < parts.Length - 1; index++)
		{
			// 途中がオブジェクトでないときは、新しいオブジェクトを置いてから降りる
			if (current[parts[index]] is not JsonObject child)
			{
				// 欠けていた途中のオブジェクト。空から始める
				child = new JsonObject();
				current[parts[index]] = child;
			}

			current = child;
		}

		current[parts[^1]] = JsonSerializer.SerializeToNode(value);
		// 書き戻した settings。失敗時は null で引数を返す
		AppSettings? next = root.Deserialize<AppSettings>(new JsonSerializerOptions
		{
			// 読み取りと同じ camelCase
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
		// 今たどっている要素。区間が無ければ null を返す
		JsonElement current = source;

		foreach (string part in itemKey.Split('.'))
		{
			// その区間のプロパティが無いときは、途中までしか無いキーとして失敗する
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
		// 下限未満、または上限超えは代替を返す。端の値自体は範囲内。どちらでも入る
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
