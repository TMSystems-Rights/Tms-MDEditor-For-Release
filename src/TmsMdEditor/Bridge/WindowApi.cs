using System.Diagnostics;
using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// ウィンドウ関連ブリッジ API
/// </summary>
internal sealed class WindowApi
{
	private readonly MainForm _mainForm;

	/// <summary>
	/// ウィンドウ API を初期化する
	/// </summary>
	/// <param name="mainForm">メインフォーム</param>
	public WindowApi(MainForm mainForm)
	{
		_mainForm = mainForm;
	}

	/// <summary>
	/// ウィンドウタイトルを更新する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>更新結果</returns>
	public WindowTitleResult SetTitle(JsonElement paramsElement)
	{
		string title = paramsElement.TryGetProperty("title", out JsonElement titleElement)
			? titleElement.GetString() ?? "TMS-MDEditor"
			: "TMS-MDEditor";

		_mainForm.UpdateWindowTitle(title);
		return new WindowTitleResult();
	}

	/// <summary>
	/// ウィンドウ外へドロップされたタブ状態を新しいプロセスへ引き渡す
	/// </summary>
	/// <param name="paramsElement">タブ状態とドロップ座標</param>
	/// <returns>切り離し結果</returns>
	public object DetachTab(JsonElement paramsElement)
	{
		Point dropPoint = Cursor.Position;
		if (_mainForm.Bounds.Contains(dropPoint))
		{
			return new { detached = false };
		}
		if (!paramsElement.TryGetProperty("tab", out JsonElement tabElement) || tabElement.ValueKind != JsonValueKind.Object)
		{
			throw new InvalidOperationException("切り離すタブ状態が指定されていません。");
		}

		string transferDirectory = Path.Combine(Path.GetTempPath(), "TmsMdEditor", "tab-transfers");
		Directory.CreateDirectory(transferDirectory);
		string transferPath = Path.Combine(transferDirectory, $"{Guid.NewGuid():N}.json");
		File.WriteAllText(transferPath, tabElement.GetRawText());

		string executablePath = Environment.ProcessPath
			?? throw new InvalidOperationException("実行ファイルのパスを取得できませんでした。");
		if (WindowInterop.TryFindOtherEditorWindow(dropPoint, _mainForm.Handle, executablePath, out IntPtr targetWindow))
		{
			bool transferred = WindowInterop.SendDetachedTab(
				targetWindow,
				_mainForm.Handle,
				new DetachedTabTransferRequest(transferPath, dropPoint.X, dropPoint.Y));
			if (!transferred) File.Delete(transferPath);
			return new { detached = transferred };
		}

		var startInfo = new ProcessStartInfo(executablePath)
		{
			UseShellExecute = false,
		};
		startInfo.ArgumentList.Add("--force-new-window");
		startInfo.ArgumentList.Add("--detached-tab");
		startInfo.ArgumentList.Add(transferPath);
		startInfo.ArgumentList.Add("--window-x");
		startInfo.ArgumentList.Add(dropPoint.X.ToString());
		startInfo.ArgumentList.Add("--window-y");
		startInfo.ArgumentList.Add(dropPoint.Y.ToString());

		try
		{
			Process.Start(startInfo);
			return new { detached = true };
		}
		catch
		{
			File.Delete(transferPath);
			throw;
		}
	}
}
