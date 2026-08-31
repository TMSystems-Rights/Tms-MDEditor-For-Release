using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// ブートストラップ設定（app-config.json）の読み書き
/// </summary>
internal sealed class BootstrapConfigStore
{
	public const int CurrentSchemaVersion = 1;

	private readonly Logger _logger;

	/// <summary>
	/// ブートストラップ設定ストアを初期化する
	/// </summary>
	/// <param name="logger">ロガー</param>
	public BootstrapConfigStore(Logger logger)
	{
		_logger = logger;
	}

	/// <summary>
	/// ブートストラップ設定を読み込む（存在しなければ作成）
	/// </summary>
	/// <returns>設定</returns>
	public BootstrapConfigDocument Load()
	{
		string path = AppPaths.BootstrapConfigPath;

		if (!File.Exists(path))
		{
			var created = CreateDefault();
			Save(created);
			return created;
		}

		try
		{
			BootstrapConfigDocument parsed = JsonFileHelper.Read<BootstrapConfigDocument>(path);
			BootstrapConfigDocument normalized = Normalize(parsed);
			if (AppPaths.IsPortable
				&& !string.IsNullOrWhiteSpace(parsed.DataDir)
				&& !Path.GetFullPath(parsed.DataDir.Trim()).Equals(normalized.DataDir, StringComparison.OrdinalIgnoreCase))
			{
				_logger.Warn("bootstrap", "ポータブル版のため dataDir を exe 隣の data に固定しました", new Dictionary<string, object?>
				{
					["ignored"] = parsed.DataDir,
					["dataDir"] = normalized.DataDir,
				});
				Save(normalized);
			}

			return normalized;
		}
		catch (Exception ex)
		{
			_logger.Error("bootstrap", "app-config.json の読み込みに失敗しました", new Dictionary<string, object?> { ["error"] = ex.Message });

			var fallback = CreateDefault();
			Save(fallback);
			return fallback;
		}
	}

	/// <summary>
	/// ブートストラップ設定を保存する
	/// </summary>
	/// <param name="config">設定</param>
	public void Save(BootstrapConfigDocument config)
	{
		JsonFileHelper.WriteAtomic(AppPaths.BootstrapConfigPath, Normalize(config));
	}

	/// <summary>
	/// 既定 dataDir を取得する
	/// </summary>
	/// <returns>既定 dataDir</returns>
	public static string GetDefaultDataDir() => AppPaths.DefaultDataDir;

	/// <summary>
	/// 既定設定を生成する
	/// </summary>
	/// <returns>既定設定</returns>
	private static BootstrapConfigDocument CreateDefault()
	{
		return new BootstrapConfigDocument
		{
			SchemaVersion = CurrentSchemaVersion,
			DataDir       = AppPaths.DefaultDataDir,
		};
	}

	/// <summary>
	/// 設定を正規化する
	/// </summary>
	/// <param name="config">設定</param>
	/// <returns>正規化後設定</returns>
	private static BootstrapConfigDocument Normalize(BootstrapConfigDocument config)
	{
		if (AppPaths.IsPortable)
		{
			return new BootstrapConfigDocument
			{
				SchemaVersion             = CurrentSchemaVersion,
				DataDir                   = AppPaths.DefaultDataDir,
				PendingMigrationSourceDir = string.Empty,
			};
		}

		string dataDir = string.IsNullOrWhiteSpace(config.DataDir)
			? AppPaths.DefaultDataDir
			: Path.GetFullPath(config.DataDir.Trim());

		return new BootstrapConfigDocument
		{
			SchemaVersion             = CurrentSchemaVersion,
			DataDir                   = dataDir,
			PendingMigrationSourceDir = string.IsNullOrWhiteSpace(config.PendingMigrationSourceDir)
				? string.Empty
				: Path.GetFullPath(config.PendingMigrationSourceDir.Trim()),
		};
	}
}
