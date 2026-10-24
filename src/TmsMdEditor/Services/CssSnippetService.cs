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
		DataDirInfo dataDirInfo = _configStore.GetDataDirInfo();
		string directory        = AppPaths.GetSnippetsDirectory(dataDirInfo.DataDir);

		if (!Directory.Exists(directory))
		{
			return new CssSnippetsResponse
			{
				DirectoryPath = directory,
				Error         = $"CSSスニペットフォルダが見つかりません。dataDir の設定を確認してください: {directory}",
			};
		}

		HashSet<string> enabled = new(
			(_configStore.CachedConfig ?? _configStore.Load().Config).Settings.CssSnippets.Enabled,
			StringComparer.OrdinalIgnoreCase);

		List<CssSnippetInfo> snippets = Directory
			.EnumerateFiles(directory, "*.css", SearchOption.TopDirectoryOnly)
			.OrderBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
			.Select(path => ReadSnippet(path, enabled))
			.ToList();

		return new CssSnippetsResponse
		{
			DirectoryPath = directory,
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
		string name = Path.GetFileName(path);

		try
		{
			return new CssSnippetInfo
			{
				Name    = name,
				Enabled = enabled.Contains(name),
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

			return new CssSnippetInfo
			{
				Name    = name,
				Enabled = enabled.Contains(name),
				Error   = ex.Message,
			};
		}
	}
}
