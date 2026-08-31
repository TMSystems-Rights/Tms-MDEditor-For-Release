using System.Runtime.InteropServices;

namespace TmsMdEditor.Services;

/// <summary>
/// プロセスの AppUserModelID を設定する
/// </summary>
internal static class AppUserModelId
{
	/// <summary>
	/// 現在の配布形態に応じた AppUserModelID をプロセスへ設定する
	/// </summary>
	public static void Apply()
	{
		string appUserModelId = PortableMode.ResolveAppUserModelId(AppPaths.IsPortable, PortalUrl.IsDebugBuild());
		_ = SetCurrentProcessExplicitAppUserModelID(appUserModelId);
	}

	[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
	private static extern int SetCurrentProcessExplicitAppUserModelID(string appID);
}
