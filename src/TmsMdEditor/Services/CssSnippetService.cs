// ==============================================
// CSS スニペットの列挙
// ==============================================

// ファイルの中身はスニペットフォルダが所有する。この型は dataDir の *.css を読むだけで、有効一覧の保存はしない

using System.Text;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// dataDir 直下の snippets にある CSS をファイル名順に読み、設定の有効一覧と突き合わせる
/// フォルダが無いときは空一覧とエラー文を返し、1 ファイルの失敗は他のファイルを止めない
/// </summary>
internal sealed class CssSnippetService
{
	/// <summary>
	/// 有効なファイル名と dataDir を読む設定。このサービスは設定を書き戻さない
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// 1 ファイルの読み込み失敗を記録するログ。一覧の成否には影響しない
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// 設定とログを受け取る。どちらもこのサービスでは破棄しない
	/// </summary>
	/// <param name="configStore">dataDir と有効スニペット名の読み元</param>
	/// <param name="logger">読み込み失敗を Warn で残すログ</param>
	public CssSnippetService(ConfigStore configStore, Logger logger)
	{
		_configStore = configStore;
		_logger      = logger;
	}

	/// <summary>
	/// snippets 直下の *.css を名前順に読み、有効かどうかと本文を返す。サブフォルダは見ない
	/// </summary>
	/// <returns>フォルダパスとスニペット一覧。フォルダが無ければ Error を入れ、Snippets は空</returns>
	public CssSnippetsResponse List()
	{
		// 今の dataDir。スニペットの親。キャッシュは更新しない
		DataDirInfo dataDirInfo = _configStore.GetDataDirInfo();
		// snippets の絶対パス。フォルダが無くてもここまでは作らない
		string directory        = AppPaths.GetSnippetsDirectory(dataDirInfo.DataDir);

		// フォルダが無いときは空一覧とエラー文を返し、列挙しない
		if (!Directory.Exists(directory))
		{
			// 見つからなかったフォルダを、エラー付きで返す
			return new CssSnippetsResponse
			{
				// 設定確認用に、無かったパスをそのまま返す
				DirectoryPath = directory,
				// 呼び出し元へ見せる理由。Snippets は既定の空
				Error         = $"CSSスニペットフォルダが見つかりません。dataDir の設定を確認してください: {directory}",
			};
		}

		// 有効なファイル名。キャッシュが null のときは読み直す。比較は大文字小文字を無視
		HashSet<string> enabled = new(
			(_configStore.CachedConfig ?? _configStore.Load().Config).Settings.CssSnippets.Enabled,
			StringComparer.OrdinalIgnoreCase);

		// 直下の *.css を名前順に読んだ一覧。サブフォルダは含めない
		List<CssSnippetInfo> snippets = Directory
			.EnumerateFiles(directory, "*.css", SearchOption.TopDirectoryOnly)
			.OrderBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
			.Select(path => ReadSnippet(path, enabled))
			.ToList();

		// フォルダと読めた一覧。エラーはファイル単位で Snippets に載る
		return new CssSnippetsResponse
		{
			// 列挙したフォルダ
			DirectoryPath = directory,
			// 読めなかったファイルも Error 付きで含む。0 件なら空
			Snippets      = snippets,
		};
	}

	/// <summary>
	/// 現在の dataDir からスニペットフォルダの絶対パスを返す。フォルダの有無は見ない
	/// </summary>
	/// <returns>snippets フォルダの絶対パス</returns>
	public string GetDirectoryPath()
	{
		return AppPaths.GetSnippetsDirectory(_configStore.GetDataDirInfo().DataDir);
	}

	/// <summary>
	/// 1 つの CSS を UTF-8 で読む。失敗しても例外にせず、エラー文だけを載せる
	/// </summary>
	/// <param name="path">読む *.css の絶対パス</param>
	/// <param name="enabled">有効なファイル名。大文字小文字は無視する。キーはファイル名だけで、パスは含まない</param>
	/// <returns>ファイル名、有効状態、本文。失敗時は本文の代わりに Error</returns>
	private CssSnippetInfo ReadSnippet(string path, HashSet<string> enabled)
	{
		// 有効判定に使うファイル名。パスは含めない
		string name = Path.GetFileName(path);

		try
		{
			// 読めた 1 件。本文は UTF-8
			return new CssSnippetInfo
			{
				// ファイル名だけ。ディレクトリは含めない
				Name    = name,
				// 設定の有効一覧にあれば true。大文字小文字は無視
				Enabled = enabled.Contains(name),
				// ファイル本文。空ファイルは空文字
				CssText = File.ReadAllText(path, Encoding.UTF8),
			};
		}
		catch (Exception ex)
		{
			_logger.Warn(LogCategory.CssSnippets, "CSS スニペットの読み込みに失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.File]  = path,
				[LogProperty.Error] = ex.Message,
			});

			// 失敗しても一覧は止めず、本文の代わりにエラー文を載せる
			return new CssSnippetInfo
			{
				// 読めなくてもファイル名は残す
				Name    = name,
				// 有効一覧の判定は読み込み成否と無関係
				Enabled = enabled.Contains(name),
				// 利用者向けの失敗理由。CssText は既定の空
				Error   = ex.Message,
			};
		}
	}
}
