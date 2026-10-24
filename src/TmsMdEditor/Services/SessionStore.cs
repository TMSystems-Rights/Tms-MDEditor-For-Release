// ==============================================
// 終了時セッションの保存
// ==============================================

// タブとペインの JSON は dataDir/session.json が所有する
// この型は現行スキーマの検証と読み書きだけを行い、タブの復元は Web 層が行う

using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// 前回終了時のタブとペインを session.json へ原子的に保存し、起動時に返す
/// ファイルが無ければ復元対象なしの成功、形式が違えば新しいタブで起動できる失敗を返す
/// </summary>
internal sealed class SessionStore
{
	/// <summary>
	/// 読み書きを受け付ける schemaVersion。これ以外は保存も復元もしない
	/// </summary>
	public const int CurrentSchemaVersion = 1;

	/// <summary>
	/// 読み書きの失敗を記録するログ。セッションファイルは所有しない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// session.json の置き場所を決める dataDir の読み元
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// ログと dataDir の読み元を受け取る。どちらもこのストアでは破棄しない
	/// </summary>
	/// <param name="logger">読み書きの失敗を記録するログ</param>
	/// <param name="configStore">session.json を置く dataDir を持つ設定</param>
	public SessionStore(Logger logger, ConfigStore configStore)
	{
		_logger      = logger;
		_configStore = configStore;
	}

	/// <summary>
	/// session.json を読む。無ければ復元対象なしの成功、壊れていれば失敗と空のセッションを返す
	/// </summary>
	/// <returns>成否と、Web 層へ渡せるセッション JSON。ファイルが無いときは Session は null</returns>
	public SessionLoadResult Load()
	{
		string sessionPath = GetSessionPath();
		// 保存履歴がない初回起動は、復元対象なしの正常状態として扱う
		if (!File.Exists(sessionPath)) return new SessionLoadResult { Success = true };

		try
		{
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(sessionPath));
			JsonElement session = document.RootElement;
			Validate(session);
			// JsonDocument破棄後もWeb層へ渡せるよう、所有権を持つ要素へ複製する
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

	/// <summary>
	/// 現行スキーマのセッションを session.json へ原子的に書く。形式が違えば既存ファイルを置き換えない
	/// </summary>
	/// <param name="session">保存する JSON オブジェクト。schemaVersion は現行と一致している必要がある</param>
	/// <returns>成否。失敗時は利用者向けメッセージを入れ、例外は出さない</returns>
	public SessionSaveResult Save(JsonElement session)
	{
		try
		{
			// 未対応スキーマで既存の復元データを置き換えないよう、書込み前にも検証する
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

	/// <summary>
	/// 現在の dataDir から session.json の絶対パスを返す。ファイルの有無は見ない
	/// </summary>
	/// <returns>session.json の絶対パス</returns>
	private string GetSessionPath()
	{
		string dataDir = _configStore.CachedDataDir ?? _configStore.GetDataDirInfo().DataDir;
		return AppPaths.GetSessionPath(dataDir);
	}

	/// <summary>
	/// オブジェクトであり、schemaVersion が現行と一致することを確認する
	/// </summary>
	/// <param name="session">検証する JSON。オブジェクト以外、または版が違えば失敗</param>
	/// <exception cref="InvalidDataException">オブジェクトでない、または schemaVersion が現行と違う</exception>
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

/// <summary>
/// session.json の読み込み結果。失敗しても起動は続け、Session は渡さない
/// </summary>
internal sealed class SessionLoadResult
{
	/// <summary>
	/// ファイルが無い、または現行スキーマで読めたとき true。壊れているとき false
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// Web 層へ渡すセッション JSON。ファイルが無い、または失敗のときは null
	/// </summary>
	public JsonElement? Session { get; init; }

	/// <summary>
	/// 失敗時の利用者向けメッセージ。成功時は null
	/// </summary>
	public string? Message { get; init; }
}

/// <summary>
/// session.json の保存結果。失敗時も例外にはしない
/// </summary>
internal sealed class SessionSaveResult
{
	/// <summary>
	/// 検証を通過してファイルへ書けたとき true
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// 失敗時の利用者向けメッセージ。成功時は null
	/// </summary>
	public string? Message { get; init; }
}
