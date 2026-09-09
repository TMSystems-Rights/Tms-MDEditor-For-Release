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
			watcher.Error += (_, e) => _logger.Warn("watcher", "外部変更監視でエラーが発生しました", new Dictionary<string, object?> { ["error"] = e.GetException()?.Message });
			_watchers.Add(directory, watcher);
		}
	}

	public void SuppressNextChange(string filePath)
	{
		string fullPath = Path.GetFullPath(filePath);
		lock (_syncRoot)
		{
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
			if (_debounceTimers.Remove(fullPath, out System.Threading.Timer? previous)) previous.Dispose();
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
