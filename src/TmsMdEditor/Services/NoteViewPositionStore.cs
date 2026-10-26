// ==============================================
// ノートのカーソルとスクロールを保存する
// ==============================================

// カーソルとスクロールは dataDir/note-view-positions.json が所有する
// 複数ウィンドウは同じファイルへマージし、復元そのものは Web 層が行う

using System.Globalization;
using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// ノートごとのカーソル、スクロール、見出しの折りたたみを JSON へ保存する
/// 壊れた 1 件は飛ばし、ファイル全体が読めないときは空の現行スキーマを返す
/// </summary>
internal sealed class NoteViewPositionStore
{
	// ==============================================
	// スキーマと依存
	// ==============================================

	/// <summary>
	/// これから書く schemaVersion。見出しの折りたたみ位置を含む
	/// </summary>
	public const int CurrentSchemaVersion = 2;

	/// <summary>
	/// 折りたたみ位置を持たない旧版。読み取りだけ受け付け、保存時は現行へ上げる
	/// </summary>
	private const int LegacySchemaVersion = 1;

	/// <summary>
	/// ファイルへ残すノート数の上限。更新が新しい順に残し、超えた分は捨てる
	/// </summary>
	public const int MaxEntries = 200;

	/// <summary>
	/// 読み書きの失敗を記録するログ。壊れた 1 件では呼ばない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// JSON を置く dataDir の読み元。このストアは設定を書き戻さない
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// ログと dataDir の読み元を受け取る。ファイルは最初の読み書きまで触らない
	/// </summary>
	/// <param name="logger">読み書きの失敗を記録するログ</param>
	/// <param name="configStore">表示位置ファイルを置く dataDir を持つ設定</param>
	public NoteViewPositionStore(Logger logger, ConfigStore configStore)
	{
		_logger      = logger;
		_configStore = configStore;
	}

	// ==============================================
	// 読み込みと保存
	// ==============================================

	/// <summary>
	/// 表示位置を読む。ファイルが無ければ空の現行スキーマを成功として返す
	/// </summary>
	/// <returns>成否と、Web 層へ返す JSON。失敗時も空の現行スキーマを入れ、例外は出さない</returns>
	public NoteViewPositionLoadResult Load()
	{
		// 表示位置ファイルの絶対パス。有無は次で見る
		string path = GetPath();
		// 初回起動は異常ではないため、空の現行スキーマを通常結果として返す
		if (!File.Exists(path))
		{
			// 復元する位置がまだ無い成功
			return new NoteViewPositionLoadResult
			{
				// ファイルが無いことは失敗にしない
				Success = true,
				// エントリが空の現行スキーマ
				Document = EmptyDocument(),
			};
		}

		try
		{
			// 読み終えたら破棄する文書
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
			// 版が読めない、または 1 と 2 以外ならファイル全体を不正にする。どちらか一方でも入る
			if (!TryReadSchemaVersion(document.RootElement, out int schemaVersion) || !IsSupportedSchema(schemaVersion))
			{
				throw new InvalidDataException("未対応または不正な表示位置形式です。");
			}

			// 有効なエントリだけを現行スキーマで返す
			return new NoteViewPositionLoadResult
			{
				// 対応する版として読めた
				Success = true,
				// 壊れた 1 件を除いた JSON
				Document = SerializeDocument(ReadEntries(document.RootElement, schemaVersion)),
			};
		}
		catch (Exception ex)
		{
			_logger.Warn(LogCategory.NoteViewPosition, "表示位置を読み込めませんでした", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			// 読めなくても起動は続け、空の現行スキーマを返す
			return new NoteViewPositionLoadResult
			{
				// 復元できない
				Success = false,
				// 空の現行スキーマ。例外は出さない
				Document = EmptyDocument(),
			};
		}
	}

	/// <summary>
	/// 受け取った位置を既存ファイルへマージし、現行スキーマで原子的に書く
	/// </summary>
	/// <param name="incoming">マージする文書。schemaVersion が 1 または 2 でなければ既存ファイルは変えない</param>
	/// <returns>成否。失敗時は利用者向けメッセージを入れ、例外は出さない</returns>
	public NoteViewPositionSaveResult Save(JsonElement incoming)
	{
		try
		{
			// 壊れたクライアント入力を既存ファイルへ混ぜる前に、文書単位で形式を拒否する
			// 版が読めない、または 1 と 2 以外なら既存ファイルを変えない。どちらか一方でも入る
			if (!TryReadSchemaVersion(incoming, out int incomingSchemaVersion) || !IsSupportedSchema(incomingSchemaVersion))
			{
				throw new InvalidDataException("未対応または不正な表示位置形式です。");
			}

			// 複数ウィンドウが別々のノート位置を送るため、上書きではなく既存内容へマージする
			// 新しい方を残し、最大 200 件に切った一覧
			List<NoteViewPositionEntry> merged = Merge(ReadStoredEntries(), ReadEntries(incoming, incomingSchemaVersion));
			// マージ結果を現行スキーマで原子的に書く。空なら空配列
			JsonFileHelper.WriteAtomic(GetPath(), new NoteViewPositionDocument
			{
				// 保存時は折りたたみを含む現行版へ上げる
				SchemaVersion = CurrentSchemaVersion,
				// 更新が新しい順の最大 200 件。空なら空配列
				Entries       = merged,
			});
			return new NoteViewPositionSaveResult { Success = true };
		}
		catch (Exception ex)
		{
			_logger.Error(LogCategory.NoteViewPosition, "表示位置を保存できませんでした", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			// 検証失敗や書き込み失敗。既存ファイルは検証前なら残る
			return new NoteViewPositionSaveResult
			{
				// 書けていない
				Success = false,
				// 利用者向け。詳細はログ
				Message = "表示位置を保存できませんでした。",
			};
		}
	}

	// ==============================================
	// エントリの解釈
	// ==============================================

	/// <summary>
	/// 既存ファイルの有効なエントリだけを読む。ファイルが無い、または壊れているときは空として保存を続ける
	/// </summary>
	/// <returns>マージ元のエントリ。読めなければ空</returns>
	private List<NoteViewPositionEntry> ReadStoredEntries()
	{
		// 既存ファイルのパス。無ければ空として保存を続ける
		string path = GetPath();
		// ファイルが無い初回はマージ元が空
		if (!File.Exists(path)) return [];

		try
		{
			// 既存文書。壊れていれば catch で空にする
			using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
			// 版が読めない、または未対応なら既存を空として新しい位置だけ保存する。どちらか一方でも入る
			if (!TryReadSchemaVersion(document.RootElement, out int schemaVersion) || !IsSupportedSchema(schemaVersion)) return [];
			return ReadEntries(document.RootElement, schemaVersion);
		}
		catch (Exception ex)
		{
			// 既存ファイルだけが壊れていても、新しく受け取った正常な位置情報は保存できるよう空扱いにする
			_logger.Warn(LogCategory.NoteViewPosition, "既存の表示位置をマージできませんでした", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			return [];
		}
	}

	/// <summary>
	/// 現在の dataDir から表示位置ファイルの絶対パスを返す。有無は見ない
	/// </summary>
	/// <returns>note-view-positions.json のパス</returns>
	private string GetPath()
	{
		// キャッシュが null のときはブートストラップを読み直す
		string dataDir = _configStore.CachedDataDir ?? _configStore.GetDataDirInfo().DataDir;
		return AppPaths.GetNoteViewPositionsPath(dataDir);
	}

	/// <summary>
	/// パスを正規化したキーで既存と受信を重ね、更新が新しい方を残して上限まで切る
	/// </summary>
	/// <param name="current">既にファイルにあるエントリ</param>
	/// <param name="incoming">今回受け取ったエントリ。同じキーでより新しければ置き換える</param>
	/// <returns>更新が新しい順の最大 200 件</returns>
	private static List<NoteViewPositionEntry> Merge(IEnumerable<NoteViewPositionEntry> current, IEnumerable<NoteViewPositionEntry> incoming)
	{
		// Windowsパスの表記揺れを同一キーへ寄せ、ノートごとに最新の更新だけを残す
		// 正規化したパスをキーにした最新エントリ。同じノートは 1 件
		Dictionary<string, NoteViewPositionEntry> byKey = new(StringComparer.Ordinal);
		foreach (NoteViewPositionEntry entry in current)
		{
			byKey[NormalizeKey(entry.FilePath)] = entry;
		}

		foreach (NoteViewPositionEntry entry in incoming)
		{
			// 表記揺れを吸収した比較キー
			string key = NormalizeKey(entry.FilePath);
			// 既存が無い、または受信の方が同じか新しいときだけ置き換える。古いかつ既存があるときは入らない
			if (!byKey.TryGetValue(key, out NoteViewPositionEntry? existing) || CompareUpdatedAt(entry.UpdatedAt, existing.UpdatedAt) >= 0)
			{
				byKey[key] = entry;
			}
		}

		// ファイルを肥大化させず、よく使う直近のノートを優先して保持する
		return byKey.Values
			.OrderByDescending(entry => ParseUpdatedAt(entry.UpdatedAt))
			.ThenBy(entry => entry.FilePath, StringComparer.OrdinalIgnoreCase)
			.Take(MaxEntries)
			.ToList();
	}

	/// <summary>
	/// 配列の中から、必須項目が揃ったエントリだけを回収する。1 件の破損では残りを捨てない
	/// </summary>
	/// <param name="document">entries を持つ JSON オブジェクト</param>
	/// <param name="schemaVersion">1 なら折りたたみ位置を読まず、2 なら読む</param>
	/// <returns>有効なエントリ。配列が無ければ空</returns>
	private static List<NoteViewPositionEntry> ReadEntries(JsonElement document, int schemaVersion)
	{
		// entries が無い、または配列でない文書は空として扱う。どちらか一方でも入る
		if (!document.TryGetProperty(StoredJsonProperty.Entries, out JsonElement entries) || entries.ValueKind != JsonValueKind.Array)
		{
			return [];
		}

		// 必須項目が揃ったエントリ。壊れた 1 件は入れない
		List<NoteViewPositionEntry> result = [];
		foreach (JsonElement candidate in entries.EnumerateArray())
		{
			// 1件の破損で全履歴を失わないよう、有効なエントリだけを回収する
			// 必須が揃った 1 件だけ回収する。欠ければこの要素は捨てる
			if (TryReadEntry(candidate, schemaVersion, out NoteViewPositionEntry entry)) result.Add(entry);
		}

		return result;
	}

	/// <summary>
	/// 1 件のオブジェクトから表示位置を読む。必須の数値や文字列が欠ければ失敗
	/// </summary>
	/// <param name="element">1 件の JSON。オブジェクト以外は失敗</param>
	/// <param name="schemaVersion">現行以上のときだけ折りたたみ位置を読む</param>
	/// <param name="entry">成功時のエントリ。失敗時は空のエントリ</param>
	/// <returns>必須項目が揃い、負の位置や無限大が無ければ true</returns>
	private static bool TryReadEntry(JsonElement element, int schemaVersion, out NoteViewPositionEntry entry)
	{
		entry = new NoteViewPositionEntry();
		// オブジェクトであり、必須の文字列と 0 以上の位置が揃い、横スクロールが負でないときだけ成功。どれか一つが欠けても失敗
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

		// 折りたたんだ見出しの開始位置。旧版は読まず空。単位は文字
		List<int> collapsedHeadingFroms = schemaVersion >= CurrentSchemaVersion
			? ReadCollapsedHeadingFroms(element)
			: [];

		// 必須が揃った 1 件。失敗時の空エントリを置き換える
		entry = new NoteViewPositionEntry
		{
			// ノートのパス。比較キーは保存側で正規化する
			FilePath        = filePath,
			// どちらが新しいかを決める更新時刻
			UpdatedAt       = updatedAt,
			// カーソル位置。単位は文字。0 以上
			Anchor          = anchor,
			// 縦スクロールの余白。単位は px
			YMargin         = yMargin,
			// 横スクロール。単位は px。負は拒否済み
			ScrollLeft      = scrollLeft,
			// 選択範囲の始点。単位は文字
			SelectionAnchor = selectionAnchor,
			// 選択範囲の終点。単位は文字
			SelectionHead   = selectionHead,
			// 折りたたみ位置。旧版は空
			CollapsedHeadingFroms = collapsedHeadingFroms,
		};
		return true;
	}

	/// <summary>
	/// 文書の schemaVersion を整数として読む
	/// </summary>
	/// <param name="document">版を持つ JSON オブジェクト</param>
	/// <param name="version">読めた版。失敗時は 0</param>
	/// <returns>数値の schemaVersion があれば true</returns>
	private static bool TryReadSchemaVersion(JsonElement document, out int version)
	{
		version = 0;
		return document.ValueKind == JsonValueKind.Object
			&& document.TryGetProperty(StoredJsonProperty.SchemaVersion, out JsonElement schemaVersion)
			&& schemaVersion.ValueKind == JsonValueKind.Number
			&& schemaVersion.TryGetInt32(out version);
	}

	/// <summary>
	/// 読み取りを受け付ける版かを返す。現行と、折りたたみ無しの旧版だけ
	/// </summary>
	/// <param name="version">文書の schemaVersion</param>
	/// <returns>1 または 2 なら true</returns>
	private static bool IsSupportedSchema(int version) => version == LegacySchemaVersion || version == CurrentSchemaVersion;

	/// <summary>
	/// 折りたたんだ見出しの開始位置を、0 以上の重複無しで昇順に読む。配列が無ければ空
	/// </summary>
	/// <param name="element">collapsedHeadingFroms を持つエントリ</param>
	/// <returns>文字位置の一覧。単位は文字。負の値と非整数は捨てる</returns>
	private static List<int> ReadCollapsedHeadingFroms(JsonElement element)
	{
		// プロパティが無い、または配列でないときは折りたたみなし。どちらか一方でも入る
		if (!element.TryGetProperty("collapsedHeadingFroms", out JsonElement property) || property.ValueKind != JsonValueKind.Array)
		{
			return [];
		}

		return property.EnumerateArray()
			.Where(item => item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out int value) && value >= 0)
			.Select(item => item.GetInt32())
			.Distinct()
			.Order()
			.ToList();
	}

	/// <summary>
	/// 空白でない文字列プロパティを読む
	/// </summary>
	/// <param name="element">読むオブジェクト</param>
	/// <param name="name">プロパティ名</param>
	/// <param name="value">trim した文字列。失敗時は空文字</param>
	/// <returns>文字列であり、空白だけでなければ true</returns>
	private static bool TryReadString(JsonElement element, string name, out string value)
	{
		value = string.Empty;
		// プロパティが無い、または文字列でないときは失敗。どちらか一方でも入る
		if (!element.TryGetProperty(name, out JsonElement property) || property.ValueKind != JsonValueKind.String)
		{
			return false;
		}

		// JSON の文字列。null は空白と同じく失敗
		string? text = property.GetString();
		// 空白だけは必須の文字列として受けない
		if (string.IsNullOrWhiteSpace(text)) return false;
		value = text.Trim();
		return true;
	}

	/// <summary>
	/// 0 以上の整数プロパティを読む
	/// </summary>
	/// <param name="element">読むオブジェクト</param>
	/// <param name="name">プロパティ名</param>
	/// <param name="value">読めた整数。失敗時は 0</param>
	/// <returns>0 以上の整数なら true</returns>
	private static bool TryReadInt(JsonElement element, string name, out int value)
	{
		value = 0;
		// 数値の 0 以上の整数でないときは失敗。欠落、別の型、負のどれかでも入る
		if (!element.TryGetProperty(name, out JsonElement property) || property.ValueKind != JsonValueKind.Number || !property.TryGetInt32(out int parsed) || parsed < 0)
		{
			return false;
		}

		value = parsed;
		return true;
	}

	/// <summary>
	/// 有限の数値プロパティを読む。符号は見ない
	/// </summary>
	/// <param name="element">読むオブジェクト</param>
	/// <param name="name">プロパティ名</param>
	/// <param name="value">読めた数値。失敗時は 0</param>
	/// <returns>有限の数値なら true</returns>
	private static bool TryReadDouble(JsonElement element, string name, out double value)
	{
		value = 0;
		// 有限の数値でないときは失敗。欠落、別の型、無限大のどれかでも入る
		if (!element.TryGetProperty(name, out JsonElement property) || property.ValueKind != JsonValueKind.Number || !property.TryGetDouble(out double parsed) || !double.IsFinite(parsed))
		{
			return false;
		}

		value = parsed;
		return true;
	}

	// ==============================================
	// キーと時刻
	// ==============================================

	/// <summary>
	/// 同じ Windows ファイルを 1 件にまとめる比較キーを作る。不正なパスでも空にはしない
	/// </summary>
	/// <param name="filePath">ノートのパス。区切り文字と大文字小文字の差は吸収する</param>
	/// <returns>絶対パスを小文字にしたキー。正規化できないときは trim と区切りの置換だけ</returns>
	private static string NormalizeKey(string filePath)
	{
		// 大文字小文字と区切り文字の差を吸収し、同じWindowsファイルの重複登録を防ぐ
		// 前後の空白を除き、区切りをバックスラッシュへ揃えたパス。絶対化に失敗してもこれをキーにする
		string trimmed = filePath.Trim().Replace('/', '\\');
		try
		{
			return Path.GetFullPath(trimmed).ToLowerInvariant();
		}
		catch (Exception)
		{
			// 不正パスでも比較キーは作り、他の正常なエントリの保存を妨げない
			return trimmed.ToLowerInvariant();
		}
	}

	/// <summary>
	/// 更新時刻の前後を比較する。解釈できない値は最古として、正常な受信を上書きしない
	/// </summary>
	/// <param name="left">比較する更新時刻の文字列</param>
	/// <param name="right">比較相手の更新時刻の文字列</param>
	/// <returns>左が新しければ正、同じなら 0、古ければ負</returns>
	private static int CompareUpdatedAt(string left, string right)
	{
		return ParseUpdatedAt(left).CompareTo(ParseUpdatedAt(right));
	}

	/// <summary>
	/// 往復形式の更新時刻を読む。解釈できなければ最古の時刻にする
	/// </summary>
	/// <param name="value">ISO 8601 などの更新時刻</param>
	/// <returns>読めた時刻。失敗時は <see cref="DateTimeOffset.MinValue"/></returns>
	private static DateTimeOffset ParseUpdatedAt(string value)
	{
		// 不正な日時は最古として扱い、正常な受信データを誤って上書きしない
		return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset parsed)
			? parsed
			: DateTimeOffset.MinValue;
	}

	/// <summary>
	/// エントリが空の現行スキーマ文書を作る
	/// </summary>
	/// <returns>Web 層へ返せる空の JSON</returns>
	private static JsonElement EmptyDocument()
	{
		return SerializeDocument([]);
	}

	/// <summary>
	/// エントリを現行スキーマの JSON 要素にする。camelCase でプロパティ名を付ける
	/// </summary>
	/// <param name="entries">載せるエントリ。上限の切り捨ては呼び出し側が済ませている</param>
	/// <returns>schemaVersion と entries を持つ JSON</returns>
	private static JsonElement SerializeDocument(List<NoteViewPositionEntry> entries)
	{
		// 現行スキーマの JSON。プロパティ名は camelCase
		return JsonSerializer.SerializeToElement(new NoteViewPositionDocument
		{
			// Web 層へ返す版。保存と同じ現行
			SchemaVersion = CurrentSchemaVersion,
			// 載せるエントリ。上限の切り捨ては呼び出し側が済ませている
			Entries       = entries,
		}, BridgeJsonOptions());
	}

	/// <summary>
	/// Web 層へ返す JSON のプロパティ名を camelCase にする設定を、呼び出しのたびに作る
	/// </summary>
	/// <returns>camelCase の直列化設定</returns>
	private static JsonSerializerOptions BridgeJsonOptions()
	{
		// Web 層のプロパティ名を camelCase にする設定。呼び出しのたびに新しい
		return new JsonSerializerOptions
		{
			// ディスクとブリッジの名前は camelCase
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		};
	}
}

/// <summary>
/// 表示位置ファイルの文書。保存時の schemaVersion は現行に揃える
/// </summary>
internal sealed class NoteViewPositionDocument
{
	/// <summary>
	/// 文書の版。現行は 2。1 は折りたたみ位置を持たない
	/// </summary>
	public int SchemaVersion { get; set; }

	/// <summary>
	/// ノートごとの表示位置。保存時に最大 200 件へ切る
	/// </summary>
	public List<NoteViewPositionEntry> Entries { get; set; } = [];
}

/// <summary>
/// 1 ノートのカーソル、スクロール、選択、折りたたみ。キーはファイルパス
/// </summary>
internal sealed class NoteViewPositionEntry
{
	/// <summary>
	/// ノートのパス。比較前に絶対パスへ正規化する
	/// </summary>
	public string FilePath { get; set; } = string.Empty;

	/// <summary>
	/// 文書先頭からのカーソル位置。単位は文字。0 未満は読まない
	/// </summary>
	public int Anchor { get; set; }

	/// <summary>
	/// アンカーを画面上に置く余白。単位は px
	/// </summary>
	public double YMargin { get; set; }

	/// <summary>
	/// 横スクロール位置。単位は px。0 未満は読まない
	/// </summary>
	public double ScrollLeft { get; set; }

	/// <summary>
	/// 選択範囲の一方の端。単位は文字。0 未満は読まない
	/// </summary>
	public int SelectionAnchor { get; set; }

	/// <summary>
	/// 選択範囲のもう一方の端。単位は文字。0 未満は読まない
	/// </summary>
	public int SelectionHead { get; set; }

	/// <summary>
	/// 折りたたんだ見出しの開始位置。単位は文字。schema 2 だけが持ち、重複は保存前に除く
	/// </summary>
	public List<int> CollapsedHeadingFroms { get; set; } = [];

	/// <summary>
	/// この位置を書いた時刻の文字列。解釈できない値は最古としてマージする
	/// </summary>
	public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>
/// 表示位置の読み込み結果。失敗時も空の現行文書を渡し、起動は続ける
/// </summary>
internal sealed class NoteViewPositionLoadResult
{
	/// <summary>
	/// ファイルが無い、または現行か旧版として読めたとき true
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// Web 層へ返す JSON。失敗時は空の現行スキーマ
	/// </summary>
	public JsonElement Document { get; init; }
}

/// <summary>
/// 表示位置の保存結果。失敗しても例外にはしない
/// </summary>
internal sealed class NoteViewPositionSaveResult
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
