// ==============================================
// タイトルを変え、外へ出たタブを別ウィンドウへ渡す
// ==============================================

// タイトル変更は同じプロセスのフォームへ返す
// ウィンドウの外へ出たタブは、別の編集ウィンドウへ渡すか、新しいプロセスを起動する

using System.Diagnostics;
using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// window:* を受けるブリッジ。転送用の一時ファイルは成功するまで残し、失敗時は削除する
/// </summary>
internal sealed class WindowApi
{
	/// <summary>
	/// タイトル更新と、切り離し先を探すときの自分のウィンドウ。API より長く生きる
	/// </summary>
	private readonly MainForm _mainForm;

	/// <summary>
	/// ウィンドウ API を作る。フォームは借用し、ここでは破棄しない
	/// </summary>
	/// <param name="mainForm">タイトルと境界の判定に使うフォーム。null は渡さない</param>
	public WindowApi(MainForm mainForm)
	{
		_mainForm = mainForm;
	}

	/// <summary>
	/// ネイティブウィンドウのタイトルを差し替える。title が無いときは製品名に戻す
	/// </summary>
	/// <param name="paramsElement">title を持つ JSON。プロパティが無い、または null のときは TMS-MDEditor</param>
	/// <returns>更新を受け付けた結果。タイトル文字列の検証失敗は返さない</returns>
	public WindowTitleResult SetTitle(JsonElement paramsElement)
	{
		// 表示するタイトル。プロパティが無い、または null のときは製品名 TMS-MDEditor
		string title = paramsElement.TryGetProperty(BridgeProperty.Title, out JsonElement titleElement)
			? titleElement.GetString() ?? "TMS-MDEditor"
			: "TMS-MDEditor";

		_mainForm.UpdateWindowTitle(title);
		return new WindowTitleResult();
	}

	/// <summary>
	/// ウィンドウの外へドロップされたタブを、別の編集ウィンドウか新しいプロセスへ渡す
	/// 自分のウィンドウ内なら何もせず detached は false。渡し先を作れないときは一時ファイルを削除して失敗する
	/// </summary>
	/// <param name="paramsElement">tab オブジェクトを持つ JSON。座標は使わず、現在のカーソル位置で判定する</param>
	/// <returns>detached が true のとき、タブは元ウィンドウから外してよい</returns>
	/// <exception cref="InvalidOperationException">tab がオブジェクトでない、または実行ファイルのパスを取得できない</exception>
	public object DetachTab(JsonElement paramsElement)
	{
		// いまのカーソル位置。スクリーン座標、ピクセル。要求 JSON の座標は使わない
		Point dropPoint = Cursor.Position;
		// ドロップ位置が自分のウィンドウ内のとき。タブは外さず detached は false
		if (_mainForm.Bounds.Contains(dropPoint))
		{
			return new { detached = false };
		}
		// tab がオブジェクトとして取れないとき。プロパティが無い、または値があってもオブジェクトでない。両方揃ったオブジェクトでは入らない
		if (!paramsElement.TryGetProperty(BridgeProperty.Tab, out JsonElement tabElement) || tabElement.ValueKind != JsonValueKind.Object)
		{
			throw new InvalidOperationException("切り離すタブ状態が指定されていません。");
		}

		// タブ状態を置く一時ディレクトリ。無ければ作る
		string transferDirectory = AppPaths.TabTransferDirectory;
		Directory.CreateDirectory(transferDirectory);
		// この切り離し専用の JSON。渡し先を作れないときは削除する
		string transferPath = Path.Combine(transferDirectory, $"{Guid.NewGuid():N}.json");
		File.WriteAllText(transferPath, tabElement.GetRawText());

		// 自分の exe のパス。取れないときは例外になり、一時ファイルは残る
		string executablePath = Environment.ProcessPath
			?? throw new InvalidOperationException("実行ファイルのパスを取得できませんでした。");
		// カーソル位置に別の編集ウィンドウがあるとき。targetWindow はそのハンドル。無ければ新しいプロセスを起動する
		if (WindowInterop.TryFindOtherEditorWindow(dropPoint, _mainForm.Handle, executablePath, out IntPtr targetWindow))
		{
			// true なら相手がタブを受け取った。false は受け取り失敗で、一時ファイルを消す
			bool transferred = WindowInterop.SendDetachedTab(
				targetWindow,
				_mainForm.Handle,
				new DetachedTabTransferRequest(transferPath, dropPoint.X, dropPoint.Y));
			// 相手が受け取れなかったとき。一時ファイルを残すと次の起動が誤読する
			if (!transferred) File.Delete(transferPath);
			return new { detached = transferred };
		}

		// 新しいプロセスの起動情報。引数で一時ファイルとドロップ座標を渡す
		var startInfo = new ProcessStartInfo(executablePath)
		{
			// false ならシェルを介さず、このプロセスと同じユーザーで起動する
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
