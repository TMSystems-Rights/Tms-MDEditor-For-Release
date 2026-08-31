using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using TmsMdEditor.Bridge;

namespace TmsMdEditor.Services;

/// <summary>ウィンドウ間タブ移動に必要な Win32 操作を提供する</summary>
internal static class WindowInterop
{
	public const int CopyDataMessage = 0x004A;
	private const long DetachedTabSignature = 0x544D534D;
	private const uint GetAncestorRoot = 2;
	private const uint SendMessageAbortIfHung = 0x0002;
	private const int SendMessageTimeoutMs = 2000;
	private const int ShowNormal = 5;

	/// <summary>指定座標直下にある別の TMS-MDEditor トップレベルウィンドウを返す</summary>
	public static bool TryFindOtherEditorWindow(Point screenPoint, IntPtr currentWindow, string executablePath, out IntPtr targetWindow)
	{
		IntPtr child = WindowFromPoint(new NativePoint(screenPoint.X, screenPoint.Y));
		IntPtr root  = child == IntPtr.Zero ? IntPtr.Zero : GetAncestor(child, GetAncestorRoot);
		targetWindow = IntPtr.Zero;
		if (root == IntPtr.Zero || root == currentWindow) return false;

		GetWindowThreadProcessId(root, out uint processId);
		if (processId == 0) return false;
		try
		{
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

	/// <summary>別ウィンドウへ切り離しタブ転送要求を送る</summary>
	public static bool SendDetachedTab(IntPtr targetWindow, IntPtr sourceWindow, DetachedTabTransferRequest request)
	{
		string json = JsonSerializer.Serialize(request, BridgeJson.Options);
		IntPtr data = Marshal.StringToHGlobalUni(json);
		try
		{
			var copyData = new CopyDataStruct
			{
				DataIdentifier = new IntPtr(DetachedTabSignature),
				ByteCount      = (json.Length + 1) * sizeof(char),
				DataPointer    = data,
			};
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

	/// <summary>WM_COPYDATA から切り離しタブ転送要求を復元する</summary>
	public static bool TryReadDetachedTab(Message message, out DetachedTabTransferRequest? request)
	{
		request = null;
		if (message.Msg != CopyDataMessage || message.LParam == IntPtr.Zero) return false;
		CopyDataStruct data = Marshal.PtrToStructure<CopyDataStruct>(message.LParam);
		if (data.DataIdentifier.ToInt64() != DetachedTabSignature || data.DataPointer == IntPtr.Zero || data.ByteCount <= sizeof(char)) return false;

		string? json = Marshal.PtrToStringUni(data.DataPointer, data.ByteCount / sizeof(char) - 1);
		if (string.IsNullOrWhiteSpace(json)) return false;
		request = JsonSerializer.Deserialize<DetachedTabTransferRequest>(json, BridgeJson.Options);
		return request is not null && !string.IsNullOrWhiteSpace(request.TransferPath);
	}

	/// <summary>ウィンドウを復元して前面化する</summary>
	public static void ActivateWindow(IntPtr window)
	{
		ShowWindow(window, ShowNormal);
		SetForegroundWindow(window);
	}

	[DllImport("user32.dll")]
	private static extern IntPtr WindowFromPoint(NativePoint point);

	[DllImport("user32.dll")]
	private static extern IntPtr GetAncestor(IntPtr window, uint flags);

	[DllImport("user32.dll")]
	private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

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

	[DllImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool SetForegroundWindow(IntPtr window);

	[DllImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool ShowWindow(IntPtr window, int command);

	[StructLayout(LayoutKind.Sequential)]
	private readonly struct NativePoint
	{
		public readonly int X;
		public readonly int Y;

		public NativePoint(int x, int y)
		{
			X = x;
			Y = y;
		}
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct CopyDataStruct
	{
		public IntPtr DataIdentifier;
		public int ByteCount;
		public IntPtr DataPointer;
	}
}

/// <summary>既存ウィンドウへ渡す切り離しタブ情報</summary>
internal sealed record DetachedTabTransferRequest(string TransferPath, int ScreenX, int ScreenY);

/// <summary>新規ウィンドウの表示位置を算出する</summary>
internal static class DetachedWindowPlacement
{
	/// <summary>ドロップ座標をタブ付近に置き、作業領域内へ収める</summary>
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
