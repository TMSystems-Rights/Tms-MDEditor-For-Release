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
		if (!File.Exists(sessionPath)) return new SessionLoadResult { Success = true };

		try
		{
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(sessionPath));
			JsonElement session = document.RootElement;
			Validate(session);
			return new SessionLoadResult { Success = true, Session = session.Clone() };
		}
		catch (Exception ex)
		{
			_logger.Warn("session", "セッションを読み込めませんでした", new Dictionary<string, object?> { ["error"] = ex.Message });
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
			Validate(session);
			JsonFileHelper.WriteAtomic(GetSessionPath(), session);
			return new SessionSaveResult { Success = true };
		}
		catch (Exception ex)
		{
			_logger.Error("session", "セッションを保存できませんでした", new Dictionary<string, object?> { ["error"] = ex.Message });
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
			|| !session.TryGetProperty("schemaVersion", out JsonElement schemaVersion)
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
