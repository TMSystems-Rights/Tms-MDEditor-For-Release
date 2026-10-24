// ==============================================
// 日次ログファイルへの追記
// ==============================================

// インスタンスごとにロックを持ち、同じ日付ファイルへ追記する
// 呼び出し元は書き込み結果を受け取らない

using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// 当日ファイルへレベル付きで 1 行追記し、14 日より古い app-*.log を削除する
/// 下限未満は捨てる。ディレクトリ作成や追記に失敗すると例外が呼び出し元へ伝わる
/// </summary>
internal sealed class Logger
{
	/// <summary>
	/// ログファイルを残す日数
	/// 最終更新が現在からこの日数より前の app-*.log を削除する
	/// </summary>
	private const int LogRetentionDays = 14;

	/// <summary>
	/// ログレベルの強さ。値が大きいほど重要で、下限との比較にだけ使う
	/// プロセス起動後は変えない
	/// </summary>
	private static readonly Dictionary<LogLevel, int> LevelPriority = new()
	{
		[LogLevel.Debug] = 0,
		[LogLevel.Info]  = 1,
		[LogLevel.Warn]  = 2,
		[LogLevel.Error] = 3,
	};

	/// <summary>
	/// 追記と古いファイルの削除を直列化するロック
	/// 1 回の書き込みが終わるまでだけ持つ
	/// </summary>
	private readonly object _syncRoot = new();

	/// <summary>
	/// これより弱いレベルは捨てる
	/// 初期値は Info。実行中に変える手段は無い
	/// </summary>
	private LogLevel _minLogLevel = LogLevel.Info;

	/// <summary>
	/// Info として 1 行追記する。下限が Info より上なら何もしない
	/// </summary>
	/// <param name="source">出力元の短い識別子。<see cref="LogCategory"/> の定数を渡す</param>
	/// <param name="message">行の本文。改行を含むとそのまま複数行になる</param>
	/// <param name="data">本文の後ろへ JSON で付ける項目。null または空なら付けない</param>
	public void Info(string source, string message, IDictionary<string, object?>? data = null)
	{
		Write(LogLevel.Info, source, message, data);
	}

	/// <summary>
	/// Warn として 1 行追記する。処理は続行できる失敗に使う。下限未満なら何もしない
	/// </summary>
	/// <param name="source">出力元の短い識別子。<see cref="LogCategory"/> の定数を渡す</param>
	/// <param name="message">行の本文。改行を含むとそのまま複数行になる</param>
	/// <param name="data">本文の後ろへ JSON で付ける項目。null または空なら付けない</param>
	public void Warn(string source, string message, IDictionary<string, object?>? data = null)
	{
		Write(LogLevel.Warn, source, message, data);
	}

	/// <summary>
	/// Error として 1 行追記する。呼び出し元の操作が失敗したときに使う。下限未満なら何もしない
	/// </summary>
	/// <param name="source">出力元の短い識別子。<see cref="LogCategory"/> の定数を渡す</param>
	/// <param name="message">行の本文。改行を含むとそのまま複数行になる</param>
	/// <param name="data">本文の後ろへ JSON で付ける項目。null または空なら付けない</param>
	public void Error(string source, string message, IDictionary<string, object?>? data = null)
	{
		Write(LogLevel.Error, source, message, data);
	}

	/// <summary>
	/// Debug として 1 行追記する。既定の下限 Info ではファイルへ出ない
	/// </summary>
	/// <param name="source">出力元の短い識別子。<see cref="LogCategory"/> の定数を渡す</param>
	/// <param name="message">行の本文。改行を含むとそのまま複数行になる</param>
	/// <param name="data">本文の後ろへ JSON で付ける項目。null または空なら付けない</param>
	public void Debug(string source, string message, IDictionary<string, object?>? data = null)
	{
		Write(LogLevel.Debug, source, message, data);
	}

	/// <summary>
	/// 下限を満たすときだけ排他し、ログディレクトリを作って古いファイルを削除したあと、当日ファイルへ 1 行追記する
	/// </summary>
	/// <param name="level">この行の強さ。下限より弱いときは戻る</param>
	/// <param name="source">出力元の短い識別子。空でも行は書く</param>
	/// <param name="message">行の本文。改行を含むとそのまま複数行になる</param>
	/// <param name="data">本文の後ろへ JSON で付ける項目。null または空なら付けない</param>
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
	/// タイムスタンプ、レベル、出力元、本文、任意の JSON を空白区切りで 1 行に連結する。末尾改行は付けない
	/// </summary>
	/// <param name="level">大文字のレベル名として埋め込む強さ</param>
	/// <param name="source">角括弧で囲む出力元</param>
	/// <param name="message">レベル名の後ろに置く本文</param>
	/// <param name="data">末尾へ付ける JSON。null または空なら付けない</param>
	/// <returns>ファイルへ追記する 1 行。末尾の改行は含まない</returns>
	private static string FormatLine(LogLevel level, string source, string message, IDictionary<string, object?>? data)
	{
		string timestamp = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffK");
		string payload   = data is null || data.Count == 0
			? string.Empty
			: " " + JsonSerializer.Serialize(data);

		return $"[{timestamp}] [{level.ToString().ToUpperInvariant()}] [{source}] {message}{payload}";
	}

	/// <summary>
	/// 追記先ディレクトリの絶対パスを、その場の <see cref="AppPaths.LogsDirectory"/> から読む
	/// </summary>
	/// <returns>ログディレクトリの絶対パス。呼び出しのたびに解決する</returns>
	private static string GetLogDirectory()
	{
		return AppPaths.LogsDirectory;
	}

	/// <summary>
	/// ローカル日付のログファイル名を返す。日付をまたぐと別ファイルになる
	/// </summary>
	/// <returns>app-yyyyMMdd.log 形式のファイル名。ディレクトリは含まない</returns>
	private static string GetTodayLogFileName()
	{
		return $"app-{DateTime.Now:yyyyMMdd}.log";
	}

	/// <summary>
	/// 最終更新が保持日数より前の app-*.log を削除する。該当が無くても戻る
	/// </summary>
	/// <param name="logDir">削除対象を探すディレクトリ。存在することは呼び出し側が保証する</param>
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
	/// コンパイル時に DEBUG が定義されていれば true を返す。実行中の設定は見ない
	/// </summary>
	/// <returns>DEBUG ビルドなら true。Release では false</returns>
	private static bool IsDebugBuild()
	{
#if DEBUG
		return true;
#else
		return false;
#endif
	}

	/// <summary>
	/// 1 行の強さ。数値が大きいほど重要で、<see cref="LevelPriority"/> が比較に使う
	/// </summary>
	private enum LogLevel
	{
		/// <summary>
		/// 調査用。既定の下限 Info ではファイルへ出ない
		/// </summary>
		Debug,

		/// <summary>
		/// 通常の完了。既定の下限
		/// </summary>
		Info,

		/// <summary>
		/// 処理は続行できる失敗
		/// </summary>
		Warn,

		/// <summary>
		/// 呼び出し元の操作が失敗したこと
		/// </summary>
		Error,
	}
}
