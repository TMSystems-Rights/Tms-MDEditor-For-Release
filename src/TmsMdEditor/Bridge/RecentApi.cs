using System.Text.Json;
using TmsMdEditor.Models;

namespace TmsMdEditor.Bridge;

/// <summary>
/// 最近使ったファイル関連ブリッジ API
/// </summary>
internal sealed class RecentApi
{
	private readonly AppContext _appContext;
	private readonly MainForm _mainForm;

	/// <summary>
	/// 最近使ったファイル API を初期化する
	/// </summary>
	/// <param name="mainForm">メインフォーム</param>
	/// <param name="appContext">アプリコンテキスト</param>
	public RecentApi(MainForm mainForm, AppContext appContext)
	{
		_mainForm    = mainForm;
		_appContext  = appContext;
	}

	/// <summary>
	/// 最近使ったファイル一覧を取得する
	/// </summary>
	/// <returns>一覧</returns>
	public RecentFilesResponse List()
	{
		return new RecentFilesResponse
		{
			Files = _appContext.RecentFilesService.List(_appContext.Config),
		};
	}

	/// <summary>
	/// 最近使ったファイルへ追加する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult Add(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty("filePath", out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		SaveConfigResult result = _appContext.RecentFilesService.Add(_appContext.ConfigStore, _appContext.Config, filePath);
		ApplySavedConfig(result);
		return result;
	}

	/// <summary>
	/// 最近使ったファイルから削除する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult Remove(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty("filePath", out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		SaveConfigResult result = _appContext.RecentFilesService.Remove(_appContext.ConfigStore, _appContext.Config, filePath);
		ApplySavedConfig(result);
		return result;
	}

	private void ApplySavedConfig(SaveConfigResult result)
	{
		if (result.Success && result.Config is not null)
		{
			_appContext.Config = result.Config;
			_mainForm.RefreshRecentFilesMenu();
		}
	}
}
