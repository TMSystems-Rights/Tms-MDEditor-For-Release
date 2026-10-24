// ==============================================
// ブートストラップ設定の読み書き
// ==============================================

// app-config.json の dataDir だけを所有する。config.json 本体は ConfigStore が読み、ここは起動位置を決める境界に留める

using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// AppData ルートの app-config.json を読み書きし、ポータブルでは dataDir を exe 隣の data に固定する
/// ファイルが無い、または壊れているときは既定を作って保存し、起動は続ける
/// </summary>
internal sealed class BootstrapConfigStore
{
	/// <summary>
	/// このストアが書く schemaVersion。古い版も読み込み時にこの値へ揃える
	/// </summary>
	public const int CurrentSchemaVersion = 1;

	/// <summary>
	/// 読み込み失敗と、ポータブルで無視した dataDir を記録するログ。設定ファイルは所有しない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// ログを受け取る。ライフタイムは呼び出し元が持つ
	/// </summary>
	/// <param name="logger">読み込み失敗と dataDir の固定を記録するログ</param>
	public BootstrapConfigStore(Logger logger)
	{
		_logger = logger;
	}

	/// <summary>
	/// app-config.json を読む。無ければ既定を作って保存し、壊れていても既定へ戻して保存する
	/// </summary>
	/// <returns>正規化済みの設定。ポータブルでは dataDir が exe 隣の data になる</returns>
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
				_logger.Warn(LogCategory.Bootstrap, "ポータブル版のため dataDir を exe 隣の data に固定しました", new Dictionary<string, object?>
				{
					[LogProperty.Ignored] = parsed.DataDir,
					[LogProperty.DataDir] = normalized.DataDir,
				});
				Save(normalized);
			}

			return normalized;
		}
		catch (Exception ex)
		{
			_logger.Error(LogCategory.Bootstrap, "app-config.json の読み込みに失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });

			var fallback = CreateDefault();
			Save(fallback);
			return fallback;
		}
	}

	/// <summary>
	/// 正規化した設定を app-config.json へ原子的に書く。呼び出し元には成否を返さない
	/// </summary>
	/// <param name="config">保存する設定。dataDir は正規化で絶対パスになる</param>
	public void Save(BootstrapConfigDocument config)
	{
		JsonFileHelper.WriteAtomic(AppPaths.BootstrapConfigPath, Normalize(config));
	}

	/// <summary>
	/// 今の実行形態における既定 dataDir を返す。フォルダは作らない
	/// </summary>
	/// <returns>ポータブルでは exe 隣の data、それ以外は AppData 配下の data</returns>
	public static string GetDefaultDataDir() => AppPaths.DefaultDataDir;

	/// <summary>
	/// schemaVersion と既定 dataDir だけを持つ設定を作る。ファイルにはまだ書かない
	/// </summary>
	/// <returns>未保存の既定設定。PendingMigrationSourceDir は空のまま</returns>
	private static BootstrapConfigDocument CreateDefault()
	{
		return new BootstrapConfigDocument
		{
			SchemaVersion = CurrentSchemaVersion,
			DataDir       = AppPaths.DefaultDataDir,
		};
	}

	/// <summary>
	/// dataDir を絶対パスへ揃え、ポータブルでは exe 隣の data で上書きする
	/// </summary>
	/// <param name="config">読み込んだ、または保存直前の設定。null プロパティは空として扱う</param>
	/// <returns>現行 schemaVersion の新しい設定。引数は変更しない</returns>
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
