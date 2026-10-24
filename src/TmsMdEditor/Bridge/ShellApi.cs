// ==============================================
// ファイルの場所と外部ブラウザを開く
// ==============================================

// ファイルの場所表示、フォルダを開く、フォルダ選択、http と https の起動を行う
// パスや URL が空、または対応外のときは起動せず例外にする

using System.Diagnostics;
using System.Text.Json;
using TmsMdEditor.Models;

namespace TmsMdEditor.Bridge;

/// <summary>
/// shell:* を受けるブリッジ。ブラウザの起動方法は設定の ExternalBrowser を見る
/// </summary>
internal sealed class ShellApi
{
	/// <summary>
	/// 外部ブラウザ設定の参照先。API より長く生きる
	/// </summary>
	private readonly AppContext _appContext;

	/// <summary>
	/// シェル操作 API を作る。コンテキストは借用する
	/// </summary>
	/// <param name="appContext">ExternalBrowser 設定を読むコンテキスト。null は渡さない</param>
	public ShellApi(AppContext appContext)
	{
		_appContext = appContext;
	}

	/// <summary>
	/// エクスプローラーでファイルを選択した状態にする。ファイルが無いときは起動しない
	/// </summary>
	/// <param name="paramsElement">filePath を持つ JSON。無いときは空文字として扱い、例外にする</param>
	/// <returns>起動できたときの ok</returns>
	/// <exception cref="InvalidOperationException">パスが空白、またはファイルが存在しない</exception>
	public object ShowInFolder(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
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
	/// フォルダをエクスプローラーで開く。パスが空、またはフォルダが無いときは開かない
	/// </summary>
	/// <param name="folderPath">開くフォルダのパス。空白は不可</param>
	/// <returns>起動できたときの ok</returns>
	/// <exception cref="InvalidOperationException"><paramref name="folderPath"/> が空白</exception>
	/// <exception cref="DirectoryNotFoundException">フォルダが存在しない</exception>
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
	/// 貼り付け画像の保存先を選ぶフォルダダイアログを出す
	/// キャンセル時は Canceled を true にし、Path は空のまま
	/// </summary>
	/// <returns>キャンセル、または選ばれたフォルダ</returns>
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
	/// http または https を、設定が custom ならそのコマンドで、それ以外は OS の既定で開く
	/// 空やそれ以外のスキームは開かない
	/// </summary>
	/// <param name="paramsElement">url を持つ JSON。無いときは空文字として扱い、例外にする</param>
	/// <returns>起動できたときの ok</returns>
	/// <exception cref="InvalidOperationException">URL が空、スキームが http でも https でもない、またはカスタムコマンドが不正</exception>
	public object OpenExternal(JsonElement paramsElement)
	{
		string url = paramsElement.TryGetProperty(BridgeProperty.Url, out JsonElement urlElement)
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
	/// カスタムブラウザのコマンドへ URL を最後の引数として足して起動する
	/// コマンドが空、または引用符が閉じていないときは起動しない
	/// </summary>
	/// <param name="commandText">実行ファイルと、URL より前の引数。引用符でパスを囲める</param>
	/// <param name="uri">最後に渡す絶対 URL。http または https</param>
	/// <exception cref="InvalidOperationException">コマンドが空、引用符が閉じていない、または実行ファイルが空</exception>
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
	/// <param name="commandText">起動コマンド。前後の空白は無視する。空は不可</param>
	/// <returns>実行ファイルと、URL より前の引数</returns>
	/// <exception cref="InvalidOperationException">コマンドが空、引用符が閉じていない、または実行ファイルが空</exception>
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

	/// <summary>
	/// 引用符で始まらないコマンドを、実在する exe の末尾か最初の空白で実行ファイルと引数へ分ける
	/// 該当する exe が無いときは最初の空白までを実行ファイルにする
	/// </summary>
	/// <param name="commandText">先頭の引用符を外したコマンド。空は渡さない</param>
	/// <returns>実行ファイルと、残りの引数文字列。引数が無ければ空文字</returns>
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

	/// <summary>
	/// 空白区切りの引数を分解する。二重引用符で囲んだ範囲の空白は区切らない
	/// 引用符が閉じていないときは分解しない
	/// </summary>
	/// <param name="argumentText">実行ファイルより後ろの文字列。空白だけなら空の一覧</param>
	/// <returns>個々の引数。引用符自体は含めない</returns>
	/// <exception cref="InvalidOperationException">引用符が閉じていない</exception>
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

/// <summary>
/// カスタムブラウザの起動コマンドを、実行ファイルと引数へ分けた結果
/// URL はこの一覧に含めず、起動時に最後へ足す
/// </summary>
/// <param name="FileName">起動する実行ファイル。空では作らない</param>
/// <param name="Arguments">URL より前に付ける引数。無ければ空の一覧</param>
internal sealed record ExternalBrowserCommand(string FileName, IReadOnlyList<string> Arguments);
