// ==============================================
// プロセスの AppUserModelID をシェルへ渡す
// ==============================================

// 起動後にシェルへ 1 回渡す。タスクバーのまとめ方は OS が決め、失敗しても起動は続ける

using System.Runtime.InteropServices;

namespace TmsMdEditor.Services;

/// <summary>
/// ポータブル、Debug、インストーラの別で AppUserModelID を現在プロセスへ設定する
/// シェルが返す HRESULT は見ない
/// </summary>
internal static class AppUserModelId
{
	/// <summary>
	/// 今の配布形態に対応する AppUserModelID をプロセスへ設定する。戻り値は捨てる
	/// </summary>
	public static void Apply()
	{
		string appUserModelId = PortableMode.ResolveAppUserModelId(AppPaths.IsPortable, PortalUrl.IsDebugBuild());
		_ = SetCurrentProcessExplicitAppUserModelID(appUserModelId);
	}

	/// <summary>
	/// 現在プロセスの明示的な AppUserModelID をシェルへ設定する
	/// </summary>
	/// <param name="appID">設定する AppUserModelID。呼び出し元は空を渡さない</param>
	/// <returns>HRESULT。成功は 0。呼び出し元は見ない</returns>
	[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
	private static extern int SetCurrentProcessExplicitAppUserModelID(string appID);
}
