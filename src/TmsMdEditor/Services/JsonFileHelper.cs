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
	// 全ストアが同じ形で書くための設定。個別の呼び出しでは上書きしない
	private static readonly JsonSerializerOptions WriteOptions = new()
	{
		// ディスク上の名前は camelCase。C# のプロパティ名とは別に揃える
		PropertyNamingPolicy   = JsonNamingPolicy.CamelCase,
		// 読み込み時は大文字小文字の違いを同じ項目として受ける
		PropertyNameCaseInsensitive = true,
		// 人が差分を見られるよう折り返す
		WriteIndented        = true,
		// null の項目は書かない。欠ける項目は読み込み側の既定になる
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
		// 出力先のディレクトリ。パスにディレクトリが無ければ例外で、一時ファイルは作らない
		string directory = Path.GetDirectoryName(filePath)
			?? throw new InvalidOperationException($"Invalid file path: {filePath}");

		Directory.CreateDirectory(directory);

		// 同じディレクトリの一時ファイル。プロセス ID を含め、置換前の本体とは別名
		string tempPath = Path.Combine(directory, $".{Path.GetFileName(filePath)}.{Environment.ProcessId}.tmp");
		// 末尾改行付きの JSON。null プロパティは書かない
		string json     = JsonSerializer.Serialize(data, WriteOptions) + Environment.NewLine;

		File.WriteAllText(tempPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

		// 既存があるときだけ消してから移動する。初回の未作成では入らない
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
		// BOM の有無は Encoding.UTF8 に任せる本文。空ファイルは空文字
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
		// 元が無い上書き前は退避しない
		if (!File.Exists(sourcePath))
		{
			return;
		}

		Directory.CreateDirectory(backupDirectory);

		// ファイル名に入れるローカル時刻。ミリ秒まで。書式は yyyyMMdd-HHmmss-fff
		string stamp       = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff");
		// 接頭辞、時刻、.json を付けたコピー先。同名は上書きしない
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
		// ディレクトリが無いときは削除対象も無い
		if (!Directory.Exists(backupDirectory))
		{
			return;
		}

		// 新しい順で上限 10 件を超えたファイル。0 件なら何も消さない
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
		// バックアップ先が無いときは default。呼び出し元は復旧失敗として扱う
		if (!Directory.Exists(backupDirectory))
		{
			return default;
		}

		foreach (string path in Directory.EnumerateFiles(backupDirectory, $"{backupPrefix}.*.json")
			.OrderByDescending(File.GetLastWriteTimeUtc))
		{
			try
			{
				// このファイルを直列化した値。壊れていれば catch で次へ進む
				T restored = Read<T>(path);
				// 検証を通過した最初の値だけ返す。false のファイルは飛ばす
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

		// 作成と削除で書き込みを確認する探針ファイル。プロセス ID で他プロセスと分ける
		string testPath = Path.Combine(directoryPath, $".write-test-{Environment.ProcessId}");
		File.WriteAllText(testPath, "ok", Encoding.UTF8);
		File.Delete(testPath);
	}
}
