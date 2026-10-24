// ==============================================
// テキストと画像ファイルの読み書き
// ==============================================

// 開いている文書の本文はこの型が保持しない
// ホストがパスと文字コードを渡し、原子的な置換と画像の保存先決定だけをここが行う

using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// テキストを文字コードと改行の情報つきで読み、一時ファイル経由で保存する
/// 画像は対応拡張子と 8MB までを Data URL または連番ファイルにする
/// </summary>
internal sealed class FileService
{
	// ==============================================
	// 対応形式とログ
	// ==============================================

	/// <summary>
	/// 画像として読む、または保存するバイト数の上限。単位はバイト。超えたら失敗にする
	/// </summary>
	internal const long MaxImageBytes = 8L * 1024L * 1024L;

	/// <summary>
	/// 画像として認める拡張子。大文字小文字は無視する。プロセスで共有し、実行中は増やさない
	/// </summary>
	private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
	{
		".png",
		".jpg",
		".jpeg",
		".gif",
		".webp",
		".bmp",
		".ico",
		".svg",
	};

	/// <summary>
	/// 読み書きの成否を記録するログ。失敗の返し方自体はメソッドの結果が持つ
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// 読み書きの記録先を受け取る。ファイルの監視は始めない
	/// </summary>
	/// <param name="logger">読み書きを記録するログ。このサービスでは破棄しない</param>
	public FileService(Logger logger)
	{
		_logger = logger;
	}

	// ==============================================
	// テキストの読み書き
	// ==============================================

	/// <summary>
	/// 実在するテキストファイルを読み、文字コードと主改行を付ける
	/// </summary>
	/// <param name="filePath">読むファイル。空白だけは失敗。相対パスはカレントから絶対パスにする</param>
	/// <param name="specifiedEncoding">再読込で使う文字コード。null のときは BOM と UTF-8 妥当性から決める</param>
	/// <returns>絶対パス、本文、文字コード、主改行、混在、ファイルサイズ</returns>
	/// <exception cref="InvalidOperationException"><paramref name="filePath"/> が空</exception>
	/// <exception cref="FileNotFoundException">正規化後のパスにファイルが無い</exception>
	public TextFileInfo Read(string filePath, TextEncodingKind? specifiedEncoding = null)
	{
		string fullPath = NormalizeExistingFilePath(filePath);
		byte[] bytes    = File.ReadAllBytes(fullPath);
		// 再読込で明示指定された文字コードを優先し、通常読込だけ自動判定する
		TextEncodingKind encoding = specifiedEncoding ?? EncodingDetector.DetectEncoding(bytes);
		string text     = EncodingDetector.Decode(bytes, encoding);
		EolAnalysis eol = EolAnalyzer.Analyze(text);

		_logger.Debug(LogCategory.File, "ファイルを読み込みました", new Dictionary<string, object?>
		{
			[LogProperty.FilePath]   = fullPath,
			[LogProperty.Encoding]   = encoding.ToString(),
			[LogProperty.PrimaryEol] = eol.Primary.ToString(),
			[LogProperty.EolMixed]   = eol.IsMixed,
		});

		long fileSizeBytes = new FileInfo(fullPath).Length;

		return new TextFileInfo
		{
			FilePath      = fullPath,
			Text          = text,
			Encoding      = encoding,
			PrimaryEol    = eol.Primary,
			EolMixed      = eol.IsMixed,
			FileSizeBytes = fileSizeBytes,
		};
	}

	/// <summary>
	/// 本文を指定の文字コードで原子的に保存する。改行の統一は指定があるときだけ行う
	/// </summary>
	/// <param name="filePath">保存先。相対パスはカレントから絶対パスにする。親ディレクトリは作る</param>
	/// <param name="text">保存する本文</param>
	/// <param name="encoding">書き込む文字コード</param>
	/// <param name="unifyEol">改行の統一先。null のときは本文の改行を変えない</param>
	/// <returns>保存した絶対パスと、保存後本文の文字コード、主改行、混在</returns>
	/// <exception cref="InvalidOperationException"><paramref name="filePath"/> にディレクトリ部分が無い</exception>
	public SaveFileResult Save(string filePath, string text, TextEncodingKind encoding, EolKind? unifyEol)
	{
		string fullPath = Path.GetFullPath(filePath);
		// 混在改行を保持する選択肢があるため、統一指定がある場合だけ本文を変換する
		string content  = unifyEol.HasValue ? EolAnalyzer.NormalizeEol(text, unifyEol.Value) : text;
		byte[] bytes    = EncodingDetector.Encode(content, encoding);

		WriteBytesAtomic(fullPath, bytes);

		EolAnalysis eol = EolAnalyzer.Analyze(content);

		_logger.Info(LogCategory.File, "ファイルを保存しました", new Dictionary<string, object?>
		{
			[LogProperty.FilePath]   = fullPath,
			[LogProperty.Encoding]   = encoding.ToString(),
			[LogProperty.PrimaryEol] = eol.Primary.ToString(),
			[LogProperty.EolMixed]   = eol.IsMixed,
			[LogProperty.UnifyEol]   = unifyEol?.ToString(),
		});

		return new SaveFileResult
		{
			Success    = true,
			FilePath   = fullPath,
			Encoding   = encoding,
			PrimaryEol = eol.Primary,
			EolMixed   = eol.IsMixed,
		};
	}

	/// <summary>
	/// BOM 無し UTF-8 で本文を保存する。改行は統一しない
	/// </summary>
	/// <param name="filePath">保存先。相対パスはカレントから絶対パスにする</param>
	/// <param name="text">保存する本文。改行はそのまま残す</param>
	/// <returns>保存した絶対パスと、保存後本文の改行情報</returns>
	/// <exception cref="InvalidOperationException"><paramref name="filePath"/> にディレクトリ部分が無い</exception>
	public SaveFileResult WriteUtf8(string filePath, string text)
	{
		return Save(filePath, text, TextEncodingKind.Utf8, unifyEol: null);
	}

	// ==============================================
	// 画像の読み書き
	// ==============================================

	/// <summary>
	/// 画像を Data URL として読む。見つからない、上限超過、未対応形式は結果のエラーにし、例外は出さない
	/// </summary>
	/// <param name="path">絶対または文書相対のパス。埋め込み指定のときは null でもよい</param>
	/// <param name="documentPath">相対パスと埋め込みの基準になる Markdown の絶対パス。null なら相対解決はしない</param>
	/// <param name="embed">Obsidian の埋め込み名。null でなければ path より先に解決する</param>
	/// <returns>Data URL と解決した絶対パス。失敗時は Error</returns>
	public ReadImageResult ReadImageAsDataUrl(string? path, string? documentPath, string? embed)
	{
		ReadImageResult located = ResolveLocalImage(path, documentPath, embed);
		if (!located.Ok || string.IsNullOrWhiteSpace(located.ResolvedPath))
		{
			return located;
		}

		try
		{
			byte[] bytes   = File.ReadAllBytes(located.ResolvedPath);
			string mime    = GuessMimeType(Path.GetExtension(located.ResolvedPath));
			string dataUrl = $"data:{mime};base64,{Convert.ToBase64String(bytes)}";

			_logger.Debug(LogCategory.File, "画像を読み込みました", new Dictionary<string, object?>
			{
				[LogProperty.ResolvedPath] = located.ResolvedPath,
				[LogProperty.Bytes]        = bytes.Length,
			});

			return new ReadImageResult
			{
				Ok           = true,
				DataUrl      = dataUrl,
				ResolvedPath = located.ResolvedPath,
			};
		}
		catch (Exception ex)
		{
			_logger.Warn(LogCategory.File, "画像の読み込みに失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Path]         = path,
				[LogProperty.DocumentPath] = documentPath,
				[LogProperty.Embed]        = embed,
				[LogProperty.Error]        = ex.Message,
			});

			return new ReadImageResult
			{
				Ok    = false,
				Error = ex.Message,
			};
		}
	}

	/// <summary>
	/// 画像の絶対パスだけを解決する。バイトは読まない。見つからない、上限超過、未対応形式は結果のエラーにし、例外は出さない
	/// </summary>
	/// <param name="path">絶対または文書相対のパス。埋め込み指定のときは null でもよい</param>
	/// <param name="documentPath">相対パスと埋め込みの基準になる Markdown の絶対パス。null なら相対解決はしない</param>
	/// <param name="embed">Obsidian の埋め込み名。null でなければ path より先に解決する</param>
	/// <returns>解決した絶対パス。失敗時は Error。Data URL は入れない</returns>
	public ReadImageResult ResolveLocalImage(string? path, string? documentPath, string? embed)
	{
		try
		{
			// 通常Markdown画像とObsidian埋め込みを共通の絶対パスへ解決してから安全性を確認する
			string? resolved = ResolveImagePath(path, documentPath, embed);
			if (resolved is null || !File.Exists(resolved))
			{
				return new ReadImageResult
				{
					Ok    = false,
					Error = "画像ファイルが見つかりません。",
				};
			}

			// PDF へコピーする前に、Data URL 化と同じ上限で大きなファイルを弾く
			var info = new FileInfo(resolved);
			if (info.Length > MaxImageBytes)
			{
				return new ReadImageResult
				{
					Ok    = false,
					Error = $"画像サイズが上限（{MaxImageBytes / (1024 * 1024)}MB）を超えています。",
				};
			}

			string extension = Path.GetExtension(resolved);
			if (!ImageExtensions.Contains(extension))
			{
				return new ReadImageResult
				{
					Ok    = false,
					Error = "未対応の画像形式です。",
				};
			}

			_logger.Debug(LogCategory.File, "画像のパスを解決しました", new Dictionary<string, object?>
			{
				[LogProperty.ResolvedPath] = resolved,
				[LogProperty.Bytes]        = info.Length,
			});

			return new ReadImageResult
			{
				Ok           = true,
				ResolvedPath = resolved,
			};
		}
		catch (Exception ex)
		{
			_logger.Warn(LogCategory.File, "画像の読み込みに失敗しました", new Dictionary<string, object?>
			{
				[LogProperty.Path]         = path,
				[LogProperty.DocumentPath] = documentPath,
				[LogProperty.Embed]        = embed,
				[LogProperty.Error]        = ex.Message,
			});

			return new ReadImageResult
			{
				Ok    = false,
				Error = ex.Message,
			};
		}
	}

	/// <summary>
	/// パスの拡張子が画像として認めるものかを返す。ファイルの中身は見ない
	/// </summary>
	/// <param name="filePath">拡張子を見るパス。存在しなくても判定する</param>
	/// <returns>対応する拡張子なら true。大文字小文字は無視する</returns>
	internal static bool IsSupportedImagePath(string filePath)
	{
		return ImageExtensions.Contains(Path.GetExtension(filePath));
	}

	/// <summary>
	/// 画像バイトを保存し、既存ファイルを上書きしない一意な絶対パスを返す
	/// </summary>
	/// <param name="directory">保存先フォルダ。無ければ作る</param>
	/// <param name="bytes">保存する画像。上限を超えると失敗</param>
	/// <param name="preferredFileName">希望するファイル名。拡張子は対応一覧に含まれる必要がある。幹が空なら日時名にする</param>
	/// <returns>保存した絶対パス。同名があるときは連番を付ける</returns>
	/// <exception cref="InvalidOperationException">サイズが上限を超える、または拡張子が未対応</exception>
	public string SaveImageCopy(string directory, byte[] bytes, string preferredFileName)
	{
		if (bytes.LongLength > MaxImageBytes)
		{
			throw new InvalidOperationException($"画像サイズが上限（{MaxImageBytes / (1024 * 1024)}MB）を超えています。");
		}

		string extension = Path.GetExtension(preferredFileName);
		if (!ImageExtensions.Contains(extension))
		{
			throw new InvalidOperationException("未対応の画像形式です。");
		}

		string stem = Path.GetFileNameWithoutExtension(preferredFileName);
		if (string.IsNullOrWhiteSpace(stem))
		{
			stem = $"Pasted image {DateTime.Now:yyyyMMddHHmmss}";
		}

		Directory.CreateDirectory(directory);

		// 同名添付を上書きせず、連番を付けて既存リンクの参照先を保護する
		string dest = Path.Combine(directory, stem + extension);
		int suffix  = 1;
		while (File.Exists(dest))
		{
			dest = Path.Combine(directory, $"{stem}-{suffix}{extension}");
			suffix++;
		}

		WriteBytesAtomic(dest, bytes);
		_logger.Info(LogCategory.File, "貼り付け画像を保存しました", new Dictionary<string, object?>
		{
			[LogProperty.FilePath] = dest,
			[LogProperty.Bytes]    = bytes.Length,
		});
		return dest;
	}

	// ==============================================
	// 画像パスの解決
	// ==============================================

	/// <summary>
	/// 画像指定から、幅などの | 以降を除いたパス部分だけを返す
	/// </summary>
	/// <param name="value">パス、または パス|幅 の形式</param>
	/// <returns>| より前を trim した文字列。| が無ければ全体を trim する</returns>
	internal static string StripImageSizeSuffix(string value)
	{
		int pipe = value.IndexOf('|');
		return pipe < 0 ? value.Trim() : value[..pipe].Trim();
	}

	/// <summary>
	/// Markdown のパスと Obsidian 埋め込みを、1 つの絶対パスへ解決する
	/// </summary>
	/// <param name="path">通常の画像パス。埋め込みがあるときは後回し</param>
	/// <param name="documentPath">相対解決の基準になる文書。null なら相対パスは解決しない</param>
	/// <param name="embed">埋め込み名。空白でなければこちらを先に解決する</param>
	/// <returns>解決した絶対パス。材料が足りなければ null。存在確認は呼び出し側</returns>
	private static string? ResolveImagePath(string? path, string? documentPath, string? embed)
	{
		// Wiki埋め込みはVault内検索が必要なため、通常のMarkdownパスより先に専用解決する
		if (!string.IsNullOrWhiteSpace(embed))
		{
			string embedPath = StripImageSizeSuffix(embed);
			if (TryResolveAbsoluteImagePath(embedPath, out string? absoluteEmbed))
			{
				return absoluteEmbed;
			}

			if (string.IsNullOrWhiteSpace(documentPath))
			{
				return null;
			}

			string? documentDirectory = Path.GetDirectoryName(Path.GetFullPath(documentPath));
			if (string.IsNullOrWhiteSpace(documentDirectory) || !Directory.Exists(documentDirectory))
			{
				return null;
			}

			return FindEmbedImage(documentDirectory, embedPath);
		}

		if (string.IsNullOrWhiteSpace(path))
		{
			return null;
		}

		string trimmed = StripImageSizeSuffix(path).Replace('/', Path.DirectorySeparatorChar);

		// 絶対パスは文書位置に依存させず、そのまま正規化して返す
		if (TryResolveAbsoluteImagePath(trimmed, out string? absolutePath))
		{
			return absolutePath;
		}

		if (string.IsNullOrWhiteSpace(documentPath))
		{
			return null;
		}

		string? baseDirectory = Path.GetDirectoryName(Path.GetFullPath(documentPath));
		if (string.IsNullOrWhiteSpace(baseDirectory))
		{
			return null;
		}

		return Path.GetFullPath(Path.Combine(baseDirectory, trimmed));
	}

	/// <summary>
	/// 完全修飾パスだけを絶対パスへ正規化する。相対パスは失敗として null を返す
	/// </summary>
	/// <param name="path">候補パス。空白は失敗</param>
	/// <param name="resolved">正規化した絶対パス。失敗時は null</param>
	/// <returns>完全修飾であり、正規化できれば true。存在確認はしない</returns>
	private static bool TryResolveAbsoluteImagePath(string path, out string? resolved)
	{
		resolved = null;
		if (string.IsNullOrWhiteSpace(path))
		{
			return false;
		}

		string normalized = path.Trim().Replace('/', Path.DirectorySeparatorChar);
		if (!Path.IsPathFullyQualified(normalized))
		{
			return false;
		}

		// 直下で見つからない場合だけ再帰検索し、通常ケースのI/O負荷を抑える
		try
		{
			resolved = Path.GetFullPath(normalized);
			return true;
		}
		catch (Exception)
		{
			return false;
		}
	}

	/// <summary>
	/// Obsidian 埋め込み名を、文書隣、保管庫ルート、一意な同名ファイルの順で探す
	/// </summary>
	/// <param name="documentDirectory">文書のあるディレクトリ。実在することを呼び出し側が保証する</param>
	/// <param name="embedName">埋め込み名。幅指定は除いてある</param>
	/// <returns>見つかった絶対パス。同名が複数なら null。無ければ null</returns>
	private static string? FindEmbedImage(string documentDirectory, string embedName)
	{
		string normalized = embedName.Trim().Replace('/', Path.DirectorySeparatorChar);
		string fileName   = Path.GetFileName(normalized);
		if (string.IsNullOrWhiteSpace(fileName))
		{
			return null;
		}

		string? vaultRoot = FindObsidianVaultRoot(documentDirectory);
		if (normalized.Contains(Path.DirectorySeparatorChar))
		{
			// `./` と `../` は明示的な文書相対パスとして扱う
			if (IsExplicitRelativePath(normalized))
			{
				return ExistingFullPath(documentDirectory, normalized);
			}

			// Obsidian のフォルダ付き内部リンクは保管庫ルート基準。添付先名は固定しない
			string? vaultCandidate = vaultRoot is null
				? null
				: ExistingFullPath(vaultRoot, normalized.TrimStart(Path.DirectorySeparatorChar));
			if (vaultCandidate is not null)
			{
				return vaultCandidate;
			}

			// Obsidian 保管庫外や文書相対で記録された既存ファイルを後方互換として解決する
			return ExistingFullPath(documentDirectory, normalized);
		}

		string direct = Path.Combine(documentDirectory, fileName);
		if (File.Exists(direct))
		{
			return direct;
		}

		// 拡張子省略時は既知拡張子を試す
		if (string.IsNullOrEmpty(Path.GetExtension(fileName)))
		{
			foreach (string extension in ImageExtensions)
			{
				string withExt = Path.Combine(documentDirectory, fileName + extension);
				if (File.Exists(withExt))
				{
					return withExt;
				}
			}
		}

		string searchRoot = vaultRoot ?? documentDirectory;
		return FindUniqueEmbedImage(searchRoot, fileName);
	}

	/// <summary>
	/// 文書ディレクトリから親をたどり、.obsidian がある保管庫ルートを返す
	/// </summary>
	/// <param name="documentDirectory">探索を始める文書のディレクトリ</param>
	/// <returns>保管庫ルート。見つからなければ null</returns>
	private static string? FindObsidianVaultRoot(string documentDirectory)
	{
		var current = new DirectoryInfo(Path.GetFullPath(documentDirectory));
		while (current is not null)
		{
			if (Directory.Exists(Path.Combine(current.FullName, ".obsidian")))
			{
				return current.FullName;
			}

			current = current.Parent;
		}

		return null;
	}

	/// <summary>
	/// ./ または ../ で始まる、明示した相対パスかを返す
	/// </summary>
	/// <param name="path">区切りをプラットフォーム文字へ揃えたパス</param>
	/// <returns>先頭が ./ または ../ なら true</returns>
	private static bool IsExplicitRelativePath(string path)
	{
		return path.StartsWith($".{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
			|| path.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal);
	}

	/// <summary>
	/// 基準ディレクトリと相対パスを結合し、実在するファイルの絶対パスだけを返す
	/// </summary>
	/// <param name="baseDirectory">結合の基準</param>
	/// <param name="relativePath">基準からの相対パス</param>
	/// <returns>実在すれば絶対パス。不正なパスや未存在は null</returns>
	private static string? ExistingFullPath(string baseDirectory, string relativePath)
	{
		try
		{
			string candidate = Path.GetFullPath(Path.Combine(baseDirectory, relativePath));
			return File.Exists(candidate) ? candidate : null;
		}
		catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
		{
			return null;
		}
	}

	/// <summary>
	/// 保管庫または文書配下から同名画像を 1 件だけ探す。複数あれば結び付けない
	/// </summary>
	/// <param name="searchRoot">再帰検索の起点</param>
	/// <param name="fileName">ファイル名。拡張子が無ければ対応拡張子を順に試す</param>
	/// <returns>一意に見つかったパス。0 件または 2 件以上、探索失敗は null</returns>
	private static string? FindUniqueEmbedImage(string searchRoot, string fileName)
	{
		string? match = null;
		IEnumerable<string> searchNames = string.IsNullOrEmpty(Path.GetExtension(fileName))
			? ImageExtensions.Select(extension => fileName + extension)
			: [fileName];

		try
		{
			foreach (string searchName in searchNames)
			{
				foreach (string candidate in Directory.EnumerateFiles(searchRoot, searchName, SearchOption.AllDirectories))
				{
					if (match is not null)
					{
						// Obsidian の短縮リンクを同名ファイルへ恣意的に結び付けない
						return null;
					}

					match = candidate;
				}
			}
		}
		catch (UnauthorizedAccessException)
		{
			// 配下探索失敗時は見つからなかった扱い
		}
		catch (DirectoryNotFoundException)
		{
		}
		catch (IOException)
		{
		}

		return match;
	}

	// ==============================================
	// メディア種別と原子的書き込み
	// ==============================================

	/// <summary>
	/// 拡張子から Data URL に載せるメディア種別を決める。未知は汎用のバイト列にする
	/// </summary>
	/// <param name="extension">ドット付き拡張子。大文字小文字は無視する</param>
	/// <returns>image/* または application/octet-stream</returns>
	private static string GuessMimeType(string extension)
	{
		return extension.ToLowerInvariant() switch
		{
			".png"  => "image/png",
			".jpg"  => "image/jpeg",
			".jpeg" => "image/jpeg",
			".gif"  => "image/gif",
			".webp" => "image/webp",
			".bmp"  => "image/bmp",
			".ico"  => "image/x-icon",
			".svg"  => "image/svg+xml",
			_       => "application/octet-stream",
		};
	}

	/// <summary>
	/// 実在するファイルの絶対パスを返す。空と未存在は例外にする
	/// </summary>
	/// <param name="filePath">正規化するパス。相対パスはカレントから絶対パスにする</param>
	/// <returns>実在するファイルの絶対パス</returns>
	/// <exception cref="InvalidOperationException"><paramref name="filePath"/> が空</exception>
	/// <exception cref="FileNotFoundException">正規化後のパスにファイルが無い</exception>
	private static string NormalizeExistingFilePath(string filePath)
	{
		if (string.IsNullOrWhiteSpace(filePath))
		{
			throw new InvalidOperationException("ファイルパスが指定されていません。");
		}

		string fullPath = Path.GetFullPath(filePath);

		if (!File.Exists(fullPath))
		{
			throw new FileNotFoundException("ファイルが見つかりません。", fullPath);
		}

		return fullPath;
	}

	/// <summary>
	/// 同じディレクトリの一時ファイルへ書いてから、既存ファイルは置換、新規は移動する
	/// </summary>
	/// <param name="filePath">最終的な保存先。ディレクトリ部分が無ければ失敗</param>
	/// <param name="bytes">書き込むバイト列</param>
	/// <exception cref="InvalidOperationException"><paramref name="filePath"/> にディレクトリ部分が無い</exception>
	private static void WriteBytesAtomic(string filePath, byte[] bytes)
	{
		string? directory = Path.GetDirectoryName(filePath);

		if (string.IsNullOrWhiteSpace(directory))
		{
			throw new InvalidOperationException($"Invalid file path: {filePath}");
		}

		Directory.CreateDirectory(directory);

		// 同一ディレクトリの一時ファイルを使い、最終移動を同一ボリューム内の原子的操作にする
		string tempPath = Path.Combine(directory, $".{Path.GetFileName(filePath)}.{Environment.ProcessId}.tmp");
		File.WriteAllBytes(tempPath, bytes);

		try
		{
			if (File.Exists(filePath))
			{
				// 削除してから Move すると FileSystemWatcher が Deleted を上げる
				// 既存ファイルは Replace で中身だけ差し替え、新規は Move する
				File.Replace(tempPath, filePath, destinationBackupFileName: null, ignoreMetadataErrors: true);
			}
			else
			{
				File.Move(tempPath, filePath);
			}
		}
		finally
		{
			// Replace/Move失敗時にも次回保存を邪魔する一時ファイルを可能な限り残さない
			if (File.Exists(tempPath))
			{
				try
				{
					File.Delete(tempPath);
				}
				catch (IOException)
				{
				}
				catch (UnauthorizedAccessException)
				{
				}
			}
		}
	}
}
