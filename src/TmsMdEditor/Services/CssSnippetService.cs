using System.Text;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// dataDir 配下の CSS スニペットを列挙・読み込みする。
/// </summary>
internal sealed class CssSnippetService
{
	private readonly ConfigStore _configStore;
	private readonly Logger _logger;

	/// <summary>
	/// CSS スニペットサービスを初期化する。
	/// </summary>
	/// <param name="configStore">設定ストア</param>
	/// <param name="logger">ロガー</param>
	public CssSnippetService(ConfigStore configStore, Logger logger)
	{
		_configStore = configStore;
		_logger      = logger;
	}

	/// <summary>
	/// CSS スニペットを列挙し、内容を読み込む。
	/// </summary>
	/// <returns>スニペット一覧</returns>
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
	/// スニペットフォルダのパスを取得する。
	/// </summary>
	/// <returns>スニペットフォルダのパス</returns>
	public string GetDirectoryPath()
	{
		return AppPaths.GetSnippetsDirectory(_configStore.GetDataDirInfo().DataDir);
	}

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
			_logger.Warn("css-snippets", "CSS スニペットの読み込みに失敗しました", new Dictionary<string, object?>
			{
				["file"]  = path,
				["error"] = ex.Message,
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
