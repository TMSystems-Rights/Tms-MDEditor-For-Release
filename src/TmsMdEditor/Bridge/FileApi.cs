// ==============================================
// ファイルの読み書きとダイアログ
// ==============================================

// パス指定の読み込みは監視対象へ加え、保存の直前だけ外部変更通知を抑止する
// 必須項目が無い保存は例外にし、ダイアログのキャンセルは例外にしない

using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// file:* を受けるブリッジ。ダイアログはシェルの UI スレッドで表示する
/// </summary>
internal sealed class FileApi
{
	/// <summary>
	/// ファイル読み書きと監視の参照先。API より長く生きる
	/// </summary>
	private readonly AppContext _appContext;

	/// <summary>
	/// ファイル API を作る。コンテキストは借用する
	/// </summary>
	/// <param name="appContext">FileService と FileWatcherService を持つコンテキスト。null は渡さない</param>
	public FileApi(AppContext appContext)
	{
		_appContext = appContext;
	}

	/// <summary>
	/// パスのテキストを文字コード自動判定で読み、その絶対パスを監視対象に加える
	/// ファイルが無い、またはパスが不正なときは FileService の例外がそのまま出る
	/// </summary>
	/// <param name="paramsElement">filePath を持つ JSON。無いときは空文字として読みにいく</param>
	/// <returns>本文、判定した文字コード、改行、バイト数</returns>
	public TextFileInfo Open(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		TextFileInfo result = _appContext.FileService.Read(filePath);
		_appContext.FileWatcherService.Track(result.FilePath);
		return result;
	}

	/// <summary>
	/// 指定した文字コードでテキストを読み、その絶対パスを監視対象に加える
	/// filePath か encoding が無いとき、または文字コード名が未対応のときは例外になる
	/// </summary>
	/// <param name="paramsElement">filePath と encoding を持つオブジェクト。両方必須</param>
	/// <returns>指定した文字コードで復号した本文と、改行の内訳</returns>
	/// <exception cref="KeyNotFoundException">filePath または encoding が無い</exception>
	/// <exception cref="InvalidOperationException">encoding の名前が未対応</exception>
	public TextFileInfo OpenWithEncoding(JsonElement paramsElement)
	{
		string filePath = paramsElement.GetProperty(BridgeProperty.FilePath).GetString() ?? string.Empty;
		TextEncodingKind encoding = EncodingDetector.ParseEncodingKind(paramsElement.GetProperty(BridgeProperty.Encoding).GetString());
		TextFileInfo result = _appContext.FileService.Read(filePath, encoding);
		_appContext.FileWatcherService.Track(result.FilePath);
		return result;
	}

	/// <summary>
	/// ファイル選択ダイアログを出し、選ばれたテキストを自動判定で読む
	/// キャンセル時はファイルを読まず Canceled を true にする
	/// </summary>
	/// <returns>キャンセル、または読み込んだファイル。読み込み失敗は例外のまま出す</returns>
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
	/// 本文を指定の文字コードと改行で保存する。保存通知を外部変更として再読込しないよう、書く直前に抑止する
	/// 必須項目が無いときは保存しない
	/// </summary>
	/// <param name="paramsElement">filePath、text、encoding が必須。unifyEol が空のときは既存の改行を維持する</param>
	/// <returns>保存したパスと、採用した文字コード、改行</returns>
	/// <exception cref="InvalidOperationException">filePath、text、encoding が無い、文字コードが未対応、または unifyEol が未対応</exception>
	public SaveFileResult Save(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		if (string.IsNullOrWhiteSpace(filePath))
		{
			throw new InvalidOperationException("filePath が指定されていません。");
		}

		if (!paramsElement.TryGetProperty(BridgeProperty.Text, out JsonElement textElement))
		{
			throw new InvalidOperationException("text が指定されていません。");
		}

		string text = textElement.GetString() ?? string.Empty;

		if (!paramsElement.TryGetProperty(BridgeProperty.Encoding, out JsonElement encodingElement))
		{
			throw new InvalidOperationException("encoding が指定されていません。");
		}

		TextEncodingKind encoding = EncodingDetector.ParseEncodingKind(encodingElement.GetString());

		EolKind? unifyEol = null;
		if (paramsElement.TryGetProperty(BridgeProperty.UnifyEol, out JsonElement unifyEolElement)
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
	/// ローカル画像か埋め込み画像を Data URL として返す。失敗は例外にせず結果の Error に入れる
	/// </summary>
	/// <param name="paramsElement">path、documentPath、embed のいずれか。未指定のオブジェクトでも読みにいく</param>
	/// <returns>成功時は Data URL。失敗時は Ok が false</returns>
	public ReadImageResult ReadImageAsDataUrl(JsonElement paramsElement)
	{
		string? path = null;
		string? documentPath = null;
		string? embed = null;

		if (paramsElement.ValueKind != JsonValueKind.Undefined)
		{
			if (paramsElement.TryGetProperty(BridgeProperty.Path, out JsonElement pathElement)
				&& pathElement.ValueKind == JsonValueKind.String)
			{
				path = pathElement.GetString();
			}

			if (paramsElement.TryGetProperty(BridgeProperty.DocumentPath, out JsonElement documentPathElement)
				&& documentPathElement.ValueKind == JsonValueKind.String)
			{
				documentPath = documentPathElement.GetString();
			}

			if (paramsElement.TryGetProperty(BridgeProperty.Embed, out JsonElement embedElement)
				&& embedElement.ValueKind == JsonValueKind.String)
			{
				embed = embedElement.GetString();
			}
		}

		return _appContext.FileService.ReadImageAsDataUrl(path, documentPath, embed);
	}

	/// <summary>
	/// 名前を付けて保存ダイアログを出し、選ばれたパスだけを返す。ファイルは書かない
	/// キャンセル時は Canceled を true にする
	/// </summary>
	/// <param name="paramsElement">初期表示に使う filePath。未指定ならダイアログの既定位置</param>
	/// <returns>キャンセル、または選ばれたパス</returns>
	public SaveAsDialogResult SaveAsDialog(JsonElement paramsElement)
	{
		string? suggestedPath = null;

		if (paramsElement.ValueKind != JsonValueKind.Undefined
			&& paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement))
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
	/// HTML または PDF の保存先ダイアログを出す。ファイルは書かない
	/// kind が pdf 以外のときは HTML。キャンセル時は Canceled を true にする
	/// </summary>
	/// <param name="paramsElement">kind、suggestedName、filePath。未指定なら HTML の無題</param>
	/// <returns>キャンセル、または選ばれたパス</returns>
	public SaveAsDialogResult ExportDialog(JsonElement paramsElement)
	{
		string kind = "html";
		string? suggestedName = null;
		string? suggestedPath = null;

		if (paramsElement.ValueKind != JsonValueKind.Undefined)
		{
			if (paramsElement.TryGetProperty(BridgeProperty.Kind, out JsonElement kindElement)
				&& kindElement.ValueKind == JsonValueKind.String)
			{
				kind = kindElement.GetString() ?? "html";
			}

			if (paramsElement.TryGetProperty(BridgeProperty.SuggestedName, out JsonElement nameElement)
				&& nameElement.ValueKind == JsonValueKind.String)
			{
				suggestedName = nameElement.GetString();
			}

			if (paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
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
	/// 生成済みテキストを UTF-8 で書く。監視の抑止はしない
	/// パスが空白のときは書かない
	/// </summary>
	/// <param name="paramsElement">filePath と text。text が無いときは空文字を書く</param>
	/// <returns>保存結果。文字コードは UTF-8</returns>
	/// <exception cref="InvalidOperationException">filePath が無い、または空白</exception>
	public SaveFileResult WriteUtf8(JsonElement paramsElement)
	{
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;
		string text = paramsElement.TryGetProperty(BridgeProperty.Text, out JsonElement textElement)
			? textElement.GetString() ?? string.Empty
			: string.Empty;

		if (string.IsNullOrWhiteSpace(filePath))
		{
			throw new InvalidOperationException("filePath が指定されていません。");
		}

		return _appContext.FileService.WriteUtf8(filePath, text);
	}
}
