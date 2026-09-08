using System.Collections.Specialized;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// Windows クリップボード操作ブリッジ API
/// </summary>
internal sealed class ClipboardApi
{
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
	/// 画像またはテキストをエディタへ貼り付ける
	/// </summary>
	/// <returns>挿入する Markdown またはテキスト</returns>
	public PasteForEditorResult PasteForEditor()
	{
		try
		{
			if (!AttachmentFolder.TryResolve(_appContext.Config.Settings.AttachmentFolder, out string folder, out string? folderError))
			{
				return Fail(folderError ?? "貼り付け画像の保存先が不正です。");
			}

			if (TryPasteImageFiles(folder, out PasteForEditorResult? fileResult))
			{
				return fileResult;
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

			string text = ReadText();
			if (text.Length == 0)
			{
				return new PasteForEditorResult
				{
					Ok   = true,
					Kind = "empty",
					Text = string.Empty,
				};
			}

			return new PasteForEditorResult
			{
				Ok   = true,
				Kind = "text",
				Text = text,
			};
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

	private bool TryPasteImageFiles(string folder, out PasteForEditorResult result)
	{
		result = new PasteForEditorResult { Ok = true, Kind = "empty" };
		if (!Clipboard.ContainsFileDropList())
		{
			return false;
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
