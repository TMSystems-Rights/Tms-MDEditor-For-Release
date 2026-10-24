// ==============================================
// Web の閉じ判断とメニュー操作をシェルへ渡す
// ==============================================

// ウィンドウとメニューの実体は MainForm が持つ
// この API は状態を持たず、Web 層の要求を渡すだけ。破棄もしない

using System.Text.Json;
using TmsMdEditor.Models;

namespace TmsMdEditor.Bridge;

/// <summary>
/// app:reportCloseReady と、シェルメニューの操作を MainForm へ渡す
/// </summary>
internal sealed class AppApi
{
	/// <summary>
	/// 閉じる判断とメニュー更新の宛先。API より長く生きる
	/// </summary>
	private readonly MainForm _mainForm;

	/// <summary>
	/// アプリ操作 API を作る。フォームは借用し、ここでは破棄しない
	/// </summary>
	/// <param name="mainForm">閉じる判断とメニューの宛先。null は渡さない</param>
	public AppApi(MainForm mainForm)
	{
		_mainForm = mainForm;
	}

	/// <summary>
	/// 未保存確認の結果をシェルへ渡し、閉じてよいときだけウィンドウを閉じ直す
	/// </summary>
	/// <param name="paramsElement">allowClose を持つ JSON。プロパティが無いときは閉じない</param>
	/// <returns>シェルへ渡したのと同じ可否。Web 層への応答に使う</returns>
	public CloseDecisionResult ReportCloseReady(JsonElement paramsElement)
	{
		bool allowClose = paramsElement.TryGetProperty(BridgeProperty.AllowClose, out JsonElement allowCloseElement)
			&& allowCloseElement.GetBoolean();

		_mainForm.CompleteCloseDecision(allowClose);
		return new CloseDecisionResult { AllowClose = allowClose };
	}

	/// <summary>
	/// 開いているシェルのドロップダウンを閉じる。Web 層の操作をメニューが隠したままにしない
	/// </summary>
	/// <returns>受付済みを表す ok。失敗は返さない</returns>
	public object DismissMenus()
	{
		_mainForm.DismissShellMenus();
		return new { ok = true };
	}

	/// <summary>
	/// Web側のテーブル選択状態を上部メニューへ反映する
	/// </summary>
	/// <param name="paramsElement">操作 ID をキーにした活性状態。オブジェクトでなければ該当項目は無効になる</param>
	/// <returns>受付済みを表す ok。メニューが無い操作 ID は無視する</returns>
	public object UpdateTableMenuState(JsonElement paramsElement)
	{
		_mainForm.UpdateTableMenuState(paramsElement);
		return new { ok = true };
	}
}
