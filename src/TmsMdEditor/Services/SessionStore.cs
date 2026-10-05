using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// 前回終了時のタブ・ペイン状態を dataDir/session.json に保存する。
/// </summary>
internal sealed class SessionStore
{
	public const int CurrentSchemaVersion = 1;

	private readonly Logger _logger;
	private readonly ConfigStore _configStore;

	public SessionStore(Logger logger, ConfigStore configStore)
	{
		_logger      = logger;
		_configStore = configStore;
	}

	public SessionLoadResult Load()
	{
		string sessionPath = GetSessionPath();
		// 保存履歴がない初回起動は、復元対象なしの正常状態として扱う。
		if (!File.Exists(sessionPath)) return new SessionLoadResult { Success = true };

		try
		{
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(sessionPath));
			JsonElement session = document.RootElement;
			Validate(session);
			// JsonDocument破棄後もWeb層へ渡せるよう、所有権を持つ要素へ複製する。
			return new SessionLoadResult { Success = true, Session = session.Clone() };
		}
		catch (Exception ex)
		{
			_logger.Warn(LogCategory.Session, "セッションを読み込めませんでした", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			return new SessionLoadResult
			{
				Success = false,
				Message = "前回のセッションを読み込めなかったため、新しいタブで起動します。",
			};
		}
	}

	public SessionSaveResult Save(JsonElement session)
	{
		try
		{
			// 未対応スキーマで既存の復元データを置き換えないよう、書込み前にも検証する。
			Validate(session);
			JsonFileHelper.WriteAtomic(GetSessionPath(), session);
			return new SessionSaveResult { Success = true };
		}
		catch (Exception ex)
		{
			_logger.Error(LogCategory.Session, "セッションを保存できませんでした", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			return new SessionSaveResult { Success = false, Message = "セッションを保存できませんでした。" };
		}
	}

	private string GetSessionPath()
	{
		string dataDir = _configStore.CachedDataDir ?? _configStore.GetDataDirInfo().DataDir;
		return AppPaths.GetSessionPath(dataDir);
	}

	private static void Validate(JsonElement session)
	{
		if (session.ValueKind != JsonValueKind.Object
			|| !session.TryGetProperty(StoredJsonProperty.SchemaVersion, out JsonElement schemaVersion)
			|| schemaVersion.ValueKind != JsonValueKind.Number
			|| schemaVersion.GetInt32() != CurrentSchemaVersion)
		{
			throw new InvalidDataException("未対応または不正なセッション形式です。");
		}
	}
}

internal sealed class SessionLoadResult
{
	public bool Success { get; init; }
	public JsonElement? Session { get; init; }
	public string? Message { get; init; }
}

internal sealed class SessionSaveResult
{
	public bool Success { get; init; }
	public string? Message { get; init; }
}
