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
		// 選択表示するパス。プロパティが無い、または null のときは空文字で、例外にする
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		// パスが空、またはファイルが無いとき。どちらか一方でもエクスプローラーは起動しない
		if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath))
		{
			throw new InvalidOperationException("ファイルが見つかりません。");
		}

		// エクスプローラーでそのファイルを選択する起動情報
		Process.Start(new ProcessStartInfo
		{
			// explorer の実行ファイル名
			FileName        = "explorer.exe",
			// /select に絶対パスを渡す。相対パスのままでは選択位置がずれる
			Arguments       = $"/select,\"{Path.GetFullPath(filePath)}\"",
			// true ならシェル経由で explorer を起動する
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
		// パスが空のとき。エクスプローラーは起動しない
		if (string.IsNullOrWhiteSpace(folderPath))
		{
			throw new InvalidOperationException("フォルダが指定されていません。");
		}

		// フォルダが無いとき。起動せず、dataDir の確認を促す
		if (!Directory.Exists(folderPath))
		{
			throw new DirectoryNotFoundException($"フォルダが見つかりません。dataDir の設定を確認してください: {folderPath}");
		}

		// フォルダそのものをエクスプローラーで開く起動情報
		Process.Start(new ProcessStartInfo
		{
			// 開くフォルダの絶対パス。相対のままだとカレントに依存する
			FileName        = Path.GetFullPath(folderPath),
			// true ならフォルダをシェルの既定動作で開く
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
		// 貼り付け画像の保存先を選ぶダイアログ。新規フォルダも作れる
		using var dialog = new FolderBrowserDialog
		{
			// ダイアログ本文。タイトルにも同じ文言を使う
			Description            = "貼り付け画像の保存先フォルダを選択してください",
			// true なら Description をタイトルバーに出す
			UseDescriptionForTitle = true,
			// true ならダイアログ内で新しいフォルダを作れる
			ShowNewFolderButton    = true,
		};

		// キャンセル、またはパスが空のとき。どちらか一方でも Path は空のまま
		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.SelectedPath))
		{
			// 選ばなかった結果。Path は空文字
			return new PickFolderResult
			{
				// true はキャンセル
				Canceled = true,
			};
		}

		// 選ばれたフォルダ。設定への保存は呼び出し側が行う
		return new PickFolderResult
		{
			// false は選択された
			Canceled = false,
			// ダイアログが返したパス。空ではこの分岐に来ない
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
		// 開く URL。プロパティが無い、または null のときは空文字で、例外にする
		string url = paramsElement.TryGetProperty(BridgeProperty.Url, out JsonElement urlElement)
			? urlElement.GetString() ?? string.Empty
			: string.Empty;

		// URL が空のとき。ブラウザは起動しない
		if (string.IsNullOrWhiteSpace(url))
		{
			throw new InvalidOperationException("URL が指定されていません。");
		}

		// 絶対 URL として解釈できない、またはスキームが http でも https でもないとき。どちらか一方でも開かない
		if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)
			|| (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
		{
			throw new InvalidOperationException("サポートされていない URL です。");
		}

		// 設定の開き方。custom のときだけ CustomCommand を使う
		ExternalBrowserSettings settings = _appContext.Config.Settings.ExternalBrowser;
		// カスタムコマンドで開くとき。default では OS の既定に任せる
		if (settings.Mode == "custom")
		{
			OpenWithCustomBrowser(settings.CustomCommand, uri);
			return new { ok = true };
		}

		// OS の既定ブラウザで絶対 URL を開く起動情報
		Process.Start(new ProcessStartInfo
		{
			// 開く絶対 URL。http または https
			FileName        = uri.ToString(),
			// true なら OS の既定アプリで開く
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
		// 実行ファイルと、URL より前の引数。引用符が閉じていなければ例外
		ExternalBrowserCommand command = ParseExternalBrowserCommand(commandText);
		// シェルを介さない起動情報。URL は引数の最後に足す
		ProcessStartInfo startInfo = new()
		{
			// 起動する実行ファイル。空ではここまで来ない
			FileName        = command.FileName,
			// false なら引数をそのまま渡す。true だと URL の解釈がシェルに依存する
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
		// 前後の空白を除いたコマンド。空なら起動しない
		string trimmed = commandText.Trim();
		// 空白だけ、または空のとき。実行ファイルが無いので起動しない
		if (trimmed.Length == 0)
		{
			throw new InvalidOperationException("カスタムブラウザの起動コマンドが指定されていません。");
		}

		// 実行ファイルと、URL より前の引数文字列。引数が無ければ argumentText は空文字
		string fileName;
		string argumentText;
		// 先頭が引用符のとき。閉じ引用符までを実行ファイルにする
		if (trimmed[0] == '"')
		{
			// 閉じ引用符の位置。0 未満は閉じていない
			int closingQuote = trimmed.IndexOf('"', 1);
			// 閉じ引用符が無いとき。分解せず起動しない
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

		// 実行ファイル部分が空のとき。引用符の中が空、または空白だけのとき
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
			// 空白でない位置は区切り候補にしない
			if (!char.IsWhiteSpace(commandText[index]))
			{
				continue;
			}

			// 空白より前。末尾の空白は除く。空なら exe 判定に使わない
			string candidate = commandText[..index].Trim();
			// 実在する exe で終わるときだけ、そこを実行ファイルにする。拡張子か実在のどちらかが欠けると、さらに手前の空白を探す
			if (candidate.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(candidate))
			{
				return (candidate, commandText[(index + 1)..].Trim());
			}
		}

		// 最初の空白。0 未満は引数が無く、コマンド全体が実行ファイル
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
		// 分解した引数。空白だけなら空のまま返す
		List<string> arguments = [];
		// 引数文字列が空白だけのとき。空の一覧を返す
		if (string.IsNullOrWhiteSpace(argumentText))
		{
			return arguments;
		}

		// true のあいだは引用符内。空白では区切らない。閉じずに終わると例外
		bool inQuotes = false;
		// いま組み立てている 1 引数。空白区切りで一覧へ移す
		var current   = new System.Text.StringBuilder();
		foreach (char ch in argumentText)
		{
			// 引用符は引数に含めず、内外を反転する
			if (ch == '"')
			{
				inQuotes = !inQuotes;
				continue;
			}

			// 引用符の外の空白のとき。中の空白は区切りにしない
			if (char.IsWhiteSpace(ch) && !inQuotes)
			{
				// 蓄積があるときだけ 1 引数として確定する。連続空白では空要素を足さない
				if (current.Length > 0)
				{
					arguments.Add(current.ToString());
					current.Clear();
				}
				continue;
			}

			current.Append(ch);
		}

		// 引用符が閉じないまま終わったとき。分解結果は返さない
		if (inQuotes)
		{
			throw new InvalidOperationException("カスタムブラウザの起動コマンドの引用符が閉じられていません。");
		}

		// 末尾に未確定の引数があるとき。最後が空白ならここには入らない
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
