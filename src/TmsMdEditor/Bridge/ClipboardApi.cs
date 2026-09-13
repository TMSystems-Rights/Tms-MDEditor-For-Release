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
/// Windows クリップボード操作ブリッジ API
/// </summary>
internal sealed class ClipboardApi
{
	private static readonly HttpClient ImageHttpClient = new()
	{
		Timeout = TimeSpan.FromSeconds(15),
	};

	private readonly AppContext _appContext;

	/// <summary>
	/// クリップボード API を初期化する
	/// </summary>
	/// <param name="appContext">アプリコンテキスト</param>
	public ClipboardApi(AppContext appContext)
	{
		_appContext = appContext;
	}

	/// <summary>
	/// Unicode テキストを取得する
	/// </summary>
	/// <returns>クリップボード文字列</returns>
	public string ReadText()
	{
		return Clipboard.ContainsText(TextDataFormat.UnicodeText)
			? Clipboard.GetText(TextDataFormat.UnicodeText)
			: string.Empty;
	}

	/// <summary>
	/// Unicode テキストを書き込む
	/// </summary>
	/// <param name="paramsElement">text を含むパラメータ</param>
	/// <returns>処理結果</returns>
	public object WriteText(JsonElement paramsElement)
	{
		string text = paramsElement.TryGetProperty("text", out JsonElement textElement)
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

	/// <summary>
	/// 画像・表・テキストをエディタへ貼り付ける
	/// </summary>
	/// <param name="paramsElement">mode=plain でプレーンテキスト</param>
	/// <returns>挿入する Markdown またはテキスト</returns>
	public PasteForEditorResult PasteForEditor(JsonElement paramsElement)
	{
		try
		{
			bool plain = paramsElement.ValueKind == JsonValueKind.Object
				&& paramsElement.TryGetProperty("mode", out JsonElement modeElement)
				&& string.Equals(modeElement.GetString(), "plain", StringComparison.OrdinalIgnoreCase);

			if (plain)
			{
				return TextResult(ReadText(), "text");
			}

			string html        = ReadHtml();
			bool spreadsheet   = IsSpreadsheetClipboard(html);
			if (!spreadsheet && TryPasteImageFiles(out PasteForEditorResult fileResult))
			{
				return fileResult;
			}

			if (ClipboardHtmlTableConverter.ContainsTable(html))
			{
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

			if (spreadsheet && TryPasteSpreadsheetFallback(out PasteForEditorResult sheetResult))
			{
				return sheetResult;
			}

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
			_appContext.Logger.Warn("clipboard", "クリップボード貼り付けに失敗しました", new Dictionary<string, object?>
			{
				["error"] = ex.Message,
			});
			return Fail(ex.Message);
		}
	}

	private static string ReadHtml()
	{
		IDataObject? data = Clipboard.GetDataObject();
		if (data is not null)
		{
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

	private static string DecodeClipboardHtmlBytes(byte[] bytes)
	{
		int offset = 0;
		if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
		{
			offset = 3;
		}

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

	private bool TryPasteSpreadsheetFallback(out PasteForEditorResult result)
	{
		result = new PasteForEditorResult { Ok = true, Kind = "empty" };
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

	private bool TryResolveAttachmentFolder(out string folder, out string? error)
	{
		return AttachmentFolder.TryResolve(_appContext.Config.Settings.AttachmentFolder, out folder, out error);
	}

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

	private static bool TryReadClipboardImage(out byte[] bytes)
	{
		bytes = [];
		IDataObject? data = Clipboard.GetDataObject();
		if (data is not null)
		{
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
			_appContext.Logger.Warn("clipboard", "表内画像の保存に失敗しました", new Dictionary<string, object?>
			{
				["error"] = ex.Message,
			});
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

	private static string ExtensionFromImageSource(Uri uri, HttpResponseMessage response)
	{
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

	private static PasteForEditorResult TextResult(string text, string kind)
	{
		return new PasteForEditorResult
		{
			Ok   = true,
			Kind = text.Length == 0 ? "empty" : kind,
			Text = text,
		};
	}

	private static PasteForEditorResult ImageResult(string savedPath)
	{
		return new PasteForEditorResult
		{
			Ok   = true,
			Kind = "image",
			Text = FormatWikiEmbed(savedPath),
		};
	}

	private static string FormatWikiEmbed(string savedPath)
	{
		return $"![[{savedPath}]]";
	}

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
