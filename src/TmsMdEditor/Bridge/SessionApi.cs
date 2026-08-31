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
		if (!_isSessionOwner)
		{
			return new SessionSaveResult { Success = false, Message = "副ウィンドウはセッションを保存しません。" };
		}

		return _sessionStore.Save(paramsElement);
	}
}
