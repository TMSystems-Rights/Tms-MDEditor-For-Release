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
		// 空白だけのパスは一覧へ入れず、保存せず失敗にする
		if (string.IsNullOrWhiteSpace(filePath))
		{
			// 呼び出し元へ返す失敗。設定ファイルは書いていない
			return new SaveConfigResult
			{
				// 保存していない。空パスでは recentFiles を変えない
				Success = false,
				// 利用者へ出す理由。空パスではこの文言固定
				Message = "ファイルパスが空です。",
			};
		}

		// カレント基準の絶対パス。比較と先頭挿入はこれを使う
		string normalizedPath = Path.GetFullPath(filePath);
		// 同じパスを除いた既存一覧。大文字小文字の違いは同一とみなして捨てる
		List<string> recentFiles = config.RecentFiles
			.Where(path => !string.Equals(Path.GetFullPath(path), normalizedPath, StringComparison.OrdinalIgnoreCase))
			.ToList();

		recentFiles.Insert(0, normalizedPath);

		// 上限を超えたとき、古い末尾を捨てて 15 件にする。ちょうど 15 件では入らない
		if (recentFiles.Count > MaxRecentFiles)
		{
			recentFiles = recentFiles.Take(MaxRecentFiles).ToList();
		}

		// 他の項目は引き継ぎ、recentFiles だけ差し替えた保存用の設定
		return configStore.Save(new AppConfigDocument
		{
			// 保存前の版をそのまま引き継ぐ。この追加では上げない
			SchemaVersion     = config.SchemaVersion,
			// ウィンドウ配置は最近使ったファイルの更新では変えない
			Window            = config.Window,
			// エディタ設定は引き継ぐ
			Settings          = config.Settings,
			// 装飾定義は引き継ぐ
			CustomDecorations = config.CustomDecorations,
			// 今回の絶対パスを先頭にした最大 15 件
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
		// 空白だけのパスは除く対象が無いので、保存せず今の設定のまま成功にする
		if (string.IsNullOrWhiteSpace(filePath))
		{
			// 未保存の成功。一覧は引数のまま
			return new SaveConfigResult
			{
				// 失敗扱いにしない。空パスは何も除かない
				Success = true,
				// 保存していない現在の設定。recentFiles も引数のまま
				Config = config,
			};
		}

		// カレント基準の絶対パス。大文字小文字を無視してこのパスを除く
		string normalizedPath = Path.GetFullPath(filePath);
		// 一致しなかった残りの一覧。元の並びは維持する
		List<string> recentFiles = config.RecentFiles
			.Where(path => !string.Equals(Path.GetFullPath(path), normalizedPath, StringComparison.OrdinalIgnoreCase))
			.ToList();

		// 他の項目は引き継ぎ、除いたあとの recentFiles だけを保存する
		return configStore.Save(new AppConfigDocument
		{
			// 保存前の版をそのまま引き継ぐ
			SchemaVersion     = config.SchemaVersion,
			// ウィンドウ配置は削除では変えない
			Window            = config.Window,
			// エディタ設定は引き継ぐ
			Settings          = config.Settings,
			// 装飾定義は引き継ぐ
			CustomDecorations = config.CustomDecorations,
			// 一致したパスを除いた残り。0 件なら空
			RecentFiles       = recentFiles,
		});
	}
}
