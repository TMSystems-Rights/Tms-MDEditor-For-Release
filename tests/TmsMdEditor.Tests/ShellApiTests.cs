// ==============================================
// 外部ブラウザで開く URL の制限
// ==============================================

// カスタムブラウザのコマンド分割と、https だけをそのコマンドへ渡すことを固定する

using System.Text.Json;
using TmsMdEditor.Bridge;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// コマンド文字列の分割はプロセスを起動しない
/// URL を開くケースだけ、ブラウザの代わりに一時スクリプトを起動する
/// </summary>
public class ShellApiTests
{
	/// <summary>
	/// 引用符付きの実行ファイルと、引数内の引用符を分けて取り出す
	/// </summary>
	[Fact]
	public void ParseExternalBrowserCommand_handles_quoted_executable_and_profile_arguments()
	{
		ExternalBrowserCommand command = ShellApi.ParseExternalBrowserCommand(
			@"""C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"" --profile-directory=""Profile 1""");

		Assert.Equal(@"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", command.FileName);
		Assert.Equal(["--profile-directory=Profile 1"], command.Arguments);
	}

	/// <summary>
	/// コマンド名と、引用符付き引数を個別の引数へ分ける
	/// </summary>
	[Fact]
	public void ParseExternalBrowserCommand_handles_command_name_and_arguments()
	{
		ExternalBrowserCommand command = ShellApi.ParseExternalBrowserCommand(@"firefox -p ""MyProfile_TMSystems""");

		Assert.Equal("firefox", command.FileName);
		Assert.Equal(["-p", "MyProfile_TMSystems"], command.Arguments);
	}

	/// <summary>
	/// 空白だけのコマンドは InvalidOperationException になる
	/// </summary>
	[Fact]
	public void ParseExternalBrowserCommand_rejects_empty_command()
	{
		Assert.Throws<InvalidOperationException>(() => ShellApi.ParseExternalBrowserCommand("  "));
	}

	/// <summary>
	/// カスタムコマンドに、https の URL が引数として渡る
	/// </summary>
	[Fact]
	public void OpenExternal_uses_custom_browser_command_for_https_url()
	{
		string tempRoot   = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-shell-test-{Guid.NewGuid():N}");
		string scriptPath = Path.Combine(tempRoot, "capture-url.ps1");
		string markerPath = Path.Combine(tempRoot, "opened-url.txt");
		Directory.CreateDirectory(tempRoot);
		try
		{
			// ブラウザの代わりに、受け取った URL をファイルへ書くスクリプトをカスタムコマンドにする
			File.WriteAllText(
				scriptPath,
				$"""
				param([string]$url)
				Set-Content -LiteralPath "{markerPath}" -Value $url -Encoding UTF8
				""");
			var context = new TmsMdEditor.AppContext
			{
				Config = ConfigStore.CreateDefaultConfig(),
			};
			context.Config.Settings.ExternalBrowser.Mode = "custom";
			context.Config.Settings.ExternalBrowser.CustomCommand =
				$"pwsh -NoProfile -ExecutionPolicy Bypass -File \"{scriptPath}\"";
			var api = new ShellApi(context);

			api.OpenExternal(JsonDocument.Parse("""{"url":"https://tm-systems.jp/"}""").RootElement);

			Assert.True(WaitForFile(markerPath), "custom browser command did not receive the URL.");
			Assert.Equal("https://tm-systems.jp/", File.ReadAllText(markerPath).Trim());
		}
		finally
		{
			if (Directory.Exists(tempRoot))
			{
				Directory.Delete(tempRoot, true);
			}
		}
	}

	/// <summary>
	/// http 以外の URL は InvalidOperationException になり、開かない
	/// </summary>
	[Fact]
	public void OpenExternal_rejects_non_http_url()
	{
		var api = new ShellApi(new TmsMdEditor.AppContext());

		Assert.Throws<InvalidOperationException>(() =>
			api.OpenExternal(JsonDocument.Parse("""{"url":"mailto:test@example.com"}""").RootElement));
	}

	/// <summary>
	/// カスタムブラウザのスクリプトが URL を書くまで、短い間隔でファイルの出現を待つ
	/// </summary>
	/// <param name="filePath">出現を見るファイル。空でも例外にはせず、現れなければ false</param>
	/// <returns>約5秒以内にファイルができれば true</returns>
	private static bool WaitForFile(string filePath)
	{
		for (int attempt = 0; attempt < 50; attempt++)
		{
			if (File.Exists(filePath))
			{
				return true;
			}

			Thread.Sleep(100);
		}

		return false;
	}
}
