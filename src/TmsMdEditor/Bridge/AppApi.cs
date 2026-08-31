using System.Text.Json;
using TmsMdEditor.Models;

namespace TmsMdEditor.Bridge;

/// <summary>
/// アプリ制御ブリッジ API
/// </summary>
internal sealed class AppApi
{
	private readonly MainForm _mainForm;

	/// <summary>
	/// アプリ API を初期化する
	/// </summary>
	/// <param name="mainForm">メインフォーム</param>
	public AppApi(MainForm mainForm)
	{
		_mainForm = mainForm;
	}

	/// <summary>
	/// クローズ可否を C# へ通知する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>受付結果</returns>
	public CloseDecisionResult ReportCloseReady(JsonElement paramsElement)
	{
		bool allowClose = paramsElement.TryGetProperty("allowClose", out JsonElement allowCloseElement)
			&& allowCloseElement.GetBoolean();

		_mainForm.CompleteCloseDecision(allowClose);
		return new CloseDecisionResult { AllowClose = allowClose };
	}

	/// <summary>
	/// シェルメニューを閉じる
	/// </summary>
	/// <returns>結果</returns>
	public object DismissMenus()
	{
		_mainForm.DismissShellMenus();
		return new { ok = true };
	}
}
