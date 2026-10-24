// ==============================================
// 最近使ったファイルの追加と削除を設定へ反映する
// ==============================================

// 一覧の実体は設定ファイルにあり、追加と削除の成功時だけメモリ上の設定とメニューを更新する
// 保存に失敗したときはメニューを変えず、結果のメッセージを Web 層へ返す

using System.Text.Json;
using TmsMdEditor.Models;

namespace TmsMdEditor.Bridge;

/// <summary>
/// recent:* を受けるブリッジ。件数の上限とパスの正規化は RecentFilesService が行う
/// </summary>
internal sealed class RecentApi
{
	/// <summary>
	/// 設定の読み書き先。API より長く生き、保存成功時だけ Config を差し替える
	/// </summary>
	private readonly AppContext _appContext;

	/// <summary>
	/// 保存後に最近使ったファイルのメニューを描き直す宛先
	/// </summary>
	private readonly MainForm _mainForm;

	/// <summary>
	/// 最近使ったファイル API を作る。フォームとコンテキストは借用する
	/// </summary>
	/// <param name="mainForm">メニューの再描画先。null は渡さない</param>
	/// <param name="appContext">設定と最近使ったファイルのサービス。null は渡さない</param>
	public RecentApi(MainForm mainForm, AppContext appContext)
	{
		_mainForm    = mainForm;
		_appContext  = appContext;
	}

	/// <summary>
	/// 最近使ったファイルのパスを新しい順で返す。空白の要素は含めない
	/// </summary>
	/// <returns>パスの一覧。0 件のときも Files は空で、失敗は返さない</returns>
	public RecentFilesResponse List()
	{
		return new RecentFilesResponse
		{
			Files = _appContext.RecentFilesService.List(_appContext.Config),
		};
	}

	/// <summary>
	/// ファイルを一覧の先頭へ加え、設定を保存する。成功したときだけメニューを更新する
	/// </summary>
	/// <param name="paramsElement">filePath を持つ JSON。無い、または空白のときは保存せず失敗を返す</param>
	/// <returns>保存結果。失敗時は Config が null で、メニューは変えない</returns>
	public SaveConfigResult Add(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		SaveConfigResult result = _appContext.RecentFilesService.Add(_appContext.ConfigStore, _appContext.Config, filePath);
		ApplySavedConfig(result);
		return result;
	}

	/// <summary>
	/// 一覧からパスを外し、設定を保存する。成功したときだけメニューを更新する
	/// </summary>
	/// <param name="paramsElement">filePath を持つ JSON。無いときは保存せず失敗を返す</param>
	/// <returns>保存結果。失敗時はメニューを変えない</returns>
	public SaveConfigResult Remove(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		SaveConfigResult result = _appContext.RecentFilesService.Remove(_appContext.ConfigStore, _appContext.Config, filePath);
		ApplySavedConfig(result);
		return result;
	}

	/// <summary>
	/// 保存に成功した設定をメモリへ反映し、最近使ったファイルのメニューを描き直す
	/// 失敗、または Config が null のときは何もしない
	/// </summary>
	/// <param name="result">Add または Remove の保存結果</param>
	private void ApplySavedConfig(SaveConfigResult result)
	{
		if (result.Success && result.Config is not null)
		{
			_appContext.Config = result.Config;
			_mainForm.RefreshRecentFilesMenu();
		}
	}
}
