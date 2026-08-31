using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// 日次ログ出力サービス
/// </summary>
internal sealed class Logger
{
	private const int LogRetentionDays = 14;

	private static readonly Dictionary<LogLevel, int> LevelPriority = new()
	{
		[LogLevel.Debug] = 0,
		[LogLevel.Info]  = 1,
		[LogLevel.Warn]  = 2,
		[LogLevel.Error] = 3,
	};

	private readonly object _syncRoot = new();
	private LogLevel _minLogLevel = LogLevel.Info;

	/// <summary>
	/// 情報ログを出力する
	/// </summary>
	/// <param name="source">出力元</param>
	/// <param name="message">メッセージ</param>
	/// <param name="data">追加データ</param>
	public void Info(string source, string message, IDictionary<string, object?>? data = null)
	{
		Write(LogLevel.Info, source, message, data);
	}

	/// <summary>
	/// 警告ログを出力する
	/// </summary>
	/// <param name="source">出力元</param>
	/// <param name="message">メッセージ</param>
	/// <param name="data">追加データ</param>
	public void Warn(string source, string message, IDictionary<string, object?>? data = null)
	{
		Write(LogLevel.Warn, source, message, data);
	}

	/// <summary>
	/// エラーログを出力する
	/// </summary>
	/// <param name="source">出力元</param>
	/// <param name="message">メッセージ</param>
	/// <param name="data">追加データ</param>
	public void Error(string source, string message, IDictionary<string, object?>? data = null)
	{
		Write(LogLevel.Error, source, message, data);
	}

	/// <summary>
	/// デバッグログを出力する
	/// </summary>
	/// <param name="source">出力元</param>
	/// <param name="message">メッセージ</param>
	/// <param name="data">追加データ</param>
	public void Debug(string source, string message, IDictionary<string, object?>? data = null)
	{
		Write(LogLevel.Debug, source, message, data);
	}

	/// <summary>
	/// ログをファイルへ書き込む
	/// </summary>
	/// <param name="level">ログレベル</param>
	/// <param name="source">出力元</param>
	/// <param name="message">メッセージ</param>
	/// <param name="data">追加データ</param>
	private void Write(LogLevel level, string source, string message, IDictionary<string, object?>? data)
	{
		if (LevelPriority[level] < LevelPriority[_minLogLevel])
		{
			return;
		}

		lock (_syncRoot)
		{
			string logDir = GetLogDirectory();
			Directory.CreateDirectory(logDir);
			PurgeOldLogs(logDir);

			string line = FormatLine(level, source, message, data);
			string path = Path.Combine(logDir, GetTodayLogFileName());
			File.AppendAllText(path, line + Environment.NewLine);
		}
	}

	/// <summary>
	/// ログ行を整形する
	/// </summary>
	/// <param name="level">ログレベル</param>
	/// <param name="source">出力元</param>
	/// <param name="message">メッセージ</param>
	/// <param name="data">追加データ</param>
	/// <returns>整形済みログ行</returns>
	private static string FormatLine(LogLevel level, string source, string message, IDictionary<string, object?>? data)
	{
		string timestamp = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffK");
		string payload   = data is null || data.Count == 0
			? string.Empty
			: " " + JsonSerializer.Serialize(data);

		return $"[{timestamp}] [{level.ToString().ToUpperInvariant()}] [{source}] {message}{payload}";
	}

	/// <summary>
	/// ログディレクトリのパスを取得する
	/// </summary>
	/// <returns>ログディレクトリ</returns>
	private static string GetLogDirectory()
	{
		return AppPaths.LogsDirectory;
	}

	/// <summary>
	/// 当日のログファイル名を取得する
	/// </summary>
	/// <returns>ログファイル名</returns>
	private static string GetTodayLogFileName()
	{
		return $"app-{DateTime.Now:yyyyMMdd}.log";
	}

	/// <summary>
	/// 保持期間を超えたログファイルを削除する
	/// </summary>
	/// <param name="logDir">ログディレクトリ</param>
	private static void PurgeOldLogs(string logDir)
	{
		DateTime cutoff = DateTime.Now.AddDays(-LogRetentionDays);

		foreach (string file in Directory.EnumerateFiles(logDir, "app-*.log"))
		{
			if (File.GetLastWriteTime(file) < cutoff)
			{
				File.Delete(file);
			}
		}
	}

	/// <summary>
	/// デバッグビルドかどうかを判定する
	/// </summary>
	/// <returns>デバッグビルドの場合 true</returns>
	private static bool IsDebugBuild()
	{
#if DEBUG
		return true;
#else
		return false;
#endif
	}

	/// <summary>
	/// ログレベル
	/// </summary>
	private enum LogLevel
	{
		Debug,
		Info,
		Warn,
		Error,
	}
}
