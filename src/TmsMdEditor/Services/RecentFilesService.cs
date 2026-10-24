// ==============================================
// 最近使ったファイルを最大15件に整えて保存する
// ==============================================

// パスの配列は config.json の recentFiles が所有する
// この型は最大 15 件へ整えて ConfigStore に保存を頼み、ファイル自体は開かない

using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// recentFiles を、新しい絶対パスを先頭にした最大 15 件へ整える
/// ファイルの存在は確認しない。保存の成否は ConfigStore が返す
/// </summary>
internal sealed class RecentFilesService
{
	/// <summary>
	/// 一覧に残す件数の上限。超えた分は古い方から捨てる
	/// </summary>
	public const int MaxRecentFiles = 15;

	/// <summary>
	/// 空白だけのパスを除いた一覧を、保存されている順のまま返す。存在確認はしない
	/// </summary>
	/// <param name="config">読む設定。このメソッドは変更しない</param>
	/// <returns>空や空白を除いたパス。絶対パスとは限らない</returns>
	public IReadOnlyList<string> List(AppConfigDocument config)
	{
		return config.RecentFiles
			.Where(path => !string.IsNullOrWhiteSpace(path))
			.ToList();
	}

	/// <summary>
	/// 絶対パスを先頭へ移し、上限を超えた古いパスを捨ててから保存する
	/// 同じパスは大文字小文字を無視して 1 件にまとめる
	/// </summary>
	/// <param name="configStore">保存先。この型は設定ファイルを直接書かない</param>
	/// <param name="config">他の項目を引き継ぐ現在の設定。recentFiles だけを差し替える</param>
	/// <param name="filePath">追加するパス。空白だけなら保存せず失敗する。相対パスはカレントから絶対パスにする</param>
	/// <returns>保存の成否。失敗時のメッセージは結果に入る</returns>
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
	/// 大文字小文字を無視して一致するパスを除き、残りの一覧を保存する
	/// 空のパスは保存せず、今の設定のまま成功とする
	/// </summary>
	/// <param name="configStore">保存先。この型は設定ファイルを直接書かない</param>
	/// <param name="config">他の項目を引き継ぐ現在の設定。recentFiles だけを差し替える</param>
	/// <param name="filePath">除くパス。空白だけなら保存しない。相対パスはカレントから絶対パスにする</param>
	/// <returns>保存の成否。空のパスを渡したときは未保存の成功</returns>
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
