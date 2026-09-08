using System.Diagnostics;
using System.Text.Json;
using TmsMdEditor.Models;

namespace TmsMdEditor.Bridge;

/// <summary>
/// シェル操作ブリッジ API
/// </summary>
internal sealed class ShellApi
{
	private readonly AppContext _appContext;

	/// <summary>
	/// シェル操作ブリッジ API を初期化する
	/// </summary>
	/// <param name="appContext">アプリコンテキスト</param>
	public ShellApi(AppContext appContext)
	{
		_appContext = appContext;
	}

	/// <summary>
	/// エクスプローラーでファイルを表示する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>実行結果</returns>
	public object ShowInFolder(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty("filePath", out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath))
		{
			throw new InvalidOperationException("ファイルが見つかりません。");
		}

		Process.Start(new ProcessStartInfo
		{
			FileName        = "explorer.exe",
			Arguments       = $"/select,\"{Path.GetFullPath(filePath)}\"",
			UseShellExecute = true,
		});

		return new { ok = true };
	}

	/// <summary>
	/// エクスプローラーでフォルダを開く
	/// </summary>
	/// <param name="folderPath">フォルダパス</param>
	/// <returns>実行結果</returns>
	public object OpenFolder(string folderPath)
	{
		if (string.IsNullOrWhiteSpace(folderPath))
		{
			throw new InvalidOperationException("フォルダが指定されていません。");
		}

		if (!Directory.Exists(folderPath))
		{
			throw new DirectoryNotFoundException($"フォルダが見つかりません。dataDir の設定を確認してください: {folderPath}");
		}

		Process.Start(new ProcessStartInfo
		{
			FileName        = Path.GetFullPath(folderPath),
			UseShellExecute = true,
		});

		return new { ok = true };
	}

	/// <summary>
	/// フォルダ選択ダイアログを表示する
	/// </summary>
	/// <returns>選択結果</returns>
	public PickFolderResult PickFolder()
	{
		using var dialog = new FolderBrowserDialog
		{
			Description            = "貼り付け画像の保存先フォルダを選択してください",
			UseDescriptionForTitle = true,
			ShowNewFolderButton    = true,
		};

		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.SelectedPath))
		{
			return new PickFolderResult
			{
				Canceled = true,
			};
		}

		return new PickFolderResult
		{
			Canceled = false,
			Path     = dialog.SelectedPath,
		};
	}

	/// <summary>
	/// 外部ブラウザで URL を開く
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>実行結果</returns>
	public object OpenExternal(JsonElement paramsElement)
	{
		string url = paramsElement.TryGetProperty("url", out JsonElement urlElement)
			? urlElement.GetString() ?? string.Empty
			: string.Empty;

		if (string.IsNullOrWhiteSpace(url))
		{
			throw new InvalidOperationException("URL が指定されていません。");
		}

		if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)
			|| (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
		{
			throw new InvalidOperationException("サポートされていない URL です。");
		}

		ExternalBrowserSettings settings = _appContext.Config.Settings.ExternalBrowser;
		if (settings.Mode == "custom")
		{
			OpenWithCustomBrowser(settings.CustomCommand, uri);
			return new { ok = true };
		}

		Process.Start(new ProcessStartInfo
		{
			FileName        = uri.ToString(),
			UseShellExecute = true,
		});

		return new { ok = true };
	}

	/// <summary>
	/// カスタムブラウザ設定で URL を開く
	/// </summary>
	/// <param name="commandText">起動コマンド</param>
	/// <param name="uri">URL</param>
	private static void OpenWithCustomBrowser(string commandText, Uri uri)
	{
		ExternalBrowserCommand command = ParseExternalBrowserCommand(commandText);
		ProcessStartInfo startInfo = new()
		{
			FileName        = command.FileName,
			UseShellExecute = false,
		};

		foreach (string argument in command.Arguments)
		{
			startInfo.ArgumentList.Add(argument);
		}
		startInfo.ArgumentList.Add(uri.ToString());

		Process.Start(startInfo);
	}

	/// <summary>
	/// カスタムブラウザ起動コマンドを実行ファイルと引数へ分解する
	/// </summary>
	/// <param name="commandText">起動コマンド</param>
	/// <returns>分解結果</returns>
	/// <exception cref="InvalidOperationException">コマンドが空の場合</exception>
	internal static ExternalBrowserCommand ParseExternalBrowserCommand(string commandText)
	{
		string trimmed = commandText.Trim();
		if (trimmed.Length == 0)
		{
			throw new InvalidOperationException("カスタムブラウザの起動コマンドが指定されていません。");
		}

		string fileName;
		string argumentText;
		if (trimmed[0] == '"')
		{
			int closingQuote = trimmed.IndexOf('"', 1);
			if (closingQuote < 0)
			{
				throw new InvalidOperationException("カスタムブラウザの起動コマンドの引用符が閉じられていません。");
			}

			fileName     = trimmed[1..closingQuote];
			argumentText = trimmed[(closingQuote + 1)..].Trim();
		}
		else
		{
			(fileName, argumentText) = SplitUnquotedBrowserCommand(trimmed);
		}

		if (fileName.Length == 0)
		{
			throw new InvalidOperationException("カスタムブラウザの実行ファイルが指定されていません。");
		}

		return new ExternalBrowserCommand(fileName, SplitCommandArguments(argumentText));
	}

	private static (string FileName, string ArgumentText) SplitUnquotedBrowserCommand(string commandText)
	{
		for (int index = commandText.Length - 1; index >= 0; index--)
		{
			if (!char.IsWhiteSpace(commandText[index]))
			{
				continue;
			}

			string candidate = commandText[..index].Trim();
			if (candidate.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(candidate))
			{
				return (candidate, commandText[(index + 1)..].Trim());
			}
		}

		int firstSpace = commandText.IndexOf(' ');
		return firstSpace < 0
			? (commandText, string.Empty)
			: (commandText[..firstSpace], commandText[(firstSpace + 1)..].Trim());
	}

	private static IReadOnlyList<string> SplitCommandArguments(string argumentText)
	{
		List<string> arguments = [];
		if (string.IsNullOrWhiteSpace(argumentText))
		{
			return arguments;
		}

		bool inQuotes = false;
		var current   = new System.Text.StringBuilder();
		foreach (char ch in argumentText)
		{
			if (ch == '"')
			{
				inQuotes = !inQuotes;
				continue;
			}

			if (char.IsWhiteSpace(ch) && !inQuotes)
			{
				if (current.Length > 0)
				{
					arguments.Add(current.ToString());
					current.Clear();
				}
				continue;
			}

			current.Append(ch);
		}

		if (inQuotes)
		{
			throw new InvalidOperationException("カスタムブラウザの起動コマンドの引用符が閉じられていません。");
		}

		if (current.Length > 0)
		{
			arguments.Add(current.ToString());
		}

		return arguments;
	}
}

internal sealed record ExternalBrowserCommand(string FileName, IReadOnlyList<string> Arguments);
