// ==============================================
// JSON ファイルの原子的な読み書き
// ==============================================

// 設定ファイルの形は知らない。呼び出し元がパスと検証を渡し、ここは一時ファイル経由の置換と世代バックアップだけを行う

using System.Text;
using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// JSON を一時ファイル経由で置き換え、直近 10 件のバックアップから復旧できるようにする
/// 逆直列化が null のときと、パスにディレクトリが無いときは例外にする
/// </summary>
internal static class JsonFileHelper
{
	// ==============================================
	// 直列化
	// ==============================================

	/// <summary>
	/// 同じ接頭辞のバックアップを残す件数。より古い最終更新のファイルから削除する
	/// </summary>
	public const int BackupRetentionCount = 10;

	/// <summary>
	/// 読み書きで共有する JSON 設定。camelCase、大文字小文字を無視、インデント、null は書かない
	/// プロセス起動後は変えない
	/// </summary>
	private static readonly JsonSerializerOptions WriteOptions = new()
	{
		PropertyNamingPolicy   = JsonNamingPolicy.CamelCase,
		PropertyNameCaseInsensitive = true,
		WriteIndented        = true,
		DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
	};

	/// <summary>
	/// JSON を同じディレクトリの一時ファイルへ書いてから、既存ファイルを削除して移動する
	/// </summary>
	/// <param name="filePath">出力先。ディレクトリ部分が無ければ失敗する</param>
	/// <param name="data">直列化する値。null のプロパティは書かない</param>
	/// <exception cref="InvalidOperationException"><paramref name="filePath"/> にディレクトリ部分が無い</exception>
	public static void WriteAtomic<T>(string filePath, T data)
	{
		string directory = Path.GetDirectoryName(filePath)
			?? throw new InvalidOperationException($"Invalid file path: {filePath}");

		Directory.CreateDirectory(directory);

		string tempPath = Path.Combine(directory, $".{Path.GetFileName(filePath)}.{Environment.ProcessId}.tmp");
		string json     = JsonSerializer.Serialize(data, WriteOptions) + Environment.NewLine;

		File.WriteAllText(tempPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

		if (File.Exists(filePath))
		{
			File.Delete(filePath);
		}

		File.Move(tempPath, filePath);
	}

	/// <summary>
	/// UTF-8 の JSON ファイルを読む。BOM の有無は Encoding.UTF8 に任せる
	/// </summary>
	/// <param name="filePath">読むファイル。存在しなければ例外が呼び出し元へ伝わる</param>
	/// <returns>逆直列化した値</returns>
	/// <exception cref="InvalidOperationException">JSON が null に逆直列化された</exception>
	public static T Read<T>(string filePath)
	{
		string json = File.ReadAllText(filePath, Encoding.UTF8);
		return JsonSerializer.Deserialize<T>(json, WriteOptions)
			?? throw new InvalidOperationException($"Failed to deserialize JSON: {filePath}");
	}

	// ==============================================
	// バックアップ
	// ==============================================

	/// <summary>
	/// 上書き前のファイルを、時刻付きの名前でバックアップへコピーする。元が無ければ何もしない
	/// </summary>
	/// <param name="sourcePath">退避するファイル。無ければ戻る</param>
	/// <param name="backupDirectory">コピー先ディレクトリ。無ければ作る</param>
	/// <param name="backupPrefix">ファイル名の接頭辞。時刻と .json を後ろへ付ける</param>
	public static void CreateBackup(string sourcePath, string backupDirectory, string backupPrefix)
	{
		if (!File.Exists(sourcePath))
		{
			return;
		}

		Directory.CreateDirectory(backupDirectory);

		string stamp       = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff");
		string backupPath  = Path.Combine(backupDirectory, $"{backupPrefix}.{stamp}.json");
		File.Copy(sourcePath, backupPath, overwrite: false);
		File.SetLastWriteTimeUtc(backupPath, DateTime.UtcNow);
		PurgeOldBackups(backupDirectory, backupPrefix);
	}

	/// <summary>
	/// 同じ接頭辞のバックアップを最終更新の新しい順に残し、上限を超えたものを削除する
	/// </summary>
	/// <param name="backupDirectory">探すディレクトリ。無ければ何もしない</param>
	/// <param name="backupPrefix">残すファイル名の接頭辞</param>
	public static void PurgeOldBackups(string backupDirectory, string backupPrefix)
	{
		if (!Directory.Exists(backupDirectory))
		{
			return;
		}

		var files = Directory.EnumerateFiles(backupDirectory, $"{backupPrefix}.*.json")
			.Select(path => new FileInfo(path))
			.OrderByDescending(file => file.LastWriteTimeUtc)
			.Skip(BackupRetentionCount)
			.ToList();

		foreach (FileInfo file in files)
		{
			file.Delete();
		}
	}

	/// <summary>
	/// 新しいバックアップから順に読み、検証を通過した最初の値を返す
	/// </summary>
	/// <param name="backupDirectory">探すディレクトリ。無ければ失敗</param>
	/// <param name="backupPrefix">対象ファイル名の接頭辞</param>
	/// <param name="validator">復旧してよいかを判定する。false のファイルは飛ばす</param>
	/// <returns>検証を通過した値。ディレクトリが無い、または全部失敗なら default</returns>
	public static T? TryRestoreLatestBackup<T>(string backupDirectory, string backupPrefix, Func<T, bool> validator)
	{
		if (!Directory.Exists(backupDirectory))
		{
			return default;
		}

		foreach (string path in Directory.EnumerateFiles(backupDirectory, $"{backupPrefix}.*.json")
			.OrderByDescending(File.GetLastWriteTimeUtc))
		{
			try
			{
				T restored = Read<T>(path);
				if (validator(restored))
				{
					return restored;
				}
			}
			catch
			{
				// 次のバックアップを試行
			}
		}

		return default;
	}

	/// <summary>
	/// ディレクトリを作り、探針ファイルの作成と削除ができることを確認する。失敗はそのまま呼び出し元へ伝わる
	/// </summary>
	/// <param name="directoryPath">探針するディレクトリ。無ければ作る</param>
	public static void VerifyWritableDirectory(string directoryPath)
	{
		Directory.CreateDirectory(directoryPath);

		string testPath = Path.Combine(directoryPath, $".write-test-{Environment.ProcessId}");
		File.WriteAllText(testPath, "ok", Encoding.UTF8);
		File.Delete(testPath);
	}
}
