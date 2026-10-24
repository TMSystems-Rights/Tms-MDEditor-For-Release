// ==============================================
// 開いているファイルの外部変更の監視
// ==============================================

// ディレクトリの絶対パスごとに watcher を 1 つ所有する
// ホストは追跡と保存直後の抑止だけを頼み、変化は FileChanged で受け取る

namespace TmsMdEditor.Services;

/// <summary>
/// 追跡中ファイルの外部変化を短時間にまとめてから通知する
/// 自アプリの保存直後 2 秒は再読込にせず、破棄時に watcher とタイマーを解放する
/// </summary>
internal sealed class FileWatcherService : IDisposable
{
	// ==============================================
	// 監視テーブル
	// ==============================================

	/// <summary>
	/// 監視エラーを記録するログ。通知の採否には使わない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// ディレクトリの絶対パスをキーにした watcher
	/// 同じディレクトリのファイルを追加しても watcher は増やさず、追跡がゼロになっても破棄まで残す
	/// </summary>
	private readonly Dictionary<string, FileSystemWatcher> _watchers = new(StringComparer.OrdinalIgnoreCase);

	/// <summary>
	/// 通知を採用するファイルの絶対パス
	/// watcher のキーとは別に、ディレクトリ配下の無関係な変化を捨てる。追跡を外す操作は無い
	/// </summary>
	private readonly HashSet<string> _trackedFiles = new(StringComparer.OrdinalIgnoreCase);

	/// <summary>
	/// ファイルの絶対パスをキーにした、保存通知を無視する期限（UTC）
	/// 期限切れは次の判定で削除する。watcher や追跡集合より短い寿命で入れ替わる
	/// </summary>
	private readonly Dictionary<string, DateTimeOffset> _suppressedUntil = new(StringComparer.OrdinalIgnoreCase);

	/// <summary>
	/// ファイルの絶対パスをキーにしたデバウンスタイマー
	/// 同じパスの新しい通知で破棄し、公開後にも捨てる。抑止期限とは別の寿命
	/// </summary>
	private readonly Dictionary<string, System.Threading.Timer> _debounceTimers = new(StringComparer.OrdinalIgnoreCase);

	/// <summary>
	/// watcher、追跡、抑止、タイマーの更新を直列化するロック
	/// </summary>
	private readonly object _syncRoot = new();

	/// <summary>
	/// ログを受け取る。watcher は Track まで作らない
	/// </summary>
	/// <param name="logger">watcher のエラーを記録するログ</param>
	public FileWatcherService(Logger logger) => _logger = logger;

	/// <summary>
	/// デバウンス後の外部変化。購読側は UI スレッド以外から呼ばれ得る
	/// </summary>
	public event Action<ExternalFileChange>? FileChanged;

	// ==============================================
	// 追跡と抑止
	// ==============================================

	/// <summary>
	/// ファイルを通知対象に加え、親ディレクトリの watcher が無ければ 1 つ作る
	/// </summary>
	/// <param name="filePath">追跡するファイル。相対パスはカレントから絶対パスにする。ディレクトリを決められなければ何もしない</param>
	public void Track(string filePath)
	{
		string fullPath = Path.GetFullPath(filePath);
		string? directory = Path.GetDirectoryName(fullPath);
		if (string.IsNullOrWhiteSpace(directory)) return;

		lock (_syncRoot)
		{
			_trackedFiles.Add(fullPath);
			// 同じフォルダのファイルは1つのwatcherで監視し、ハンドル数の増加を抑える
			if (_watchers.ContainsKey(directory)) return;

			var watcher = new FileSystemWatcher(directory)
			{
				Filter = "*.*",
				NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
				EnableRaisingEvents = true,
			};
			watcher.Changed += (_, e) => QueueChange(e.FullPath, ExternalFileChangeKind.Changed);
			watcher.Created += (_, e) => QueueChange(e.FullPath, ExternalFileChangeKind.Changed);
			watcher.Deleted += (_, e) => QueueChange(e.FullPath, ExternalFileChangeKind.Deleted);
			watcher.Renamed += (_, e) => QueueChange(e.OldFullPath, ExternalFileChangeKind.Renamed);
			watcher.Error += (_, e) => _logger.Warn(LogCategory.Watcher, "外部変更監視でエラーが発生しました", new Dictionary<string, object?> { [LogProperty.Error] = e.GetException()?.Message });
			_watchers.Add(directory, watcher);
		}
	}

	/// <summary>
	/// 保存直後の変化通知を 2 秒間、外部変化として再読込しないよう抑止する。溜まっていたデバウンスも破棄する
	/// </summary>
	/// <param name="filePath">抑止するファイル。相対パスはカレントから絶対パスにする</param>
	public void SuppressNextChange(string filePath)
	{
		string fullPath = Path.GetFullPath(filePath);
		lock (_syncRoot)
		{
			// 自アプリの保存通知を外部変更として再読込しないよう、短時間だけ抑止する
			_suppressedUntil[fullPath] = DateTimeOffset.UtcNow.AddSeconds(2);
			if (_debounceTimers.Remove(fullPath, out System.Threading.Timer? timer)) timer.Dispose();
		}
	}

	/// <summary>
	/// watcher と未発火のタイマーを破棄する。追跡集合はそのまま残る
	/// </summary>
	public void Dispose()
	{
		lock (_syncRoot)
		{
			foreach (FileSystemWatcher watcher in _watchers.Values) watcher.Dispose();
			foreach (System.Threading.Timer timer in _debounceTimers.Values) timer.Dispose();
			_watchers.Clear();
			_debounceTimers.Clear();
		}
	}

	// ==============================================
	// 通知の集約
	// ==============================================

	/// <summary>
	/// 追跡中で抑止されていない変化を、パスごとに 1 本のタイマーへまとめる
	/// </summary>
	/// <param name="filePath">変化したパス。相対パスは絶対パスにする</param>
	/// <param name="kind">OS が報告した種別。削除と名前変更は公開前に待ち時間を長くする</param>
	private void QueueChange(string filePath, ExternalFileChangeKind kind)
	{
		string fullPath = Path.GetFullPath(filePath);
		lock (_syncRoot)
		{
			if (!_trackedFiles.Contains(fullPath)) return;
			if (IsSuppressedUnlocked(fullPath)) return;
			// 保存時に連続発火するChanged/Size通知を、最後の1件へまとめる
			if (_debounceTimers.Remove(fullPath, out System.Threading.Timer? previous)) previous.Dispose();
			// atomic replaceは一時的にDeleted/Renamedを出すため、存在確認の猶予を長めに取る
			int delayMs = kind == ExternalFileChangeKind.Deleted ? 400 : 250;
			_debounceTimers[fullPath] = new System.Threading.Timer(_ => Publish(fullPath, kind), null, delayMs, Timeout.Infinite);
		}
	}

	/// <summary>
	/// 待ち時間が終わった変化を購読側へ渡す。待ちの間にファイルが戻っていれば内容変更として渡す
	/// </summary>
	/// <param name="filePath">公開するファイルの絶対パス</param>
	/// <param name="kind">キューに入れたときの種別。存在が戻っていれば Changed へ読み替える</param>
	private void Publish(string filePath, ExternalFileChangeKind kind)
	{
		lock (_syncRoot)
		{
			if (_debounceTimers.Remove(filePath, out System.Threading.Timer? timer)) timer.Dispose();
			if (IsSuppressedUnlocked(filePath)) return;
		}

		ExternalFileChangeKind publishKind = kind;
		// 待機中に同じパスが復活した場合は、削除ではなく内容変更として扱う
		if ((kind is ExternalFileChangeKind.Deleted or ExternalFileChangeKind.Renamed)
			&& File.Exists(filePath))
		{
			publishKind = ExternalFileChangeKind.Changed;
		}

		FileChanged?.Invoke(new ExternalFileChange(filePath, publishKind));
	}

	/// <summary>
	/// ロックを持ったまま、保存通知の抑止がまだ有効かを返す。期限切れの項目はここで削除する
	/// </summary>
	/// <param name="fullPath">調べるファイルの絶対パス</param>
	/// <returns>現在時刻より期限が先なら true。項目が無い、または期限切れなら false</returns>
	private bool IsSuppressedUnlocked(string fullPath)
	{
		if (!_suppressedUntil.TryGetValue(fullPath, out DateTimeOffset until)) return false;
		if (until > DateTimeOffset.UtcNow) return true;
		// 期限切れエントリは判定時に掃除し、保存回数に比例して辞書が増えないようにする
		_suppressedUntil.Remove(fullPath);
		return false;
	}
}

/// <summary>
/// デバウンス後に購読側へ渡す、追跡中ファイルの外部変化
/// </summary>
/// <param name="FilePath">通知を採用したファイルの絶対パス</param>
/// <param name="Kind">公開時の種別。待機中にファイルが戻っていれば Changed</param>
internal sealed record ExternalFileChange(string FilePath, ExternalFileChangeKind Kind);

/// <summary>
/// OS から見た外部変化の種別。公開時にファイルが残っていれば Changed へ読み替える
/// </summary>
internal enum ExternalFileChangeKind
{
	/// <summary>
	/// 内容またはサイズが変わった。作成もこの種別にまとめる
	/// </summary>
	Changed,

	/// <summary>
	/// ファイルが消えた。公開前に存在が戻っていれば Changed になる
	/// </summary>
	Deleted,

	/// <summary>
	/// 変更前のパスが名前変更で離れた。公開前に同じパスが残っていれば Changed になる
	/// </summary>
	Renamed,
}
