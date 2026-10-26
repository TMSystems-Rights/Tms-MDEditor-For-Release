// ==============================================
// PDF と印刷の一時文書を作る
// ==============================================

// HTML とコピーした画像だけを一時フォルダへ置く。WebView は開かない
// 呼び出し元が仮想ホストへ割り当て、使い終わったらフォルダを消す

using System.Text;

namespace TmsMdEditor.Services;

/// <summary>
/// PDF または印刷で一時フォルダへ置く 1 枚のローカル画像
/// 名前はフォルダ内のファイル名だけで、コピー元は絶対パス
/// </summary>
internal sealed class PrintMediaFile
{
	/// <summary>
	/// media フォルダへ置くファイル名。ディレクトリ区切りは含まない
	/// </summary>
	public string Name { get; init; } = string.Empty;

	/// <summary>
	/// コピー元の絶対パス。存在と拡張子はコピー時に確認する
	/// </summary>
	public string SourcePath { get; init; } = string.Empty;
}

/// <summary>
/// PDF または印刷へ渡す HTML と、そこから参照するローカル画像
/// </summary>
internal sealed class PrintDocumentRequest
{
	/// <summary>
	/// 一時フォルダの document.html へ書く HTML。画像は media 相対で参照する
	/// </summary>
	public string Html { get; init; } = string.Empty;

	/// <summary>
	/// PDF の保存先。印刷ダイアログでは空でよい
	/// </summary>
	public string FilePath { get; init; } = string.Empty;

	/// <summary>
	/// コピーするローカル画像。無ければ空
	/// </summary>
	public IReadOnlyList<PrintMediaFile> Media { get; init; } = [];
}

/// <summary>
/// 印刷用 HTML と画像を、仮想ホストのルートにできる一時フォルダへ書く
/// 失敗したフォルダは残さず、例外のメッセージを呼び出し元が利用者へ返す
/// </summary>
internal static class PrintDocumentStaging
{
	/// <summary>
	/// 一時フォルダ直下に書く HTML のファイル名。URL はこれを開く
	/// </summary>
	internal const string DocumentFileName = "document.html";

	/// <summary>
	/// 画像を置くサブフォルダ名。HTML の src はこの名前で始まる
	/// </summary>
	internal const string MediaDirectoryName = "media";

	/// <summary>
	/// HTML と画像を新しい一時フォルダへ書く
	/// </summary>
	/// <param name="rootDirectory">一時フォルダの親。無ければ作る</param>
	/// <param name="html">document.html の内容。UTF-8 で書く</param>
	/// <param name="media">コピーする画像。名前の不正、欠落、上限超過は失敗</param>
	/// <returns>document.html を含むフォルダの絶対パス</returns>
	/// <exception cref="InvalidOperationException">画像名またはコピー元が印刷に使えない</exception>
	public static string Create(string rootDirectory, string html, IReadOnlyList<PrintMediaFile> media)
	{
		Directory.CreateDirectory(rootDirectory);
		// 衝突しない一時フォルダ。GUID の N 形式で区切りを含めない
		string directory = Path.Combine(rootDirectory, "tms-mde-print-" + Guid.NewGuid().ToString("N"));
		Directory.CreateDirectory(directory);

		try
		{
			// document.html の絶対パス。仮想ホストはこのファイルを開く
			string documentPath = Path.Combine(directory, DocumentFileName);
			File.WriteAllText(documentPath, html, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

			// 画像が 1 枚でもあるときだけ media を作る。0 件ではフォルダも作らない
			if (media.Count > 0)
			{
				// 画像のコピー先。HTML の src はこの名前で始まる
				string mediaDirectory = Path.Combine(directory, MediaDirectoryName);
				Directory.CreateDirectory(mediaDirectory);
				// このフォルダで使った名前。大文字小文字の違いは重複とみなす
				var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
				foreach (PrintMediaFile file in media)
				{
					CopyMedia(mediaDirectory, file, usedNames);
				}
			}

			return directory;
		}
		catch
		{
			DeleteDirectory(directory);
			throw;
		}
	}

	/// <summary>
	/// フォルダが残っていれば中身ごと消す。使用中で消せないときは例外にせず戻る
	/// </summary>
	/// <param name="directory">消すフォルダ。null や欠落は何もしない</param>
	public static void DeleteDirectory(string? directory)
	{
		// null、空白、または既に無いフォルダは消さない。どちらか一方でも入る
		if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
		{
			return;
		}

		try
		{
			Directory.Delete(directory, recursive: true);
		}
		catch (Exception)
		{
			// 印刷ダイアログがまだファイルを開いていることがある。次回は別フォルダを作るので、ここでの失敗は出力を止めない
		}
	}

	/// <summary>
	/// 1 枚を media フォルダへコピーする。名前はファイル名だけを許し、拡張子はコピー元と揃える
	/// </summary>
	/// <param name="mediaDirectory">コピー先の media フォルダ。存在することは呼び出し側が保証する</param>
	/// <param name="file">コピーする名前と元パス</param>
	/// <param name="usedNames">このフォルダで既に使った名前。大文字小文字は区別しない</param>
	/// <exception cref="InvalidOperationException">名前、拡張子、存在、サイズのいずれかが不正</exception>
	private static void CopyMedia(string mediaDirectory, PrintMediaFile file, HashSet<string> usedNames)
	{
		// 前後の空白を除いたファイル名。空なら安全な名前ではない
		string name = file.Name.Trim();
		// 名前が危険、または大文字小文字を無視して既に使われているとき失敗する。どちらか一方でも入る
		if (!IsSafeFileName(name) || !usedNames.Add(name))
		{
			throw new InvalidOperationException("印刷用の画像名が不正です。");
		}

		// 前後の空白を除いたコピー元。相対ならこのあと拒否する
		string sourcePath = file.SourcePath.Trim();
		// 完全修飾でないパスはコピー元として使わない
		if (!Path.IsPathFullyQualified(sourcePath))
		{
			throw new InvalidOperationException("印刷用の画像が見つかりません。");
		}

		// 正規化した絶対パス。存在しなければコピーしない
		string fullSource = Path.GetFullPath(sourcePath);
		// 実在しない元は見つからない失敗にする
		if (!File.Exists(fullSource))
		{
			throw new InvalidOperationException("印刷用の画像が見つかりません。");
		}

		// コピー元の拡張子。名前側と大文字小文字を無視して揃っている必要がある
		string sourceExtension = Path.GetExtension(fullSource);
		// 対応拡張子であり、かつ名前の拡張子と一致するときだけコピーする。どちらかが欠けても失敗
		if (!FileService.IsSupportedImagePath(fullSource)
			|| !string.Equals(sourceExtension, Path.GetExtension(name), StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("未対応の画像形式です。");
		}

		// サイズ判定用。単位はバイト
		var info = new FileInfo(fullSource);
		// 上限 8MB を超えた画像はコピーしない
		if (info.Length > FileService.MaxImageBytes)
		{
			throw new InvalidOperationException($"画像サイズが上限（{FileService.MaxImageBytes / (1024 * 1024)}MB）を超えています。");
		}

		// media 直下へ置く結合パス。区切りを含む名前は次で拒否する
		string destination = Path.Combine(mediaDirectory, name);
		// 結合後の絶対パス
		string fullDestination = Path.GetFullPath(destination);
		// 比較用の media 絶対パス。末尾区切りは自分で足す
		string fullMedia = Path.GetFullPath(mediaDirectory);
		// media の直下に収まらない名前は拒否する。親へ逃げるパスでは入る
		if (!fullDestination.StartsWith(fullMedia + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
		{
			throw new InvalidOperationException("印刷用の画像名が不正です。");
		}

		File.Copy(fullSource, fullDestination);
	}

	/// <summary>
	/// ファイル名だけかを返す。区切り、上り、予約文字は拒否する
	/// </summary>
	/// <param name="name">検査する名前。trim 済み</param>
	/// <returns>media フォルダへそのまま置ける名前なら true</returns>
	private static bool IsSafeFileName(string name)
	{
		// 空白、またはパス区切りを含む名前はファイル名だけではない。どちらか一方でも拒否する
		if (string.IsNullOrWhiteSpace(name) || name != Path.GetFileName(name))
		{
			return false;
		}

		// 上り、または予約文字を含む名前は置けない。どちらか一方でも拒否する
		if (name.Contains("..", StringComparison.Ordinal) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
		{
			return false;
		}

		return Path.GetFileNameWithoutExtension(name).Length > 0 && Path.GetExtension(name).Length > 1;
	}
}
