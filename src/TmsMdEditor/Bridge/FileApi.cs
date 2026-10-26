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
		// 読むパス。プロパティが無い、または null のときは空文字で、FileService が例外にする
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		// 自動判定で読んだ本文。FilePath は絶対パス
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
		// 読むパス。null のときは空文字で、FileService が例外にする
		string filePath = paramsElement.GetProperty(BridgeProperty.FilePath).GetString() ?? string.Empty;
		// 指定された文字コード。名前が未対応のときは例外。null も未対応になる
		TextEncodingKind encoding = EncodingDetector.ParseEncodingKind(paramsElement.GetProperty(BridgeProperty.Encoding).GetString());
		// 指定した文字コードで復号した本文
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
		// テキストファイルを選ぶダイアログ。キャンセルはファイルを読まない
		using var dialog = new OpenFileDialog
		{
			// ダイアログのタイトル
			Title  = "ファイルを開く",
			// Markdown、テキスト、すべてのファイル。キャンセル判定には使わない
			Filter = "Markdown (*.md;*.markdown)|*.md;*.markdown|Text (*.txt)|*.txt|All files (*.*)|*.*",
		};

		// キャンセル、またはパスが空のとき。どちらか一方でもファイルは読まない
		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.FileName))
		{
			// 読まずに戻す結果。File は null
			return new OpenFileDialogResult
			{
				// true はキャンセル。ファイルは無い
				Canceled = true,
			};
		}

		// 選ばれたファイルの本文。失敗は例外のまま出る
		TextFileInfo file = _appContext.FileService.Read(dialog.FileName);
		_appContext.FileWatcherService.Track(file.FilePath);
		// 読み込みに成功した結果。Canceled は false
		return new OpenFileDialogResult
		{
			// false は選択された
			Canceled = false,
			// 自動判定で読んだ本文。null にはしない
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
		// 保存先。プロパティが無い、null、空白のときは空文字で、保存せず例外にする
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;

		// パスが空のとき。ファイルは書かない
		if (string.IsNullOrWhiteSpace(filePath))
		{
			throw new InvalidOperationException("filePath が指定されていません。");
		}

		// 本文プロパティが無いとき。空文字の本文とは区別して保存しない
		if (!paramsElement.TryGetProperty(BridgeProperty.Text, out JsonElement textElement))
		{
			throw new InvalidOperationException("text が指定されていません。");
		}

		// 書く本文。null のときは空文字を書く
		string text = textElement.GetString() ?? string.Empty;

		// 文字コードプロパティが無いとき。保存しない
		if (!paramsElement.TryGetProperty(BridgeProperty.Encoding, out JsonElement encodingElement))
		{
			throw new InvalidOperationException("encoding が指定されていません。");
		}

		// 保存に使う文字コード。名前が未対応、または null のときは例外
		TextEncodingKind encoding = EncodingDetector.ParseEncodingKind(encodingElement.GetString());

		// 揃える改行。プロパティが無い、文字列でない、空白のときは null で、既存の改行を維持する
		EolKind? unifyEol = null;
		// unifyEol があり、かつ文字列のときだけ解釈する。片方でも欠けると既存の改行を維持する
		if (paramsElement.TryGetProperty(BridgeProperty.UnifyEol, out JsonElement unifyEolElement)
			&& unifyEolElement.ValueKind == JsonValueKind.String)
		{
			// 揃える改行の名前。空白なら維持のまま
			string? unifyValue = unifyEolElement.GetString();
			// 名前が空白でないときだけ改行種別にする。空白では既存の改行を維持する
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
		// 画像の参照、基準になる文書パス、埋め込み名。プロパティが無いときはそれぞれ null
		(string? path, string? documentPath, string? embed) = ReadImageArguments(paramsElement);
		return _appContext.FileService.ReadImageAsDataUrl(path, documentPath, embed);
	}

	/// <summary>
	/// ローカル画像か埋め込み画像の絶対パスを返す。バイトは読まない。失敗は例外にせず結果の Error に入れる
	/// </summary>
	/// <param name="paramsElement">path、documentPath、embed のいずれか。未指定のオブジェクトでも解決にいく</param>
	/// <returns>成功時は絶対パス。失敗時は Ok が false。Data URL は入らない</returns>
	public ReadImageResult ResolveLocalImage(JsonElement paramsElement)
	{
		// 画像の参照、基準になる文書パス、埋め込み名。プロパティが無いときはそれぞれ null
		(string? path, string? documentPath, string? embed) = ReadImageArguments(paramsElement);
		return _appContext.FileService.ResolveLocalImage(path, documentPath, embed);
	}

	/// <summary>
	/// 画像解決の引数を読む。プロパティが無いときは null
	/// </summary>
	/// <param name="paramsElement">path、documentPath、embed。未指定ならすべて null</param>
	/// <returns>パス、文書パス、埋め込み名。文字列以外の値は null</returns>
	private static (string? Path, string? DocumentPath, string? Embed) ReadImageArguments(JsonElement paramsElement)
	{
		// Markdown 上のパスまたは URL。未指定なら null
		string? path = null;
		// 相対パスの基準になる文書のパス。未指定なら null
		string? documentPath = null;
		// 埋め込み画像の名前。未指定なら null
		string? embed = null;

		// params があるときだけ各プロパティを読む。未指定のオブジェクトではすべて null のまま
		if (paramsElement.ValueKind != JsonValueKind.Undefined)
		{
			// path があり、かつ文字列のときだけ採用する。片方でも欠けると null のまま
			if (paramsElement.TryGetProperty(BridgeProperty.Path, out JsonElement pathElement)
				&& pathElement.ValueKind == JsonValueKind.String)
			{
				path = pathElement.GetString();
			}

			// documentPath があり、かつ文字列のときだけ採用する。片方でも欠けると null のまま
			if (paramsElement.TryGetProperty(BridgeProperty.DocumentPath, out JsonElement documentPathElement)
				&& documentPathElement.ValueKind == JsonValueKind.String)
			{
				documentPath = documentPathElement.GetString();
			}

			// embed があり、かつ文字列のときだけ採用する。片方でも欠けると null のまま
			if (paramsElement.TryGetProperty(BridgeProperty.Embed, out JsonElement embedElement)
				&& embedElement.ValueKind == JsonValueKind.String)
			{
				embed = embedElement.GetString();
			}
		}

		return (path, documentPath, embed);
	}

	/// <summary>
	/// 名前を付けて保存ダイアログを出し、選ばれたパスだけを返す。ファイルは書かない
	/// キャンセル時は Canceled を true にする
	/// </summary>
	/// <param name="paramsElement">初期表示に使う filePath。未指定ならダイアログの既定位置</param>
	/// <returns>キャンセル、または選ばれたパス</returns>
	public SaveAsDialogResult SaveAsDialog(JsonElement paramsElement)
	{
		// 初期表示に使うパス。未指定なら null で、ダイアログの既定位置になる
		string? suggestedPath = null;

		// params があり、かつ filePath があるときだけ初期パスを使う。片方でも欠けると既定位置のまま
		if (paramsElement.ValueKind != JsonValueKind.Undefined
			&& paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement))
		{
			suggestedPath = filePathElement.GetString();
		}

		// 保存先を選ぶダイアログ。この時点ではファイルを書かない
		using var dialog = new SaveFileDialog
		{
			// ダイアログのタイトル
			Title  = "名前を付けて保存",
			// Markdown、テキスト、すべてのファイル
			Filter = "Markdown (*.md;*.markdown)|*.md;*.markdown|Text (*.txt)|*.txt|All files (*.*)|*.*",
		};

		// 初期パスが空白でないとき。ファイル名と、ディレクトリがあれば初期フォルダにする
		if (!string.IsNullOrWhiteSpace(suggestedPath))
		{
			dialog.FileName = Path.GetFileName(suggestedPath);
			// 初期パスのディレクトリ。ルートだけのときは空で、初期フォルダは変えない
			string? directory = Path.GetDirectoryName(suggestedPath);
			// ディレクトリが取れたときだけ初期フォルダにする。空ではダイアログの既定を残す
			if (!string.IsNullOrWhiteSpace(directory))
			{
				dialog.InitialDirectory = directory;
			}
		}

		// キャンセル、またはパスが空のとき。どちらか一方でもファイルは書かない
		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.FileName))
		{
			return new SaveAsDialogResult { Canceled = true };
		}

		// 選ばれたパス。ファイルはまだ書かない
		return new SaveAsDialogResult
		{
			// false は選択された
			Canceled = false,
			// ダイアログが返したパス。空ではこの分岐に来ない
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
		// 出力形式。pdf 以外は html。未指定も html
		string kind = "html";
		// 初期ファイル名。未指定なら null で、パスか無題から決める
		string? suggestedName = null;
		// 初期フォルダの元になるパス。未指定なら null
		string? suggestedPath = null;

		// params があるときだけ kind、名前、パスを読む。未指定では html の無題になる
		if (paramsElement.ValueKind != JsonValueKind.Undefined)
		{
			// kind があり、かつ文字列のときだけ形式を変える。片方でも欠けると html のまま
			if (paramsElement.TryGetProperty(BridgeProperty.Kind, out JsonElement kindElement)
				&& kindElement.ValueKind == JsonValueKind.String)
			{
				kind = kindElement.GetString() ?? "html";
			}

			// suggestedName があり、かつ文字列のときだけ初期ファイル名にする
			if (paramsElement.TryGetProperty(BridgeProperty.SuggestedName, out JsonElement nameElement)
				&& nameElement.ValueKind == JsonValueKind.String)
			{
				suggestedName = nameElement.GetString();
			}

			// filePath があり、かつ文字列のときだけ初期フォルダの候補にする
			if (paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
				&& filePathElement.ValueKind == JsonValueKind.String)
			{
				suggestedPath = filePathElement.GetString();
			}
		}

		// true のとき PDF。それ以外は HTML。大文字小文字は区別しない
		bool isPdf = string.Equals(kind, "pdf", StringComparison.OrdinalIgnoreCase);
		// 拡張子とフィルタを形式で分けた保存ダイアログ。この時点ではファイルを書かない
		using var dialog = new SaveFileDialog
		{
			// PDF と HTML でタイトルを変える
			Title            = isPdf ? "PDFとしてエクスポート" : "HTMLとしてエクスポート",
			// 形式に合うフィルタ。すべてのファイルも含める
			Filter           = isPdf ? "PDF (*.pdf)|*.pdf|All files (*.*)|*.*" : "HTML (*.html)|*.html|All files (*.*)|*.*",
			// 拡張子を省略したときに足す既定。pdf または html
			DefaultExt       = isPdf ? "pdf" : "html",
			// true なら DefaultExt を自動で足す
			AddExtension     = true,
			// true なら上書き前に確認する
			OverwritePrompt  = true,
		};

		// 提案名が空白でないとき。ダイアログのファイル名にする
		if (!string.IsNullOrWhiteSpace(suggestedName))
		{
			dialog.FileName = suggestedName;
		}

		// 元パスが空白でないとき。ディレクトリと、ファイル名が空なら拡張子付きの名前を足す
		if (!string.IsNullOrWhiteSpace(suggestedPath))
		{
			// 元パスのディレクトリ。取れなければ初期フォルダは変えない
			string? directory = Path.GetDirectoryName(suggestedPath);
			// ディレクトリが取れたときだけ初期フォルダにする
			if (!string.IsNullOrWhiteSpace(directory))
			{
				dialog.InitialDirectory = directory;
			}

			// まだファイル名が空のとき。元パスの幹に形式の拡張子を足す
			if (string.IsNullOrWhiteSpace(dialog.FileName))
			{
				// 拡張子を除いたファイル名。空なら無題
				string stem = Path.GetFileNameWithoutExtension(suggestedPath);
				dialog.FileName = string.IsNullOrWhiteSpace(stem)
					? (isPdf ? "無題.pdf" : "無題.html")
					: stem + (isPdf ? ".pdf" : ".html");
			}
		}

		// 提案も元パスもファイル名にならなかったとき。形式に合う無題にする
		if (string.IsNullOrWhiteSpace(dialog.FileName))
		{
			dialog.FileName = isPdf ? "無題.pdf" : "無題.html";
		}

		// キャンセル、またはパスが空のとき。どちらか一方でもファイルは書かない
		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.FileName))
		{
			return new SaveAsDialogResult { Canceled = true };
		}

		// 選ばれたパス。ファイルはまだ書かない
		return new SaveAsDialogResult
		{
			// false は選択された
			Canceled = false,
			// ダイアログが返したパス。空ではこの分岐に来ない
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
		// 書くパス。プロパティが無い、null、空白のときは空文字で、例外にする
		string filePath = paramsElement.TryGetProperty(BridgeProperty.FilePath, out JsonElement filePathElement)
			? filePathElement.GetString() ?? string.Empty
			: string.Empty;
		// 書く本文。プロパティが無い、または null のときは空文字を書く
		string text = paramsElement.TryGetProperty(BridgeProperty.Text, out JsonElement textElement)
			? textElement.GetString() ?? string.Empty
			: string.Empty;

		// パスが空のとき。ファイルは書かない
		if (string.IsNullOrWhiteSpace(filePath))
		{
			throw new InvalidOperationException("filePath が指定されていません。");
		}

		return _appContext.FileService.WriteUtf8(filePath, text);
	}
}
