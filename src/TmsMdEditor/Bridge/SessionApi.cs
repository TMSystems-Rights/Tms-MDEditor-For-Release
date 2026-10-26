// ==============================================
// 起動時セッションの保存
// ==============================================

// 主ウィンドウだけが次回起動用のタブ構成を書く
// 副ウィンドウの一部のタブで、主ウィンドウの復元内容を上書きしない

using System.Text.Json;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// session:save を受けるブリッジ。ストアの寿命はプロセス側にあり、この API は破棄しない
/// </summary>
internal sealed class SessionApi
{
	/// <summary>
	/// セッション JSON の保存先。API より長く生きる
	/// </summary>
	private readonly SessionStore _sessionStore;

	/// <summary>
	/// このウィンドウが復元セッションの所有者か。false のあいだは保存しない。生成後は変えない
	/// </summary>
	private readonly bool _isSessionOwner;

	/// <summary>
	/// セッション保存 API を作る。ストアは借用し、ここでは破棄しない
	/// </summary>
	/// <param name="sessionStore">保存先。null は渡さない</param>
	/// <param name="isSessionOwner">true のときだけ保存する。副ウィンドウは false</param>
	public SessionApi(SessionStore sessionStore, bool isSessionOwner)
	{
		_sessionStore   = sessionStore;
		_isSessionOwner = isSessionOwner;
	}

	/// <summary>
	/// 開いているタブ構成を次回起動用に保存する
	/// 副ウィンドウでは保存せず、失敗結果だけを返す
	/// </summary>
	/// <param name="paramsElement">Web 層のセッション JSON。副ウィンドウでは中身を見ない</param>
	/// <returns>主ウィンドウではストアの保存結果。副ウィンドウでは Success が false</returns>
	public SessionSaveResult Save(JsonElement paramsElement)
	{
		// 副ウィンドウの部分的なタブ構成で、主ウィンドウの復元セッションを上書きしない
		if (!_isSessionOwner)
		{
			// 保存しなかった結果。Web 層は失敗として扱い、ディスクのセッションは残る
			return new SessionSaveResult
			{
				// false は未保存。副ウィンドウでは常に失敗にする
				Success = false,
				// 保存しなかった理由。空にはしない
				Message = "副ウィンドウはセッションを保存しません。",
			};
		}

		return _sessionStore.Save(paramsElement);
	}
}
