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
		lock (_syncRoot) _suppressedUntil[Path.GetFullPath(filePath)] = DateTimeOffset.UtcNow.AddSeconds(2);
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
			if (_suppressedUntil.Remove(fullPath, out DateTimeOffset until) && until > DateTimeOffset.UtcNow) return;
			if (_debounceTimers.Remove(fullPath, out System.Threading.Timer? previous)) previous.Dispose();
			_debounceTimers[fullPath] = new System.Threading.Timer(_ => Publish(fullPath, kind), null, 250, Timeout.Infinite);
		}
	}

	private void Publish(string filePath, ExternalFileChangeKind kind)
	{
		lock (_syncRoot)
		{
			if (_debounceTimers.Remove(filePath, out System.Threading.Timer? timer)) timer.Dispose();
		}
		FileChanged?.Invoke(new ExternalFileChange(filePath, kind));
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
