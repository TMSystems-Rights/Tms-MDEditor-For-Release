using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// 最近使ったファイル管理
/// </summary>
internal sealed class RecentFilesService
{
	public const int MaxRecentFiles = 15;

	/// <summary>
	/// 最近使ったファイル一覧を取得する
	/// </summary>
	/// <param name="config">設定</param>
	/// <returns>ファイルパス一覧</returns>
	public IReadOnlyList<string> List(AppConfigDocument config)
	{
		return config.RecentFiles
			.Where(path => !string.IsNullOrWhiteSpace(path))
			.ToList();
	}

	/// <summary>
	/// 最近使ったファイルへ追加する
	/// </summary>
	/// <param name="configStore">設定ストア</param>
	/// <param name="config">現在設定</param>
	/// <param name="filePath">ファイルパス</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult Add(ConfigStore configStore, AppConfigDocument config, string filePath)
	{
		if (string.IsNullOrWhiteSpace(filePath))
		{
			return new SaveConfigResult
			{
				Success = false,
				Message = "ファイルパスが空です。",
			};
		}

		string normalizedPath = Path.GetFullPath(filePath);
		List<string> recentFiles = config.RecentFiles
			.Where(path => !string.Equals(Path.GetFullPath(path), normalizedPath, StringComparison.OrdinalIgnoreCase))
			.ToList();

		recentFiles.Insert(0, normalizedPath);

		if (recentFiles.Count > MaxRecentFiles)
		{
			recentFiles = recentFiles.Take(MaxRecentFiles).ToList();
		}

		return configStore.Save(new AppConfigDocument
		{
			SchemaVersion     = config.SchemaVersion,
			Window            = config.Window,
			Settings          = config.Settings,
			CustomDecorations = config.CustomDecorations,
			RecentFiles       = recentFiles,
		});
	}

	/// <summary>
	/// 最近使ったファイルから削除する
	/// </summary>
	/// <param name="configStore">設定ストア</param>
	/// <param name="config">現在設定</param>
	/// <param name="filePath">ファイルパス</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult Remove(ConfigStore configStore, AppConfigDocument config, string filePath)
	{
		if (string.IsNullOrWhiteSpace(filePath))
		{
			return new SaveConfigResult { Success = true, Config = config };
		}

		string normalizedPath = Path.GetFullPath(filePath);
		List<string> recentFiles = config.RecentFiles
			.Where(path => !string.Equals(Path.GetFullPath(path), normalizedPath, StringComparison.OrdinalIgnoreCase))
			.ToList();

		return configStore.Save(new AppConfigDocument
		{
			SchemaVersion     = config.SchemaVersion,
			Window            = config.Window,
			Settings          = config.Settings,
			CustomDecorations = config.CustomDecorations,
			RecentFiles       = recentFiles,
		});
	}
}
