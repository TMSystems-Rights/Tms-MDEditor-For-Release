using System.Text.Json;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>セッション保存ブリッジ API。</summary>
internal sealed class SessionApi
{
	private readonly SessionStore _sessionStore;
	private readonly bool _isSessionOwner;

	public SessionApi(SessionStore sessionStore, bool isSessionOwner)
	{
		_sessionStore   = sessionStore;
		_isSessionOwner = isSessionOwner;
	}

	public SessionSaveResult Save(JsonElement paramsElement)
	{
		// 副ウィンドウの部分的なタブ構成で、主ウィンドウの復元セッションを上書きしない。
		if (!_isSessionOwner)
		{
			return new SessionSaveResult { Success = false, Message = "副ウィンドウはセッションを保存しません。" };
		}

		return _sessionStore.Save(paramsElement);
	}
}
