using System.Globalization;
using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// ノートごとの表示位置を dataDir/note-view-positions.json に保存する。
/// </summary>
internal sealed class NoteViewPositionStore
{
	public const int CurrentSchemaVersion = 1;
	public const int MaxEntries = 200;

	private readonly Logger _logger;
	private readonly ConfigStore _configStore;

	public NoteViewPositionStore(Logger logger, ConfigStore configStore)
	{
		_logger      = logger;
		_configStore = configStore;
	}

	public NoteViewPositionLoadResult Load()
	{
		string path = GetPath();
		if (!File.Exists(path)) return new NoteViewPositionLoadResult { Success = true, Document = EmptyDocument() };

		try
		{
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
			if (!HasCurrentSchema(document.RootElement))
			{
				throw new InvalidDataException("未対応または不正な表示位置形式です。");
			}

			return new NoteViewPositionLoadResult { Success = true, Document = document.RootElement.Clone() };
		}
		catch (Exception ex)
		{
			_logger.Warn("noteViewPosition", "表示位置を読み込めませんでした", new Dictionary<string, object?> { ["error"] = ex.Message });
			return new NoteViewPositionLoadResult { Success = false, Document = EmptyDocument() };
		}
	}

	public NoteViewPositionSaveResult Save(JsonElement incoming)
	{
		try
		{
			if (!HasCurrentSchema(incoming))
			{
				throw new InvalidDataException("未対応または不正な表示位置形式です。");
			}

			List<NoteViewPositionEntry> merged = Merge(ReadStoredEntries(), ReadEntries(incoming));
			JsonFileHelper.WriteAtomic(GetPath(), new NoteViewPositionDocument
			{
				SchemaVersion = CurrentSchemaVersion,
				Entries       = merged,
			});
			return new NoteViewPositionSaveResult { Success = true };
		}
		catch (Exception ex)
		{
			_logger.Error("noteViewPosition", "表示位置を保存できませんでした", new Dictionary<string, object?> { ["error"] = ex.Message });
			return new NoteViewPositionSaveResult { Success = false, Message = "表示位置を保存できませんでした。" };
		}
	}

	private List<NoteViewPositionEntry> ReadStoredEntries()
	{
		string path = GetPath();
		if (!File.Exists(path)) return [];

		try
		{
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
			if (!HasCurrentSchema(document.RootElement)) return [];
			return ReadEntries(document.RootElement);
		}
		catch (Exception ex)
		{
			_logger.Warn("noteViewPosition", "既存の表示位置をマージできませんでした", new Dictionary<string, object?> { ["error"] = ex.Message });
			return [];
		}
	}

	private string GetPath()
	{
		string dataDir = _configStore.CachedDataDir ?? _configStore.GetDataDirInfo().DataDir;
		return AppPaths.GetNoteViewPositionsPath(dataDir);
	}

	private static List<NoteViewPositionEntry> Merge(IEnumerable<NoteViewPositionEntry> current, IEnumerable<NoteViewPositionEntry> incoming)
	{
		Dictionary<string, NoteViewPositionEntry> byKey = new(StringComparer.Ordinal);
		foreach (NoteViewPositionEntry entry in current)
		{
			byKey[NormalizeKey(entry.FilePath)] = entry;
		}

		foreach (NoteViewPositionEntry entry in incoming)
		{
			string key = NormalizeKey(entry.FilePath);
			if (!byKey.TryGetValue(key, out NoteViewPositionEntry? existing) || CompareUpdatedAt(entry.UpdatedAt, existing.UpdatedAt) >= 0)
			{
				byKey[key] = entry;
			}
		}

		return byKey.Values
			.OrderByDescending(entry => ParseUpdatedAt(entry.UpdatedAt))
			.ThenBy(entry => entry.FilePath, StringComparer.OrdinalIgnoreCase)
			.Take(MaxEntries)
			.ToList();
	}

	private static List<NoteViewPositionEntry> ReadEntries(JsonElement document)
	{
		if (!document.TryGetProperty("entries", out JsonElement entries) || entries.ValueKind != JsonValueKind.Array)
		{
			return [];
		}

		List<NoteViewPositionEntry> result = [];
		foreach (JsonElement candidate in entries.EnumerateArray())
		{
			if (TryReadEntry(candidate, out NoteViewPositionEntry entry)) result.Add(entry);
		}

		return result;
	}

	private static bool TryReadEntry(JsonElement element, out NoteViewPositionEntry entry)
	{
		entry = new NoteViewPositionEntry();
		if (element.ValueKind != JsonValueKind.Object
			|| !TryReadString(element, "filePath", out string filePath)
			|| !TryReadString(element, "updatedAt", out string updatedAt)
			|| !TryReadInt(element, "anchor", out int anchor)
			|| !TryReadDouble(element, "yMargin", out double yMargin)
			|| !TryReadDouble(element, "scrollLeft", out double scrollLeft)
			|| scrollLeft < 0
			|| !TryReadInt(element, "selectionAnchor", out int selectionAnchor)
			|| !TryReadInt(element, "selectionHead", out int selectionHead))
		{
			return false;
		}

		entry = new NoteViewPositionEntry
		{
			FilePath        = filePath,
			UpdatedAt       = updatedAt,
			Anchor          = anchor,
			YMargin         = yMargin,
			ScrollLeft      = scrollLeft,
			SelectionAnchor = selectionAnchor,
			SelectionHead   = selectionHead,
		};
		return true;
	}

	private static bool HasCurrentSchema(JsonElement document)
	{
		return document.ValueKind == JsonValueKind.Object
			&& document.TryGetProperty("schemaVersion", out JsonElement schemaVersion)
			&& schemaVersion.ValueKind == JsonValueKind.Number
			&& schemaVersion.TryGetInt32(out int version)
			&& version == CurrentSchemaVersion;
	}

	private static bool TryReadString(JsonElement element, string name, out string value)
	{
		value = string.Empty;
		if (!element.TryGetProperty(name, out JsonElement property) || property.ValueKind != JsonValueKind.String)
		{
			return false;
		}

		string? text = property.GetString();
		if (string.IsNullOrWhiteSpace(text)) return false;
		value = text.Trim();
		return true;
	}

	private static bool TryReadInt(JsonElement element, string name, out int value)
	{
		value = 0;
		if (!element.TryGetProperty(name, out JsonElement property) || property.ValueKind != JsonValueKind.Number || !property.TryGetInt32(out int parsed) || parsed < 0)
		{
			return false;
		}

		value = parsed;
		return true;
	}

	private static bool TryReadDouble(JsonElement element, string name, out double value)
	{
		value = 0;
		if (!element.TryGetProperty(name, out JsonElement property) || property.ValueKind != JsonValueKind.Number || !property.TryGetDouble(out double parsed) || !double.IsFinite(parsed))
		{
			return false;
		}

		value = parsed;
		return true;
	}

	private static string NormalizeKey(string filePath)
	{
		string trimmed = filePath.Trim().Replace('/', '\\');
		try
		{
			return Path.GetFullPath(trimmed).ToLowerInvariant();
		}
		catch (Exception)
		{
			return trimmed.ToLowerInvariant();
		}
	}

	private static int CompareUpdatedAt(string left, string right)
	{
		return ParseUpdatedAt(left).CompareTo(ParseUpdatedAt(right));
	}

	private static DateTimeOffset ParseUpdatedAt(string value)
	{
		return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset parsed)
			? parsed
			: DateTimeOffset.MinValue;
	}

	private static JsonElement EmptyDocument()
	{
		return JsonSerializer.SerializeToElement(new NoteViewPositionDocument
		{
			SchemaVersion = CurrentSchemaVersion,
			Entries       = [],
		}, BridgeJsonOptions());
	}

	private static JsonSerializerOptions BridgeJsonOptions()
	{
		return new JsonSerializerOptions
		{
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		};
	}
}

internal sealed class NoteViewPositionDocument
{
	public int SchemaVersion { get; set; }

	public List<NoteViewPositionEntry> Entries { get; set; } = [];
}

internal sealed class NoteViewPositionEntry
{
	public string FilePath { get; set; } = string.Empty;

	public int Anchor { get; set; }

	public double YMargin { get; set; }

	public double ScrollLeft { get; set; }

	public int SelectionAnchor { get; set; }

	public int SelectionHead { get; set; }

	public string UpdatedAt { get; set; } = string.Empty;
}

internal sealed class NoteViewPositionLoadResult
{
	public bool Success { get; init; }

	public JsonElement Document { get; init; }
}

internal sealed class NoteViewPositionSaveResult
{
	public bool Success { get; init; }

	public string? Message { get; init; }
}
