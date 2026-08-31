using System.Text;
using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// JSON ファイルの読み書きユーティリティ
/// </summary>
internal static class JsonFileHelper
{
	public const int BackupRetentionCount = 10;

	private static readonly JsonSerializerOptions WriteOptions = new()
	{
		PropertyNamingPolicy   = JsonNamingPolicy.CamelCase,
		PropertyNameCaseInsensitive = true,
		WriteIndented        = true,
		DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
	};

	/// <summary>
	/// JSON をアトミックに書き込む
	/// </summary>
	/// <typeparam name="T">型</typeparam>
	/// <param name="filePath">出力先</param>
	/// <param name="data">データ</param>
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
	/// JSON ファイルを読み込む
	/// </summary>
	/// <typeparam name="T">型</typeparam>
	/// <param name="filePath">ファイルパス</param>
	/// <returns>デシリアライズ結果</returns>
	public static T Read<T>(string filePath)
	{
		string json = File.ReadAllText(filePath, Encoding.UTF8);
		return JsonSerializer.Deserialize<T>(json, WriteOptions)
			?? throw new InvalidOperationException($"Failed to deserialize JSON: {filePath}");
	}

	/// <summary>
	/// 書き込み前バックアップを作成する
	/// </summary>
	/// <param name="sourcePath">元ファイル</param>
	/// <param name="backupDirectory">バックアップ先ディレクトリ</param>
	/// <param name="backupPrefix">バックアップファイル名接頭辞</param>
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
	/// 古いバックアップを削除する
	/// </summary>
	/// <param name="backupDirectory">バックアップディレクトリ</param>
	/// <param name="backupPrefix">接頭辞</param>
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
	/// 最新バックアップから復旧を試みる
	/// </summary>
	/// <typeparam name="T">型</typeparam>
	/// <param name="backupDirectory">バックアップディレクトリ</param>
	/// <param name="backupPrefix">接頭辞</param>
	/// <param name="validator">復旧データ検証</param>
	/// <returns>復旧データ。失敗時 null</returns>
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
	/// ディレクトリへの書き込み可否を検証する
	/// </summary>
	/// <param name="directoryPath">検証対象</param>
	public static void VerifyWritableDirectory(string directoryPath)
	{
		Directory.CreateDirectory(directoryPath);

		string testPath = Path.Combine(directoryPath, $".write-test-{Environment.ProcessId}");
		File.WriteAllText(testPath, "ok", Encoding.UTF8);
		File.Delete(testPath);
	}
}
