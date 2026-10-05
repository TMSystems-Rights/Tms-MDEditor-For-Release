namespace TmsMdEditor.Services;

/// <summary>
/// 開いているファイルの外部変更を監視する。
/// </summary>
internal sealed class FileWatcherService : IDisposable
{
	private readonly Logger _logger;
	private readonly Dictionary<string, FileSystemWatcher> _watchers = new(StringComparer.OrdinalIgnoreCase);
	private readonly HashSet<string> _trackedFiles = new(StringComparer.OrdinalIgnoreCase);
	private readonly Dictionary<string, DateTimeOffset> _suppressedUntil = new(StringComparer.OrdinalIgnoreCase);
	private readonly Dictionary<string, System.Threading.Timer> _debounceTimers = new(StringComparer.OrdinalIgnoreCase);
	private readonly object _syncRoot = new();

	public FileWatcherService(Logger logger) => _logger = logger;

	public event Action<ExternalFileChange>? FileChanged;

	public void Track(string filePath)
	{
		string fullPath = Path.GetFullPath(filePath);
		string? directory = Path.GetDirectoryName(fullPath);
		if (string.IsNullOrWhiteSpace(directory)) return;

		lock (_syncRoot)
		{
			_trackedFiles.Add(fullPath);
			// 同じフォルダのファイルは1つのwatcherで監視し、ハンドル数の増加を抑える。
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

	public void SuppressNextChange(string filePath)
	{
		string fullPath = Path.GetFullPath(filePath);
		lock (_syncRoot)
		{
			// 自アプリの保存通知を外部変更として再読込しないよう、短時間だけ抑止する。
			_suppressedUntil[fullPath] = DateTimeOffset.UtcNow.AddSeconds(2);
			if (_debounceTimers.Remove(fullPath, out System.Threading.Timer? timer)) timer.Dispose();
		}
	}

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

	private void QueueChange(string filePath, ExternalFileChangeKind kind)
	{
		string fullPath = Path.GetFullPath(filePath);
		lock (_syncRoot)
		{
			if (!_trackedFiles.Contains(fullPath)) return;
			if (IsSuppressedUnlocked(fullPath)) return;
			// 保存時に連続発火するChanged/Size通知を、最後の1件へまとめる。
			if (_debounceTimers.Remove(fullPath, out System.Threading.Timer? previous)) previous.Dispose();
			// atomic replaceは一時的にDeleted/Renamedを出すため、存在確認の猶予を長めに取る。
			int delayMs = kind == ExternalFileChangeKind.Deleted ? 400 : 250;
			_debounceTimers[fullPath] = new System.Threading.Timer(_ => Publish(fullPath, kind), null, delayMs, Timeout.Infinite);
		}
	}

	private void Publish(string filePath, ExternalFileChangeKind kind)
	{
		lock (_syncRoot)
		{
			if (_debounceTimers.Remove(filePath, out System.Threading.Timer? timer)) timer.Dispose();
			if (IsSuppressedUnlocked(filePath)) return;
		}

		ExternalFileChangeKind publishKind = kind;
		// 待機中に同じパスが復活した場合は、削除ではなく内容変更として扱う。
		if ((kind is ExternalFileChangeKind.Deleted or ExternalFileChangeKind.Renamed)
			&& File.Exists(filePath))
		{
			publishKind = ExternalFileChangeKind.Changed;
		}

		FileChanged?.Invoke(new ExternalFileChange(filePath, publishKind));
	}

	private bool IsSuppressedUnlocked(string fullPath)
	{
		if (!_suppressedUntil.TryGetValue(fullPath, out DateTimeOffset until)) return false;
		if (until > DateTimeOffset.UtcNow) return true;
		// 期限切れエントリは判定時に掃除し、保存回数に比例して辞書が増えないようにする。
		_suppressedUntil.Remove(fullPath);
		return false;
	}
}

/// <summary>監視対象ファイルで発生した外部変更</summary>
internal sealed record ExternalFileChange(string FilePath, ExternalFileChangeKind Kind);

/// <summary>外部変更の種別</summary>
internal enum ExternalFileChangeKind
{
	Changed,
	Deleted,
	Renamed,
}
