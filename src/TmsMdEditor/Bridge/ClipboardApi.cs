// ==============================================
// クリップボードからエディタへの貼り付け
// ==============================================

// テキスト、表、画像を Markdown に変換し、画像の実体は添付フォルダへ保存する
// 変換に失敗したときは例外にせず、理由を結果の Error で返す

using System.Collections.Specialized;
using System.Drawing;
using System.Drawing.Imaging;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// clipboard:* を受けるブリッジ。画像の取得先は設定の添付フォルダで、プロセスより先には破棄しない
/// </summary>
internal sealed class ClipboardApi
{
	// ==============================================
	// フィールド
	// ==============================================

	/// <summary>
	/// 表内の http 画像を取り込む共有クライアント。タイムアウトは 15 秒
	/// プロセス終了まで使い回し、失敗しても破棄しない
	/// </summary>
	private static readonly HttpClient ImageHttpClient = new()
	{
		Timeout = TimeSpan.FromSeconds(15),
	};

	/// <summary>
	/// 添付フォルダの解決と画像の保存に使う。API より長く生き、ここからは破棄しない
	/// </summary>
	private readonly AppContext _appContext;

	/// <summary>
	/// クリップボード API を作る。コンテキストは借用する
	/// </summary>
	/// <param name="appContext">設定と FileService を持つコンテキスト。null は渡さない</param>
	public ClipboardApi(AppContext appContext)
	{
		_appContext = appContext;
	}

	// ==============================================
	// テキストの読み書き
	// ==============================================

	/// <summary>
	/// Unicode テキストを取得する。テキストが無いときは空文字を返し、例外は出さない
	/// </summary>
	/// <returns>クリップボードの Unicode 文字列。無ければ空文字</returns>
	public string ReadText()
	{
		return Clipboard.ContainsText(TextDataFormat.UnicodeText)
			? Clipboard.GetText(TextDataFormat.UnicodeText)
			: string.Empty;
	}

	/// <summary>
	/// Unicode テキストを書き込む。空文字のときはクリップボードを空にする
	/// </summary>
	/// <param name="paramsElement">text を含むパラメータ。プロパティが無いときは空文字としてクリアする</param>
	/// <returns>書けたときの ok。クリップボードが使えないときの例外はそのまま出る</returns>
	public object WriteText(JsonElement paramsElement)
	{
		string text = paramsElement.TryGetProperty(BridgeProperty.Text, out JsonElement textElement)
			? textElement.GetString() ?? string.Empty
			: string.Empty;

		if (text.Length == 0)
		{
			Clipboard.Clear();
		}
		else
		{
			Clipboard.SetText(text, TextDataFormat.UnicodeText);
		}

		return new { ok = true };
	}

	// ==============================================
	// クリップボードからエディタへの貼り付け
	// ==============================================

	/// <summary>
	/// 画像、表、テキストの順に見て、エディタへ挿入する Markdown を作る
	/// 失敗は例外にせず Ok が false の結果にし、ログへ警告を残す
	/// </summary>
	/// <param name="paramsElement">mode が plain のときは Unicode テキストだけを返す。それ以外は表と画像も解釈する</param>
	/// <returns>挿入する Markdown またはテキスト。Kind は text、table、image、empty のいずれか</returns>
	public PasteForEditorResult PasteForEditor(JsonElement paramsElement)
	{
		try
		{
			// ----------------------------------------------
			// プレーンモードの貼り付け
			// ---------------------------------------------
			bool plain = paramsElement.ValueKind == JsonValueKind.Object
				&& paramsElement.TryGetProperty(BridgeProperty.Mode, out JsonElement modeElement)
				&& string.Equals(modeElement.GetString(), "plain", StringComparison.OrdinalIgnoreCase);

			if (plain)
			{
				// プレーン貼り付けではHTML・画像の解釈を一切行わず、Unicodeテキストを優先する
				return TextResult(ReadText(), "text");
			}

			// ----------------------------------------------
			// HTML・画像・表の貼り付け
			// ---------------------------------------------
			string html        = ReadHtml();
			bool spreadsheet   = IsSpreadsheetClipboard(html);
			// Excelは画像形式も同時に載せるため、表と判定した場合はファイル貼り付けを先取りしない
			if (!spreadsheet && TryPasteImageFiles(out PasteForEditorResult fileResult))
			{
				return fileResult;
			}

			// ----- HTML の表の貼り付け -----
			if (ClipboardHtmlTableConverter.ContainsTable(html))
			{
				// 表内画像は先に添付先へ保存し、セル内容をローカルWiki埋め込みへ置き換える
				string? imageError = null;
				string markdown    = ClipboardHtmlTableConverter.ToMarkdown(html, src =>
				{
					if (imageError is not null)
					{
						return null;
					}

					if (!TrySaveHtmlImage(src, out string? markup, out string? error))
					{
						imageError = error;
						return null;
					}

					return markup;
				});
				if (imageError is not null)
				{
					return Fail(imageError);
				}

				if (markdown.Length > 0)
				{
					return TextResult(markdown, "table");
				}
			}

			// ----- 表計算形式の貼り付け -----
			if (spreadsheet && TryPasteSpreadsheetFallback(out PasteForEditorResult sheetResult))
			{
				// HTML表を取得できないExcelデータは、TSVまたは画像から可能な限り表を復元する
				return sheetResult;
			}

			// ----- 特殊形式を処理できなかった場合は、一般テキストを最も安全なフォールバックにする -----
			string text = ReadText();
			if (!string.IsNullOrWhiteSpace(text))
			{
				return TextResult(text, "text");
			}

			if (!TryResolveAttachmentFolder(out string folder, out string? folderError))
			{
				return Fail(folderError ?? "貼り付け画像の保存先が不正です。");
			}

			if (TryReadClipboardImage(out byte[] imageBytes))
			{
				// 生画像は添付ファイルとして保存し、本文には実体を埋め込まず参照だけを挿入する
				if (imageBytes.LongLength > FileService.MaxImageBytes)
				{
					return Fail($"画像サイズが上限（{FileService.MaxImageBytes / (1024 * 1024)}MB）を超えています。");
				}

				string saved = _appContext.FileService.SaveImageCopy(
					folder,
					imageBytes,
					$"Pasted image {DateTime.Now:yyyyMMddHHmmss}.png");
				return ImageResult(saved);
			}

			return TextResult(string.Empty, "empty");
		}
		catch (Exception ex)
		{
			_appContext.Logger.Warn(LogCategory.Clipboard, "クリップボード貼り付けに失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Error] = ex.Message,
			});
			return Fail(ex.Message);
		}
	}

	// ==============================================
	// HTML と表
	// ==============================================

	/// <summary>
	/// クリップボード上の HTML を、知っている形式名の順に読む
	/// どれも取れないときは空文字を返し、例外は出さない
	/// </summary>
	/// <returns>HTML 文字列。無ければ空文字</returns>
	private static string ReadHtml()
	{
		IDataObject? data = Clipboard.GetDataObject();
		if (data is not null)
		{
			// Officeやブラウザで形式名が異なるため、自動変換させず既知のHTML形式を順に試す
			foreach (string format in new[] { DataFormats.Html, "HTML Format", "text/html" })
			{
				if (!data.GetDataPresent(format, autoConvert: false))
				{
					continue;
				}

				if (TryReadHtmlPayload(data.GetData(format), out string html) && html.Length > 0)
				{
					return html;
				}
			}
		}

		return Clipboard.ContainsText(TextDataFormat.Html)
			? Clipboard.GetText(TextDataFormat.Html)
			: string.Empty;
	}

	/// <summary>
	/// HTML のペイロードを文字列かバイト列から取り出す
	/// どちらでもなければ false にし、html は空のまま
	/// </summary>
	/// <param name="raw">クリップボードから得た値。null、文字列、ストリーム、バイト列を受け付ける</param>
	/// <param name="html">取り出した HTML。失敗時は空文字</param>
	/// <returns>1 文字以上取り出せたとき true</returns>
	private static bool TryReadHtmlPayload(object? raw, out string html)
	{
		html = string.Empty;
		if (raw is string text)
		{
			html = text.TrimEnd('\0');
			return html.Length > 0;
		}

		if (!TryCopyStreamBytes(raw, out byte[] bytes) || bytes.Length == 0)
		{
			return false;
		}

		html = DecodeClipboardHtmlBytes(bytes);
		return html.Length > 0;
	}

	/// <summary>
	/// クリップボードの HTML バイト列を文字列にする。BOM と、先頭が UTF-16LE の Version ヘッダを見分ける
	/// 不正な UTF-8 は置換文字にして返し、例外は出さない
	/// </summary>
	/// <param name="bytes">形式の生バイト。空でも空文字を返す</param>
	/// <returns>末尾の NUL を除いた HTML</returns>
	private static string DecodeClipboardHtmlBytes(byte[] bytes)
	{
		int offset = 0;
		if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
		{
			offset = 3;
		}

		// 一部アプリはHTMLをUTF-16LEストリームで渡すため、先頭文字のゼロ交互配置で判定する
		if (offset + 3 < bytes.Length
			&& bytes[offset] == (byte)'V'
			&& bytes[offset + 1] == 0
			&& bytes[offset + 2] == (byte)'e'
			&& bytes[offset + 3] == 0)
		{
			return Encoding.Unicode.GetString(bytes, offset, bytes.Length - offset).TrimEnd('\0');
		}

		return Encoding.UTF8.GetString(bytes, offset, bytes.Length - offset).TrimEnd('\0');
	}

	/// <summary>
	/// Excel など表計算の形式、または Excel 由来の HTML なら true
	/// 表と同時に載る画像ファイルを、表より先に貼り付けないために使う
	/// </summary>
	/// <param name="html">既に読んだ HTML。空でも形式名だけで判定できる</param>
	/// <returns>表計算のクリップボードなら true</returns>
	private static bool IsSpreadsheetClipboard(string html)
	{
		IDataObject? data = Clipboard.GetDataObject();
		if (data is not null)
		{
			foreach (string format in data.GetFormats(autoConvert: false))
			{
				if (IsSpreadsheetFormat(format))
				{
					return true;
				}
			}
		}

		return ClipboardHtmlTableConverter.LooksLikeExcelHtml(html);
	}

	/// <summary>
	/// 形式名が XML Spreadsheet、Biff、Csv のいずれかなら true。大文字小文字は区別しない
	/// </summary>
	/// <param name="format">クリップボードの形式名。空なら false</param>
	/// <returns>表計算の形式名なら true</returns>
	private static bool IsSpreadsheetFormat(string format)
	{
		return format.Equals("XML Spreadsheet", StringComparison.OrdinalIgnoreCase)
			|| format.Equals("Biff12", StringComparison.OrdinalIgnoreCase)
			|| format.Equals("Biff8", StringComparison.OrdinalIgnoreCase)
			|| format.Equals("Biff5", StringComparison.OrdinalIgnoreCase)
			|| format.Equals("Biff4", StringComparison.OrdinalIgnoreCase)
			|| format.Equals("Biff3", StringComparison.OrdinalIgnoreCase)
			|| format.Equals("Csv", StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// HTML の表が取れない表計算データを、タブ区切りテキストか画像から表にする
	/// 何も作れないときは false。保存先やサイズの問題は result に入れて true
	/// </summary>
	/// <param name="result">成功時の表、または失敗理由。false のときの中身は空の成功</param>
	/// <returns>表かエラーを結果に入れたとき true</returns>
	private bool TryPasteSpreadsheetFallback(out PasteForEditorResult result)
	{
		result = new PasteForEditorResult { Ok = true, Kind = "empty" };
		// まずセル構造を保持しやすいタブ区切りテキストを使う
		string text = ReadText();
		if (!string.IsNullOrWhiteSpace(text))
		{
			string markdown = ClipboardHtmlTableConverter.TsvToMarkdown(text);
			if (markdown.Length > 0)
			{
				result = TextResult(markdown, "table");
				return true;
			}
		}

		// テキストがない場合だけ、Excelが提供する表の画像表現を1セル表として残す
		if (!TryReadClipboardImage(out byte[] imageBytes))
		{
			return false;
		}

		if (!TryResolveAttachmentFolder(out string folder, out string? folderError))
		{
			result = Fail(folderError ?? "貼り付け画像の保存先が不正です。");
			return true;
		}

		if (imageBytes.LongLength > FileService.MaxImageBytes)
		{
			result = Fail($"画像サイズが上限（{FileService.MaxImageBytes / (1024 * 1024)}MB）を超えています。");
			return true;
		}

		string saved = _appContext.FileService.SaveImageCopy(
			folder,
			imageBytes,
			$"Pasted image {DateTime.Now:yyyyMMddHHmmss}.png");
		result = TextResult(ClipboardHtmlTableConverter.SingleCellTable(FormatWikiEmbed(saved)), "table");
		return true;
	}

	/// <summary>
	/// 設定の添付フォルダを、保存に使える絶対パスへ解決する
	/// 設定が空なら既定フォルダ。解決できないときは false と理由を返す
	/// </summary>
	/// <param name="folder">解決したフォルダ。失敗時は空</param>
	/// <param name="error">失敗理由。成功時は null</param>
	/// <returns>フォルダを使ってよいとき true</returns>
	private bool TryResolveAttachmentFolder(out string folder, out string? error)
	{
		return AttachmentFolder.TryResolve(_appContext.Config.Settings.AttachmentFolder, out folder, out error);
	}

	// ==============================================
	// 画像の取り込み
	// ==============================================

	/// <summary>
	/// ファイルドロップのうち対応する画像だけを添付フォルダへコピーし、Wiki 埋め込みにする
	/// 画像が 1 つも無ければ false。サイズ超過はエラー結果で true
	/// </summary>
	/// <param name="result">画像の埋め込み、または失敗理由。false のときは空の成功のまま</param>
	/// <returns>埋め込みかエラーを結果に入れたとき true</returns>
	private bool TryPasteImageFiles(out PasteForEditorResult result)
	{
		result = new PasteForEditorResult { Ok = true, Kind = "empty" };
		if (!Clipboard.ContainsFileDropList())
		{
			return false;
		}

		if (!TryResolveAttachmentFolder(out string folder, out string? folderError))
		{
			result = Fail(folderError ?? "貼り付け画像の保存先が不正です。");
			return true;
		}

		StringCollection files = Clipboard.GetFileDropList();
		List<string> embeds    = [];
		foreach (string? filePath in files)
		{
			// 複数ファイル中の非画像は無視し、貼り付け可能な画像だけをまとめて処理する
			if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath) || !FileService.IsSupportedImagePath(filePath))
			{
				continue;
			}

			byte[] bytes = File.ReadAllBytes(filePath);
			if (bytes.LongLength > FileService.MaxImageBytes)
			{
				result = Fail($"画像サイズが上限（{FileService.MaxImageBytes / (1024 * 1024)}MB）を超えています。");
				return true;
			}

			string saved = _appContext.FileService.SaveImageCopy(folder, bytes, Path.GetFileName(filePath));
			embeds.Add(FormatWikiEmbed(saved));
		}

		if (embeds.Count == 0)
		{
			return false;
		}

		result = new PasteForEditorResult
		{
			Ok   = true,
			Kind = "image",
			Text = string.Join(" ", embeds),
		};
		return true;
	}

	/// <summary>
	/// クリップボードの画像を PNG バイトで取る。PNG 形式が無いときは GDI+ 画像を PNG に符号化する
	/// 画像が無いときは false
	/// </summary>
	/// <param name="bytes">PNG バイト。失敗時は空</param>
	/// <returns>1 バイト以上取れたとき true</returns>
	private static bool TryReadClipboardImage(out byte[] bytes)
	{
		bytes = [];
		IDataObject? data = Clipboard.GetDataObject();
		if (data is not null)
		{
			// GetImageは透過情報を落とすことがあるため、PNGストリームがあれば先にそのまま取得する
			foreach (string format in new[] { "PNG", "image/png" })
			{
				if (!data.GetDataPresent(format, autoConvert: false))
				{
					continue;
				}

				if (!TryCopyStreamBytes(data.GetData(format), out byte[] pngBytes) || pngBytes.Length == 0)
				{
					continue;
				}

				bytes = pngBytes;
				return true;
			}
		}

		// PNG形式がないアプリ向けに、GDI+画像をPNGへ再エンコードしてフォールバックする
		if (!Clipboard.ContainsImage())
		{
			return false;
		}

		Image? image = Clipboard.GetImage();
		if (image is null)
		{
			return false;
		}

		using (image)
		using (var stream = new MemoryStream())
		{
			image.Save(stream, ImageFormat.Png);
			bytes = stream.ToArray();
		}

		return bytes.Length > 0;
	}

	/// <summary>
	/// MemoryStream、Stream、バイト列のいずれかを配列へコピーする
	/// それ以外の型は false。Stream は現在位置から末尾まで読む
	/// </summary>
	/// <param name="data">クリップボードの値。null は false</param>
	/// <param name="bytes">コピーしたバイト。失敗時は空</param>
	/// <returns>バイトを取り出せたとき true。長さ 0 でも配列なら true</returns>
	private static bool TryCopyStreamBytes(object? data, out byte[] bytes)
	{
		bytes = [];
		if (data is MemoryStream memory)
		{
			bytes = memory.ToArray();
			return true;
		}

		if (data is Stream stream)
		{
			using var copy = new MemoryStream();
			stream.CopyTo(copy);
			bytes = copy.ToArray();
			return true;
		}

		if (data is byte[] raw)
		{
			bytes = raw;
			return true;
		}

		return false;
	}

	/// <summary>
	/// 表セルの画像参照を添付フォルダへ保存し、Wiki 埋め込みを返す
	/// 空の参照は無視して true。リモートの取得失敗は元の URL を残して true。それ以外の失敗は false
	/// </summary>
	/// <param name="source">data URL、ローカルパス、file URL、http URL。空白は無視する</param>
	/// <param name="markup">挿入する埋め込み。無視したときは null</param>
	/// <param name="error">失敗理由。成功時は null</param>
	/// <returns>貼り付けを続けてよいとき true</returns>
	private bool TrySaveHtmlImage(string source, out string? markup, out string? error)
	{
		markup = null;
		error  = null;
		if (string.IsNullOrWhiteSpace(source))
		{
			return true;
		}

		if (!TryResolveAttachmentFolder(out string folder, out string? folderError))
		{
			error = folderError ?? "貼り付け画像の保存先が不正です。";
			return false;
		}

		try
		{
			// 自己完結data URL、ローカルファイル、リモートURLの順に実体を添付フォルダへ取り込む
			if (TryReadDataUrlImage(source, out byte[] dataBytes, out string dataName))
			{
				string savedData = _appContext.FileService.SaveImageCopy(folder, dataBytes, dataName);
				markup = FormatWikiEmbed(savedData);
				return true;
			}

			if (TryResolveLocalImagePath(source, out string localPath))
			{
				if (!File.Exists(localPath) || !FileService.IsSupportedImagePath(localPath))
				{
					return true;
				}

				byte[] fileBytes = File.ReadAllBytes(localPath);
				string savedFile = _appContext.FileService.SaveImageCopy(folder, fileBytes, Path.GetFileName(localPath));
				markup           = FormatWikiEmbed(savedFile);
				return true;
			}

			if (!Uri.TryCreate(source, UriKind.Absolute, out Uri? uri))
			{
				return true;
			}

			if (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
			{
				using HttpResponseMessage response = ImageHttpClient.GetAsync(uri).GetAwaiter().GetResult();
				response.EnsureSuccessStatusCode();
				byte[] remoteBytes = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
				string extension   = ExtensionFromImageSource(uri, response);
				string savedRemote = _appContext.FileService.SaveImageCopy(
					folder,
					remoteBytes,
					$"Pasted image {DateTime.Now:yyyyMMddHHmmss}{extension}");
				markup = FormatWikiEmbed(savedRemote);
				return true;
			}
		}
		catch (Exception ex)
		{
			_appContext.Logger.Warn(LogCategory.Clipboard, "表内画像の保存に失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Error] = ex.Message,
			});
			if (source.StartsWith("http", StringComparison.OrdinalIgnoreCase))
			{
				// リモート画像だけは取得失敗時も元URL参照を残し、表全体の貼り付けを継続する
				markup = $"![]({source})";
				return true;
			}

			error = ex.Message;
			return false;
		}

		return true;
	}

	/// <summary>
	/// file URL、または file: で始まる参照をローカルパスにする
	/// ドライブ文字まで取れないときは false
	/// </summary>
	/// <param name="source">画像の参照。file 以外は false</param>
	/// <param name="localPath">解決したパス。失敗時は空</param>
	/// <returns>ローカルパスとして使えるとき true</returns>
	private static bool TryResolveLocalImagePath(string source, out string localPath)
	{
		localPath = string.Empty;
		if (Uri.TryCreate(source, UriKind.Absolute, out Uri? uri) && uri.IsFile)
		{
			localPath = uri.LocalPath;
			return localPath.Length > 0;
		}

		if (!source.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		string rest = source[5..];
		while (rest.StartsWith('/'))
		{
			rest = rest[1..];
		}

		rest = Uri.UnescapeDataString(rest.Replace('/', Path.DirectorySeparatorChar));
		if (rest.StartsWith(@"localhost\", StringComparison.OrdinalIgnoreCase))
		{
			rest = rest["localhost\\".Length..];
		}

		if (rest.Length >= 2 && rest[1] == ':')
		{
			localPath = rest;
			return true;
		}

		return false;
	}

	/// <summary>
	/// data:image の base64 をバイトと保存ファイル名にする。base64 以外は false
	/// 壊れた base64 は例外になる。呼び出し側が捕捉する
	/// </summary>
	/// <param name="source">data URL。image 以外は false</param>
	/// <param name="bytes">復号した画像。失敗時は空</param>
	/// <param name="fileName">保存時のファイル名。拡張子はサブタイプから決める</param>
	/// <returns>1 バイト以上あるとき true</returns>
	/// <exception cref="FormatException">base64 が壊れている</exception>
	private static bool TryReadDataUrlImage(string source, out byte[] bytes, out string fileName)
	{
		bytes    = [];
		fileName = $"Pasted image {DateTime.Now:yyyyMMddHHmmss}.png";
		if (!source.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		int comma = source.IndexOf(',');
		if (comma < 0)
		{
			return false;
		}

		string meta   = source[..comma];
		string base64 = source[(comma + 1)..];
		if (!meta.Contains("base64", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		bytes = Convert.FromBase64String(base64);
		int slash = meta.IndexOf('/');
		int plus  = meta.IndexOf(';');
		if (slash >= 0)
		{
			string subtype = plus > slash ? meta[(slash + 1)..plus] : meta[(slash + 1)..];
			string ext     = subtype.Equals("jpeg", StringComparison.OrdinalIgnoreCase) ? ".jpg" : $".{subtype}";
			if (FileService.IsSupportedImagePath("x" + ext))
			{
				fileName = $"Pasted image {DateTime.Now:yyyyMMddHHmmss}{ext}";
			}
		}

		return bytes.Length > 0;
	}

	/// <summary>
	/// リモート画像の拡張子を、URL の拡張子、無ければ Content-Type から決める
	/// どちらも未知なら .png
	/// </summary>
	/// <param name="uri">取得した画像の URL。クエリは拡張子の判定に使わない</param>
	/// <param name="response">成功した応答。Content-Type が無くても .png を返す</param>
	/// <returns>ドット付きの拡張子</returns>
	private static string ExtensionFromImageSource(Uri uri, HttpResponseMessage response)
	{
		// URL拡張子を優先し、動的URLの場合だけContent-Typeから安全な既知拡張子を選ぶ
		string fromPath = Path.GetExtension(uri.AbsolutePath);
		if (FileService.IsSupportedImagePath("x" + fromPath))
		{
			return fromPath;
		}

		string? contentType = response.Content.Headers.ContentType?.MediaType;
		return contentType switch
		{
			"image/jpeg" => ".jpg",
			"image/gif"  => ".gif",
			"image/webp" => ".webp",
			"image/bmp"  => ".bmp",
			_            => ".png",
		};
	}

	// ----------------------------------------------
	// 結果の組み立て
	// ----------------------------------------------

	/// <summary>
	/// テキストの成功結果を作る。本文が空のときは Kind を empty にする
	/// </summary>
	/// <param name="text">挿入する文字列。空でも成功</param>
	/// <param name="kind">空でないときの種別。text または table</param>
	/// <returns>Ok が true の結果</returns>
	private static PasteForEditorResult TextResult(string text, string kind)
	{
		return new PasteForEditorResult
		{
			Ok   = true,
			Kind = text.Length == 0 ? "empty" : kind,
			Text = text,
		};
	}

	/// <summary>
	/// 保存済み画像のパスを Wiki 埋め込みにした成功結果を作る
	/// </summary>
	/// <param name="savedPath">添付フォルダへ保存したパス。検証はしない</param>
	/// <returns>Kind が image の結果</returns>
	private static PasteForEditorResult ImageResult(string savedPath)
	{
		return new PasteForEditorResult
		{
			Ok   = true,
			Kind = "image",
			Text = FormatWikiEmbed(savedPath),
		};
	}

	/// <summary>
	/// 保存先パスを Wiki の埋め込み記法にする。パスの存在は見ない
	/// </summary>
	/// <param name="savedPath">埋め込むパス。空でも記法だけは作る</param>
	/// <returns>![[パス]] の文字列</returns>
	private static string FormatWikiEmbed(string savedPath)
	{
		return $"![[{savedPath}]]";
	}

	/// <summary>
	/// 貼り付け失敗の結果を作る。本文は空にし、理由は Error に入れる
	/// </summary>
	/// <param name="message">Web 層へ返す失敗理由。空でも Ok は false</param>
	/// <returns>Kind が empty の失敗結果</returns>
	private static PasteForEditorResult Fail(string message)
	{
		return new PasteForEditorResult
		{
			Ok    = false,
			Kind  = "empty",
			Text  = string.Empty,
			Error = message,
		};
	}
}
