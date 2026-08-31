using System.Text.Json;
using TmsMdEditor.Bridge;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class ShellApiTests
{
	[Fact]
	public void ParseExternalBrowserCommand_handles_quoted_executable_and_profile_arguments()
	{
		ExternalBrowserCommand command = ShellApi.ParseExternalBrowserCommand(
			@"""C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"" --profile-directory=""Profile 1""");

		Assert.Equal(@"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", command.FileName);
		Assert.Equal(["--profile-directory=Profile 1"], command.Arguments);
	}

	[Fact]
	public void ParseExternalBrowserCommand_handles_command_name_and_arguments()
	{
		ExternalBrowserCommand command = ShellApi.ParseExternalBrowserCommand(@"firefox -p ""MyProfile_TMSystems""");

		Assert.Equal("firefox", command.FileName);
		Assert.Equal(["-p", "MyProfile_TMSystems"], command.Arguments);
	}

	[Fact]
	public void ParseExternalBrowserCommand_rejects_empty_command()
	{
		Assert.Throws<InvalidOperationException>(() => ShellApi.ParseExternalBrowserCommand("  "));
	}

	[Fact]
	public void OpenExternal_uses_custom_browser_command_for_https_url()
	{
		string tempRoot   = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-shell-test-{Guid.NewGuid():N}");
		string scriptPath = Path.Combine(tempRoot, "capture-url.ps1");
		string markerPath = Path.Combine(tempRoot, "opened-url.txt");
		Directory.CreateDirectory(tempRoot);
		try
		{
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

	[Fact]
	public void OpenExternal_rejects_non_http_url()
	{
		var api = new ShellApi(new TmsMdEditor.AppContext());

		Assert.Throws<InvalidOperationException>(() =>
			api.OpenExternal(JsonDocument.Parse("""{"url":"mailto:test@example.com"}""").RootElement));
	}

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
