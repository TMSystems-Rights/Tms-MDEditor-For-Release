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
		// 書き込む Unicode テキスト。プロパティが無い、または null のときは空文字で、クリップボードを空にする
		string text = paramsElement.TryGetProperty(BridgeProperty.Text, out JsonElement textElement)
			? textElement.GetString() ?? string.Empty
			: string.Empty;

		// 空文字のとき。テキストを残さずクリップボードを空にする
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
			// true のとき Unicode テキストだけを返す。mode がオブジェクトとして無く、plain でなければ false。条件が一つでも欠けると false
			bool plain = paramsElement.ValueKind == JsonValueKind.Object
				&& paramsElement.TryGetProperty(BridgeProperty.Mode, out JsonElement modeElement)
				&& string.Equals(modeElement.GetString(), "plain", StringComparison.OrdinalIgnoreCase);

			// プレーン指定のとき。HTML と画像は解釈せず、Unicode テキストを返す
			if (plain)
			{
				// プレーン貼り付けではHTML・画像の解釈を一切行わず、Unicodeテキストを優先する
				return TextResult(ReadText(), "text");
			}

			// ----------------------------------------------
			// HTML・画像・表の貼り付け
			// ---------------------------------------------
			// 既知の形式から読んだ HTML。どれも取れなければ空文字で、表判定は形式名だけに頼る
			string html        = ReadHtml();
			// true なら表計算のクリップボード。同時に載る画像ファイルより表を先に扱う
			bool spreadsheet   = IsSpreadsheetClipboard(html);
			// Excelは画像形式も同時に載せるため、表と判定した場合はファイル貼り付けを先取りしない
			// 表計算ではなく、かつ画像ファイルを取り込めたとき。fileResult はその埋め込み。片方でも欠けると表とテキストへ進む
			if (!spreadsheet && TryPasteImageFiles(out PasteForEditorResult fileResult))
			{
				return fileResult;
			}

			// ----- HTML の表の貼り付け -----
			// HTML に表があるとき。無ければ表計算の代替かテキストへ進む
			if (ClipboardHtmlTableConverter.ContainsTable(html))
			{
				// 表内画像は先に添付先へ保存し、セル内容をローカルWiki埋め込みへ置き換える
				// 失敗理由。null のあいだはセルの置換を続ける。入ったあとは表全体を失敗にする
				string? imageError = null;
				// セル画像を Wiki 埋め込みへ置き換えた Markdown。空なら表としては使わない
				string markdown    = ClipboardHtmlTableConverter.ToMarkdown(html, src =>
				{
					// 先のセルで保存に失敗しているとき。以降のセルは取り込まない
					if (imageError is not null)
					{
						return null;
					}

					// このセルの画像を保存できないとき。markup は null、error は理由。保存できたときは埋め込みを返す
					if (!TrySaveHtmlImage(src, out string? markup, out string? error))
					{
						imageError = error;
						return null;
					}

					return markup;
				});
				// 表内画像の保存に失敗したとき。表の Markdown は返さない
				if (imageError is not null)
				{
					return Fail(imageError);
				}

				// 表の Markdown が 1 文字以上あるとき。空なら次の手段へ進む
				if (markdown.Length > 0)
				{
					return TextResult(markdown, "table");
				}
			}

			// ----- 表計算形式の貼り付け -----
			// 表計算で、かつ HTML 表から Markdown を作れなかったときの代替。sheetResult は TSV か画像の表
			if (spreadsheet && TryPasteSpreadsheetFallback(out PasteForEditorResult sheetResult))
			{
				// HTML表を取得できないExcelデータは、TSVまたは画像から可能な限り表を復元する
				return sheetResult;
			}

			// ----- 特殊形式を処理できなかった場合は、一般テキストを最も安全なフォールバックにする -----
			// Unicode テキスト。空白だけなら画像へ進む
			string text = ReadText();
			// 空白でないテキストがあるとき。表や画像よりこちらを挿入する
			if (!string.IsNullOrWhiteSpace(text))
			{
				return TextResult(text, "text");
			}

			// 添付フォルダを解決できないとき。folder は空、folderError は理由。解決できたときは画像の保存へ進む
			if (!TryResolveAttachmentFolder(out string folder, out string? folderError))
			{
				return Fail(folderError ?? "貼り付け画像の保存先が不正です。");
			}

			// PNG バイトを取れたとき。imageBytes が空なら empty を返す
			if (TryReadClipboardImage(out byte[] imageBytes))
			{
				// 生画像は添付ファイルとして保存し、本文には実体を埋め込まず参照だけを挿入する
				// 上限バイトを超えるとき。MB 単位のメッセージにして保存しない
				if (imageBytes.LongLength > FileService.MaxImageBytes)
				{
					return Fail($"画像サイズが上限（{FileService.MaxImageBytes / (1024 * 1024)}MB）を超えています。");
				}

				// 上限内の PNG。保存したパスは Wiki 埋め込みにする
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
		// クリップボードの生データ。取得できないときは null で、Unicode の HTML テキストへ落ちる
		IDataObject? data = Clipboard.GetDataObject();
		// 生データがあるとき。形式名を自動変換させず、既知の HTML 形式を順に試す
		if (data is not null)
		{
			// Officeやブラウザで形式名が異なるため、自動変換させず既知のHTML形式を順に試す
			foreach (string format in new[] { DataFormats.Html, "HTML Format", "text/html" })
			{
				// その形式が自動変換なしで存在するときだけ読む。無い形式は次へ進む
				if (!data.GetDataPresent(format, autoConvert: false))
				{
					continue;
				}

				// 1 文字以上の HTML を取り出せたとき。空や別の型は次の形式を試す
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
		// 文字列のとき。末尾の NUL を除き、1 文字以上なら成功
		if (raw is string text)
		{
			html = text.TrimEnd('\0');
			return html.Length > 0;
		}

		// ストリームかバイト列で、かつ長さが 1 以上のときだけ復号する。どちらかが欠けると失敗
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
		// 復号を始める位置。バイト。BOM があるときは 3
		int offset = 0;
		// 長さが 3 以上で、かつ先頭が EF BB BF のとき。一つでも欠けると offset は 0 のまま
		if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
		{
			offset = 3;
		}

		// 一部アプリはHTMLをUTF-16LEストリームで渡すため、先頭文字のゼロ交互配置で判定する
		// BOM の後ろに Version の V と e が UTF-16LE で並ぶとき。長さが足りない、または並びが違うと UTF-8 として読む
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
		// 形式名の一覧を取る生データ。無いときは HTML の見た目だけで判定する
		IDataObject? data = Clipboard.GetDataObject();
		// 生データがあるとき。自動変換で増えた形式名は見ない
		if (data is not null)
		{
			foreach (string format in data.GetFormats(autoConvert: false))
			{
				// 表計算の形式名のとき。HTML が空でも true
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
		// まだ中身が無い成功の初期値。画像も表も作れなければこの空のまま false を返す
		result = new PasteForEditorResult
		{
			// true は例外ではない。中身が無いだけの初期値
			Ok = true,
			// empty は未確定。表や画像ができたときに差し替える
			Kind = "empty",
		};
		// まずセル構造を保持しやすいタブ区切りテキストを使う
		// Unicode テキスト。空白だけなら画像の 1 セル表へ進む
		string text = ReadText();
		// 空白でないテキストがあるとき。TSV として表にできるか見る
		if (!string.IsNullOrWhiteSpace(text))
		{
			// タブ区切りから作った表。空なら画像へ進む
			string markdown = ClipboardHtmlTableConverter.TsvToMarkdown(text);
			// 表が 1 文字以上あるとき。結果を表にして true
			if (markdown.Length > 0)
			{
				result = TextResult(markdown, "table");
				return true;
			}
		}

		// テキストがない場合だけ、Excelが提供する表の画像表現を1セル表として残す
		// 画像バイトを取れないとき。表もエラーも作らず false
		if (!TryReadClipboardImage(out byte[] imageBytes))
		{
			return false;
		}

		// 添付フォルダを解決できないとき。エラー結果にして true。folder は空、folderError は理由
		if (!TryResolveAttachmentFolder(out string folder, out string? folderError))
		{
			result = Fail(folderError ?? "貼り付け画像の保存先が不正です。");
			return true;
		}

		// 上限バイトを超えるとき。保存せずエラー結果で true
		if (imageBytes.LongLength > FileService.MaxImageBytes)
		{
			result = Fail($"画像サイズが上限（{FileService.MaxImageBytes / (1024 * 1024)}MB）を超えています。");
			return true;
		}

		// 上限内の表画像。1 セルの表にして返す
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
		// まだ中身が無い成功の初期値。画像が 1 つも無ければこの空のまま false を返す
		result = new PasteForEditorResult
		{
			// true は例外ではない。中身が無いだけの初期値
			Ok = true,
			// empty は未確定。画像をまとめたときに image へ差し替える
			Kind = "empty",
		};
		// ファイルドロップが無いとき。画像ファイルとしては扱わない
		if (!Clipboard.ContainsFileDropList())
		{
			return false;
		}

		// 添付フォルダを解決できないとき。エラー結果で true。folder は空、folderError は理由
		if (!TryResolveAttachmentFolder(out string folder, out string? folderError))
		{
			result = Fail(folderError ?? "貼り付け画像の保存先が不正です。");
			return true;
		}

		// ドロップされたパス一覧。空の要素は無視する
		StringCollection files = Clipboard.GetFileDropList();
		// 保存できた画像の Wiki 埋め込み。0 件なら画像貼り付けではない
		List<string> embeds    = [];
		foreach (string? filePath in files)
		{
			// 複数ファイル中の非画像は無視し、貼り付け可能な画像だけをまとめて処理する
			// パスが空、ファイルが無い、または対応画像でないとき。一つでも欠けるとこのファイルは飛ばす
			if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath) || !FileService.IsSupportedImagePath(filePath))
			{
				continue;
			}

			// そのファイルの全バイト。上限超過なら表や続きのファイルは保存しない
			byte[] bytes = File.ReadAllBytes(filePath);
			// 上限バイトを超えるとき。エラー結果で true
			if (bytes.LongLength > FileService.MaxImageBytes)
			{
				result = Fail($"画像サイズが上限（{FileService.MaxImageBytes / (1024 * 1024)}MB）を超えています。");
				return true;
			}

			// 上限内の画像を添付フォルダへコピーしたパス
			string saved = _appContext.FileService.SaveImageCopy(folder, bytes, Path.GetFileName(filePath));
			embeds.Add(FormatWikiEmbed(saved));
		}

		// 対応画像が 1 つも無かったとき。false で次の貼り付け手段へ譲る
		if (embeds.Count == 0)
		{
			return false;
		}

		// 取り込んだ画像を空白区切りで並べた成功結果
		result = new PasteForEditorResult
		{
			// true は挿入してよい
			Ok   = true,
			// image は Wiki 埋め込みの並び
			Kind = "image",
			// 埋め込みを空白でつないだ本文。0 件ではこの分岐に来ない
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
		// 形式を順に見る生データ。無いときは GDI+ の画像へ落ちる
		IDataObject? data = Clipboard.GetDataObject();
		// 生データがあるとき。PNG ストリームを自動変換させずに先に取る
		if (data is not null)
		{
			// GetImageは透過情報を落とすことがあるため、PNGストリームがあれば先にそのまま取得する
			foreach (string format in new[] { "PNG", "image/png" })
			{
				// その PNG 形式が自動変換なしであるときだけ読む
				if (!data.GetDataPresent(format, autoConvert: false))
				{
					continue;
				}

				// バイトを取り出せ、かつ長さが 1 以上のとき。どちらかが欠けると次の形式を試す
				if (!TryCopyStreamBytes(data.GetData(format), out byte[] pngBytes) || pngBytes.Length == 0)
				{
					continue;
				}

				bytes = pngBytes;
				return true;
			}
		}

		// PNG形式がないアプリ向けに、GDI+画像をPNGへ再エンコードしてフォールバックする
		// ビットマップ画像が無いとき。PNG バイトは空のまま false
		if (!Clipboard.ContainsImage())
		{
			return false;
		}

		// GDI+ の画像。null なら符号化しない
		Image? image = Clipboard.GetImage();
		// 画像を取得できなかったとき
		if (image is null)
		{
			return false;
		}

		using (image)
		// PNG へ符号化する先。使い終わったら閉じる
		using (var stream = new MemoryStream())
		{
			image.Save(stream, ImageFormat.Png);
			bytes = stream.ToArray();
		}

		// 符号化した PNG が 1 バイト以上あるときだけ成功。0 バイトは失敗
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
		// MemoryStream のとき。位置を動かさず配列にする
		if (data is MemoryStream memory)
		{
			bytes = memory.ToArray();
			return true;
		}

		// その他の Stream のとき。現在位置から末尾までコピーする
		if (data is Stream stream)
		{
			// コピー先。元のストリームは閉じない
			using var copy = new MemoryStream();
			stream.CopyTo(copy);
			bytes = copy.ToArray();
			return true;
		}

		// すでにバイト配列のとき。コピーせずそのまま返す。長さ 0 でも true
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
		// 参照が空白のとき。無視して貼り付けを続ける。markup は null
		if (string.IsNullOrWhiteSpace(source))
		{
			return true;
		}

		// 添付フォルダを解決できないとき。error に理由を入れ、表全体を止める
		if (!TryResolveAttachmentFolder(out string folder, out string? folderError))
		{
			error = folderError ?? "貼り付け画像の保存先が不正です。";
			return false;
		}

		try
		{
			// 自己完結data URL、ローカルファイル、リモートURLの順に実体を添付フォルダへ取り込む
			// data URL の画像を復号できたとき。dataBytes は本体、dataName は保存ファイル名
			if (TryReadDataUrlImage(source, out byte[] dataBytes, out string dataName))
			{
				// 添付フォルダへ保存した data URL 画像のパス
				string savedData = _appContext.FileService.SaveImageCopy(folder, dataBytes, dataName);
				markup = FormatWikiEmbed(savedData);
				return true;
			}

			// ローカルパスへ解決できたとき。localPath は絶対パス。file 以外は次の手段へ進む
			if (TryResolveLocalImagePath(source, out string localPath))
			{
				// ファイルが無い、または対応画像でないとき。どちらか一方でもセルは無視して表は続ける
				if (!File.Exists(localPath) || !FileService.IsSupportedImagePath(localPath))
				{
					return true;
				}

				// ローカル画像の全バイト
				byte[] fileBytes = File.ReadAllBytes(localPath);
				// 添付フォルダへコピーしたパス
				string savedFile = _appContext.FileService.SaveImageCopy(folder, fileBytes, Path.GetFileName(localPath));
				markup           = FormatWikiEmbed(savedFile);
				return true;
			}

			// 絶対 URL にできないとき。セルは無視して表は続ける
			if (!Uri.TryCreate(source, UriKind.Absolute, out Uri? uri))
			{
				return true;
			}

			// http または https のとき。それ以外のスキームは取り込まない
			if (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
			{
				// 取得した応答。失敗は catch がリモートだけ元 URL を残す
				using HttpResponseMessage response = ImageHttpClient.GetAsync(uri).GetAwaiter().GetResult();
				response.EnsureSuccessStatusCode();
				// 応答本文のバイト。空でも保存は FileService に任せる
				byte[] remoteBytes = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
				// URL か Content-Type から決めた拡張子。未知なら .png
				string extension   = ExtensionFromImageSource(uri, response);
				// 添付フォルダへ保存したリモート画像のパス
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
			// http で始まる参照のとき。取得に失敗しても元 URL を残し、表全体は続ける
			if (source.StartsWith("http", StringComparison.OrdinalIgnoreCase))
			{
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
		// 絶対 URI で、かつ file スキームのとき。両方揃ったときだけ LocalPath を使う
		if (Uri.TryCreate(source, UriKind.Absolute, out Uri? uri) && uri.IsFile)
		{
			localPath = uri.LocalPath;
			return localPath.Length > 0;
		}

		// file: で始まらないとき。ローカルパスにはしない
		if (!source.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		// file: の後ろ。スラッシュを外してパスにする
		string rest = source[5..];
		while (rest.StartsWith('/'))
		{
			rest = rest[1..];
		}

		rest = Uri.UnescapeDataString(rest.Replace('/', Path.DirectorySeparatorChar));
		// localhost プレフィックスが残っているとき。ドライブ文字の前から外す
		if (rest.StartsWith(@"localhost\", StringComparison.OrdinalIgnoreCase))
		{
			rest = rest["localhost\\".Length..];
		}

		// 2 文字目がドライブ区切りのとき。Windows のローカルパスとして使える
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
		// 保存ファイル名。サブタイプが対応画像なら拡張子を差し替える。既定は png
		fileName = $"Pasted image {DateTime.Now:yyyyMMddHHmmss}.png";
		// data:image/ で始まらないとき。base64 画像としては扱わない
		if (!source.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		// メタデータと本体の区切り。0 未満は data URL として壊れている
		int comma = source.IndexOf(',');
		// カンマが無いとき。本体を取り出せない
		if (comma < 0)
		{
			return false;
		}

		// カンマより前。メディア型と base64 指定
		string meta   = source[..comma];
		// カンマより後ろの本体。base64 でなければ失敗
		string base64 = source[(comma + 1)..];
		// base64 指定が無いとき。URL エンコード画像は扱わない
		if (!meta.Contains("base64", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		bytes = Convert.FromBase64String(base64);
		// メディア型のスラッシュ。0 未満なら拡張子は png のまま
		int slash = meta.IndexOf('/');
		// パラメータの始まり。スラッシュより後ろにあるときだけサブタイプをそこで切る
		int plus  = meta.IndexOf(';');
		// スラッシュがあるとき。サブタイプから拡張子を決める
		if (slash >= 0)
		{
			// image/ の後ろから、セミコロンか末尾まで。jpeg は jpg にする
			string subtype = plus > slash ? meta[(slash + 1)..plus] : meta[(slash + 1)..];
			// ドット付き拡張子。jpeg だけ jpg に揃える
			string ext     = subtype.Equals("jpeg", StringComparison.OrdinalIgnoreCase) ? ".jpg" : $".{subtype}";
			// 対応画像の拡張子のときだけファイル名を差し替える。未知のサブタイプは png のまま
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
		// パスから取った拡張子。クエリは含めない。対応画像ならそれを返す
		string fromPath = Path.GetExtension(uri.AbsolutePath);
		// 対応画像の拡張子のとき。Content-Type は見ない
		if (FileService.IsSupportedImagePath("x" + fromPath))
		{
			return fromPath;
		}

		// Content-Type のメディア型。無いときは null で .png になる
		string? contentType = response.Content.Headers.ContentType?.MediaType;
		return contentType switch
		{
			// JPEG。拡張子は jpg
			"image/jpeg" => ".jpg",
			// GIF
			"image/gif"  => ".gif",
			// WebP
			"image/webp" => ".webp",
			// BMP
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
		// テキストの成功結果。本文が空のときは種別を empty にする
		return new PasteForEditorResult
		{
			// true は挿入してよい。空文字でも成功
			Ok   = true,
			// 空なら empty。1 文字以上なら呼び出し側の text または table
			Kind = text.Length == 0 ? "empty" : kind,
			// 挿入する本文。空でも成功
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
		// 保存済み画像の成功結果。本文は Wiki 埋め込みだけ
		return new PasteForEditorResult
		{
			// true は挿入してよい
			Ok   = true,
			// image は添付ファイルへの参照
			Kind = "image",
			// 保存先パスの Wiki 埋め込み。存在確認はしない
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
		// 挿入しない失敗結果。理由は Error に入れる
		return new PasteForEditorResult
		{
			// false は挿入しない
			Ok    = false,
			// 失敗時の種別は empty
			Kind  = "empty",
			// 本文は空。失敗理由は Error
			Text  = string.Empty,
			// Web 層へ返す失敗理由。空でも Ok は false
			Error = message,
		};
	}
}
