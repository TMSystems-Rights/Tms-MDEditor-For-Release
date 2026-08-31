using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// ファイル関連ブリッジ API
/// </summary>
internal sealed class FileApi
{
	private readonly AppContext _appContext;

	/// <summary>
	/// ファイル API を初期化する
	/// </summary>
	/// <param name="appContext">アプリコンテキスト</param>
	public FileApi(AppContext appContext)
	{
		_appContext = appContext;
	}

	/// <summary>
	/// パス指定でファイルを開く
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>読み込み結果</returns>
	public TextFileInfo Open(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty("filePath", out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		TextFileInfo result = _appContext.FileService.Read(filePath);
		_appContext.FileWatcherService.Track(result.FilePath);
		return result;
	}

	public TextFileInfo OpenWithEncoding(JsonElement paramsElement)
	{
		string filePath = paramsElement.GetProperty("filePath").GetString() ?? string.Empty;
		TextEncodingKind encoding = EncodingDetector.ParseEncodingKind(paramsElement.GetProperty("encoding").GetString());
		TextFileInfo result = _appContext.FileService.Read(filePath, encoding);
		_appContext.FileWatcherService.Track(result.FilePath);
		return result;
	}

	/// <summary>
	/// ファイル選択ダイアログで開く
	/// </summary>
	/// <returns>選択結果</returns>
	public OpenFileDialogResult OpenDialog()
	{
		using var dialog = new OpenFileDialog
		{
			Title  = "ファイルを開く",
			Filter = "Markdown (*.md;*.markdown)|*.md;*.markdown|Text (*.txt)|*.txt|All files (*.*)|*.*",
		};

		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.FileName))
		{
			return new OpenFileDialogResult
			{
				Canceled = true,
			};
		}

		TextFileInfo file = _appContext.FileService.Read(dialog.FileName);
		_appContext.FileWatcherService.Track(file.FilePath);
		return new OpenFileDialogResult
		{
			Canceled = false,
			File     = file,
		};
	}

	/// <summary>
	/// ファイルを保存する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>保存結果</returns>
	public SaveFileResult Save(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty("filePath", out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		if (string.IsNullOrWhiteSpace(filePath))
		{
			throw new InvalidOperationException("filePath が指定されていません。");
		}

		if (!paramsElement.TryGetProperty("text", out JsonElement textElement))
		{
			throw new InvalidOperationException("text が指定されていません。");
		}

		string text = textElement.GetString() ?? string.Empty;

		if (!paramsElement.TryGetProperty("encoding", out JsonElement encodingElement))
		{
			throw new InvalidOperationException("encoding が指定されていません。");
		}

		TextEncodingKind encoding = EncodingDetector.ParseEncodingKind(encodingElement.GetString());

		EolKind? unifyEol = null;
		if (paramsElement.TryGetProperty("unifyEol", out JsonElement unifyEolElement)
			&& unifyEolElement.ValueKind == JsonValueKind.String)
		{
			string? unifyValue = unifyEolElement.GetString();
			if (!string.IsNullOrWhiteSpace(unifyValue))
			{
				unifyEol = EolAnalyzer.ParseEolKind(unifyValue);
			}
		}

		_appContext.FileWatcherService.Track(filePath);
		_appContext.FileWatcherService.SuppressNextChange(filePath);
		return _appContext.FileService.Save(filePath, text, encoding, unifyEol);
	}

	/// <summary>
	/// 画像を Data URL として読み込む
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>読み込み結果</returns>
	public ReadImageResult ReadImageAsDataUrl(JsonElement paramsElement)
	{
		string? path = null;
		string? documentPath = null;
		string? embed = null;

		if (paramsElement.ValueKind != JsonValueKind.Undefined)
		{
			if (paramsElement.TryGetProperty("path", out JsonElement pathElement)
				&& pathElement.ValueKind == JsonValueKind.String)
			{
				path = pathElement.GetString();
			}

			if (paramsElement.TryGetProperty("documentPath", out JsonElement documentPathElement)
				&& documentPathElement.ValueKind == JsonValueKind.String)
			{
				documentPath = documentPathElement.GetString();
			}

			if (paramsElement.TryGetProperty("embed", out JsonElement embedElement)
				&& embedElement.ValueKind == JsonValueKind.String)
			{
				embed = embedElement.GetString();
			}
		}

		return _appContext.FileService.ReadImageAsDataUrl(path, documentPath, embed);
	}

	/// <summary>
	/// 名前を付けて保存ダイアログを表示する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>選択結果</returns>
	public SaveAsDialogResult SaveAsDialog(JsonElement paramsElement)
	{
		string? suggestedPath = null;

		if (paramsElement.ValueKind != JsonValueKind.Undefined
			&& paramsElement.TryGetProperty("filePath", out JsonElement filePathElement))
		{
			suggestedPath = filePathElement.GetString();
		}

		using var dialog = new SaveFileDialog
		{
			Title  = "名前を付けて保存",
			Filter = "Markdown (*.md;*.markdown)|*.md;*.markdown|Text (*.txt)|*.txt|All files (*.*)|*.*",
		};

		if (!string.IsNullOrWhiteSpace(suggestedPath))
		{
			dialog.FileName = Path.GetFileName(suggestedPath);
			string? directory = Path.GetDirectoryName(suggestedPath);
			if (!string.IsNullOrWhiteSpace(directory))
			{
				dialog.InitialDirectory = directory;
			}
		}

		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.FileName))
		{
			return new SaveAsDialogResult { Canceled = true };
		}

		return new SaveAsDialogResult
		{
			Canceled = false,
			FilePath = dialog.FileName,
		};
	}

	/// <summary>
	/// HTML / PDF エクスポート用の保存ダイアログを表示する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>選択結果</returns>
	public SaveAsDialogResult ExportDialog(JsonElement paramsElement)
	{
		string kind = "html";
		string? suggestedName = null;
		string? suggestedPath = null;

		if (paramsElement.ValueKind != JsonValueKind.Undefined)
		{
			if (paramsElement.TryGetProperty("kind", out JsonElement kindElement)
				&& kindElement.ValueKind == JsonValueKind.String)
			{
				kind = kindElement.GetString() ?? "html";
			}

			if (paramsElement.TryGetProperty("suggestedName", out JsonElement nameElement)
				&& nameElement.ValueKind == JsonValueKind.String)
			{
				suggestedName = nameElement.GetString();
			}

			if (paramsElement.TryGetProperty("filePath", out JsonElement filePathElement)
				&& filePathElement.ValueKind == JsonValueKind.String)
			{
				suggestedPath = filePathElement.GetString();
			}
		}

		bool isPdf = string.Equals(kind, "pdf", StringComparison.OrdinalIgnoreCase);
		using var dialog = new SaveFileDialog
		{
			Title            = isPdf ? "PDFとしてエクスポート" : "HTMLとしてエクスポート",
			Filter           = isPdf ? "PDF (*.pdf)|*.pdf|All files (*.*)|*.*" : "HTML (*.html)|*.html|All files (*.*)|*.*",
			DefaultExt       = isPdf ? "pdf" : "html",
			AddExtension     = true,
			OverwritePrompt  = true,
		};

		if (!string.IsNullOrWhiteSpace(suggestedName))
		{
			dialog.FileName = suggestedName;
		}

		if (!string.IsNullOrWhiteSpace(suggestedPath))
		{
			string? directory = Path.GetDirectoryName(suggestedPath);
			if (!string.IsNullOrWhiteSpace(directory))
			{
				dialog.InitialDirectory = directory;
			}

			if (string.IsNullOrWhiteSpace(dialog.FileName))
			{
				string stem = Path.GetFileNameWithoutExtension(suggestedPath);
				dialog.FileName = string.IsNullOrWhiteSpace(stem)
					? (isPdf ? "無題.pdf" : "無題.html")
					: stem + (isPdf ? ".pdf" : ".html");
			}
		}

		if (string.IsNullOrWhiteSpace(dialog.FileName))
		{
			dialog.FileName = isPdf ? "無題.pdf" : "無題.html";
		}

		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.FileName))
		{
			return new SaveAsDialogResult { Canceled = true };
		}

		return new SaveAsDialogResult
		{
			Canceled = false,
			FilePath = dialog.FileName,
		};
	}

	/// <summary>
	/// UTF-8 でテキストを書き込む
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>保存結果</returns>
	public SaveFileResult WriteUtf8(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty("filePath", out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;
		string text = paramsElement.TryGetProperty("text", out JsonElement textElement)
			? textElement.GetString() ?? string.Empty
			: string.Empty;

		if (string.IsNullOrWhiteSpace(filePath))
		{
			throw new InvalidOperationException("filePath が指定されていません。");
		}

		return _appContext.FileService.WriteUtf8(filePath, text);
	}
}
