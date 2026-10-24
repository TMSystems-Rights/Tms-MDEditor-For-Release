// ==============================================
// ウィンドウ間のタブ転送
// ==============================================

// ドロップ座標の下にある別プロセスへ、WM_COPYDATA で状態ファイルのパスだけを渡す
// タブの中身はファイルが持ち、座標の画面内への収めは別の計算が行う

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using TmsMdEditor.Bridge;

namespace TmsMdEditor.Services;

/// <summary>
/// 同じ exe の別トップレベルウィンドウを探し、切り離しタブの転送要求を送受信する
/// 相手が応答しないときは送信を打ち切り、別アプリへは送らない
/// </summary>
internal static class WindowInterop
{
	// ==============================================
	// 転送の定数
	// ==============================================

	/// <summary>
	/// WM_COPYDATA のメッセージ番号。これ以外のメッセージは転送要求として読まない
	/// </summary>
	public const int CopyDataMessage = 0x004A;

	/// <summary>
	/// 自アプリの転送データであることを示す固定値。受信側はこれが一致するバッファだけを読む
	/// </summary>
	private const long DetachedTabSignature = 0x544D534D;

	/// <summary>
	/// GetAncestor でトップレベルを取るフラグ。子コントロール上のドロップをウィンドウ単位へ揃える
	/// </summary>
	private const uint GetAncestorRoot = 2;

	/// <summary>
	/// 相手が応答不能なら送信を中断する SendMessageTimeout のフラグ
	/// </summary>
	private const uint SendMessageAbortIfHung = 0x0002;

	/// <summary>
	/// 相手ウィンドウからの応答を待つ上限。単位はミリ秒。超えたら未送信として扱う
	/// </summary>
	private const int SendMessageTimeoutMs = 2000;

	/// <summary>
	/// ShowWindow で通常表示へ戻すコマンド。最小化された受け側を前面化する前に使う
	/// </summary>
	private const int ShowNormal = 5;

	// ==============================================
	// ウィンドウ検索とメッセージ
	// ==============================================

	/// <summary>
	/// 指定座標の直下にある、別プロセスの同じ exe のトップレベルウィンドウを返す
	/// </summary>
	/// <param name="screenPoint">ドロップ位置。単位はスクリーン px</param>
	/// <param name="currentWindow">ドラッグ元のトップレベル。これ自身は対象にしない</param>
	/// <param name="executablePath">自プロセスの exe。相手の実行ファイルと大文字小文字を無視して比較する</param>
	/// <param name="targetWindow">見つかったトップレベル。失敗時は Zero</param>
	/// <returns>別プロセスの同じ exe なら true。子ウィンドウ、自ウィンドウ、別アプリは false</returns>
	public static bool TryFindOtherEditorWindow(Point screenPoint, IntPtr currentWindow, string executablePath, out IntPtr targetWindow)
	{
		// 子コントロール上へドロップされても、比較・転送対象はトップレベルウィンドウに揃える
		IntPtr child = WindowFromPoint(new NativePoint(screenPoint.X, screenPoint.Y));
		IntPtr root  = child == IntPtr.Zero ? IntPtr.Zero : GetAncestor(child, GetAncestorRoot);
		targetWindow = IntPtr.Zero;
		if (root == IntPtr.Zero || root == currentWindow) return false;

		GetWindowThreadProcessId(root, out uint processId);
		if (processId == 0) return false;
		try
		{
			// タイトルやクラス名ではなく実行ファイルを照合し、別アプリへのWM_COPYDATA送信を防ぐ
			using Process process = Process.GetProcessById((int)processId);
			string? targetPath = process.MainModule?.FileName;
			if (!string.Equals(Path.GetFullPath(targetPath ?? string.Empty), Path.GetFullPath(executablePath), StringComparison.OrdinalIgnoreCase)) return false;
		}
		catch
		{
			return false;
		}

		targetWindow = root;
		return true;
	}

	/// <summary>
	/// 別ウィンドウへ切り離しタブの転送要求を送り、相手が受理したかを返す
	/// </summary>
	/// <param name="targetWindow">送信先のトップレベル</param>
	/// <param name="sourceWindow">送信元として wParam に渡すウィンドウ</param>
	/// <param name="request">状態ファイルのパスとドロップ座標</param>
	/// <returns>相手が 1 を返したら true。タイムアウトや未受理は false</returns>
	public static bool SendDetachedTab(IntPtr targetWindow, IntPtr sourceWindow, DetachedTabTransferRequest request)
	{
		string json = JsonSerializer.Serialize(request, BridgeJson.Options);
		IntPtr data = Marshal.StringToHGlobalUni(json);
		try
		{
			// 受信側が自アプリの転送データだけを識別できるよう、固定シグネチャを付ける
			var copyData = new CopyDataStruct
			{
				DataIdentifier = new IntPtr(DetachedTabSignature),
				ByteCount      = (json.Length + 1) * sizeof(char),
				DataPointer    = data,
			};
			// 相手ウィンドウが応答不能でも、ドラッグ元UIを無期限に止めない
			bool sent = SendMessageTimeout(
				targetWindow,
				CopyDataMessage,
				sourceWindow,
				ref copyData,
				SendMessageAbortIfHung,
				SendMessageTimeoutMs,
				out IntPtr result);
			return sent && result == new IntPtr(1);
		}
		finally
		{
			Marshal.FreeHGlobal(data);
		}
	}

	/// <summary>
	/// WM_COPYDATA から切り離しタブの転送要求を復元する。シグネチャが違うメッセージは読まない
	/// </summary>
	/// <param name="message">ウィンドウ手続きが受け取ったメッセージ</param>
	/// <param name="request">復元した要求。失敗時は null</param>
	/// <returns>シグネチャと状態ファイルのパスが有効なら true</returns>
	public static bool TryReadDetachedTab(Message message, out DetachedTabTransferRequest? request)
	{
		request = null;
		if (message.Msg != CopyDataMessage || message.LParam == IntPtr.Zero) return false;
		CopyDataStruct data = Marshal.PtrToStructure<CopyDataStruct>(message.LParam);
		// メッセージ種別に加えてシグネチャとバッファ長を検証してからポインターを読む
		if (data.DataIdentifier.ToInt64() != DetachedTabSignature || data.DataPointer == IntPtr.Zero || data.ByteCount <= sizeof(char)) return false;

		string? json = Marshal.PtrToStringUni(data.DataPointer, data.ByteCount / sizeof(char) - 1);
		if (string.IsNullOrWhiteSpace(json)) return false;
		request = JsonSerializer.Deserialize<DetachedTabTransferRequest>(json, BridgeJson.Options);
		return request is not null && !string.IsNullOrWhiteSpace(request.TransferPath);
	}

	/// <summary>
	/// ウィンドウを通常表示に戻して前面化する。最小化された受け側を操作できる位置へ出す
	/// </summary>
	/// <param name="window">前面化するトップレベル</param>
	public static void ActivateWindow(IntPtr window)
	{
		ShowWindow(window, ShowNormal);
		SetForegroundWindow(window);
	}

	// ==============================================
	// Win32
	// ==============================================

	/// <summary>
	/// スクリーン座標の直下にあるウィンドウを返す。トップレベルとは限らない
	/// </summary>
	/// <param name="point">スクリーン座標。単位は px</param>
	/// <returns>直下のウィンドウ。無ければ Zero</returns>
	[DllImport("user32.dll")]
	private static extern IntPtr WindowFromPoint(NativePoint point);

	/// <summary>
	/// 指定した祖先ウィンドウを返す。ルート指定でトップレベルへ揃える
	/// </summary>
	/// <param name="window">起点のウィンドウ</param>
	/// <param name="flags">祖先の種類。ルートは 2</param>
	/// <returns>祖先ウィンドウ。無ければ Zero</returns>
	[DllImport("user32.dll")]
	private static extern IntPtr GetAncestor(IntPtr window, uint flags);

	/// <summary>
	/// ウィンドウを作ったスレッドとプロセスの ID を返す
	/// </summary>
	/// <param name="window">調べるウィンドウ</param>
	/// <param name="processId">プロセス ID。取れなければ 0</param>
	/// <returns>スレッド ID</returns>
	[DllImport("user32.dll")]
	private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

	/// <summary>
	/// 相手が応答しないとき中断できるタイムアウト付きでメッセージを送る
	/// </summary>
	/// <param name="window">送信先</param>
	/// <param name="message">メッセージ番号</param>
	/// <param name="wordParameter">wParam。送信元ウィンドウ</param>
	/// <param name="longParameter">lParam。COPYDATASTRUCT</param>
	/// <param name="flags">応答不能時の中断フラグ</param>
	/// <param name="timeout">待ち時間。単位はミリ秒</param>
	/// <param name="result">相手の戻り値。受理は 1</param>
	/// <returns>タイムアウト前に処理されたら true</returns>
	[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool SendMessageTimeout(
		IntPtr window,
		int message,
		IntPtr wordParameter,
		ref CopyDataStruct longParameter,
		uint flags,
		int timeout,
		out IntPtr result);

	/// <summary>
	/// ウィンドウを前面化する
	/// </summary>
	/// <param name="window">前面化するウィンドウ</param>
	/// <returns>前面化できたら true</returns>
	[DllImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool SetForegroundWindow(IntPtr window);

	/// <summary>
	/// ウィンドウの表示状態を変える
	/// </summary>
	/// <param name="window">対象ウィンドウ</param>
	/// <param name="command">ShowWindow のコマンド。通常表示は 5</param>
	/// <returns>以前表示されていたら true</returns>
	[DllImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool ShowWindow(IntPtr window, int command);

	/// <summary>
	/// WindowFromPoint へ渡すスクリーン座標。単位は px
	/// </summary>
	[StructLayout(LayoutKind.Sequential)]
	private readonly struct NativePoint
	{
		/// <summary>
		/// スクリーンの水平位置。単位は px
		/// </summary>
		public readonly int X;

		/// <summary>
		/// スクリーンの垂直位置。単位は px
		/// </summary>
		public readonly int Y;

		/// <summary>
		/// スクリーン座標を Win32 の点にする
		/// </summary>
		/// <param name="x">水平位置。単位は px</param>
		/// <param name="y">垂直位置。単位は px</param>
		public NativePoint(int x, int y)
		{
			X = x;
			Y = y;
		}
	}

	/// <summary>
	/// WM_COPYDATA のペイロード。受信側はシグネチャとバイト数を見てからポインタを読む
	/// </summary>
	[StructLayout(LayoutKind.Sequential)]
	private struct CopyDataStruct
	{
		/// <summary>
		/// 自アプリの転送であることを示す固定値
		/// </summary>
		public IntPtr DataIdentifier;

		/// <summary>
		/// ポインタ先のバイト数。終端の null 文字を含む
		/// </summary>
		public int ByteCount;

		/// <summary>
		/// UTF-16 文字列のポインタ。所有は送信側が解放する
		/// </summary>
		public IntPtr DataPointer;
	}
}

/// <summary>
/// 既存ウィンドウへ渡す切り離しタブの位置。タブの中身は状態ファイルが持つ
/// </summary>
/// <param name="TransferPath">受け側が読む状態ファイルのパス</param>
/// <param name="ScreenX">ドロップ位置の水平座標。単位はスクリーン px</param>
/// <param name="ScreenY">ドロップ位置の垂直座標。単位はスクリーン px</param>
internal sealed record DetachedTabTransferRequest(string TransferPath, int ScreenX, int ScreenY);

/// <summary>
/// 新規ウィンドウの左上を、ドロップ位置から作業領域の中へ収める。状態は持たない
/// </summary>
internal static class DetachedWindowPlacement
{
	/// <summary>
	/// ドロップ座標をタブ付近にずらした左上を、作業領域の中へ収めて返す
	/// </summary>
	/// <param name="dropPoint">ドロップ位置。単位はスクリーン px</param>
	/// <param name="windowSize">新ウィンドウの大きさ。単位は px</param>
	/// <param name="workingArea">収め先の作業領域。単位は px</param>
	/// <returns>作業領域内の左上。単位は px</returns>
	public static Point CalculateLocation(Point dropPoint, Size windowSize, Rectangle workingArea)
	{
		int offsetX = Math.Min(120, Math.Max(0, windowSize.Width / 4));
		int desiredX = dropPoint.X - offsetX;
		int desiredY = dropPoint.Y - 40;
		int maxX = Math.Max(workingArea.Left, workingArea.Right - windowSize.Width);
		int maxY = Math.Max(workingArea.Top, workingArea.Bottom - windowSize.Height);
		return new Point(
			Math.Clamp(desiredX, workingArea.Left, maxX),
			Math.Clamp(desiredY, workingArea.Top, maxY));
	}
}
