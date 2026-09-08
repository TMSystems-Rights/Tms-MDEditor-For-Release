using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// テキストファイルの読み書き
/// </summary>
internal sealed class FileService
{
	internal const long MaxImageBytes = 8L * 1024L * 1024L;

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

	private readonly Logger _logger;

	/// <summary>
	/// ファイルサービスを初期化する
	/// </summary>
	/// <param name="logger">ロガー</param>
	public FileService(Logger logger)
	{
		_logger = logger;
	}

	/// <summary>
	/// テキストファイルを読み込む
	/// </summary>
	/// <param name="filePath">ファイルパス</param>
	/// <returns>読み込み結果</returns>
	public TextFileInfo Read(string filePath, TextEncodingKind? specifiedEncoding = null)
	{
		string fullPath = NormalizeExistingFilePath(filePath);
		byte[] bytes    = File.ReadAllBytes(fullPath);
		TextEncodingKind encoding = specifiedEncoding ?? EncodingDetector.DetectEncoding(bytes);
		string text     = EncodingDetector.Decode(bytes, encoding);
		EolAnalysis eol = EolAnalyzer.Analyze(text);

		_logger.Debug("file", "ファイルを読み込みました", new Dictionary<string, object?>
		{
			["filePath"] = fullPath,
			["encoding"] = encoding.ToString(),
			["primaryEol"] = eol.Primary.ToString(),
			["eolMixed"] = eol.IsMixed,
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
	/// テキストファイルを保存する
	/// </summary>
	/// <param name="filePath">保存先</param>
	/// <param name="text">テキスト</param>
	/// <param name="encoding">文字コード</param>
	/// <param name="unifyEol">改行統一先。null の場合はそのまま保存</param>
	/// <returns>保存結果</returns>
	public SaveFileResult Save(string filePath, string text, TextEncodingKind encoding, EolKind? unifyEol)
	{
		string fullPath = Path.GetFullPath(filePath);
		string content  = unifyEol.HasValue ? EolAnalyzer.NormalizeEol(text, unifyEol.Value) : text;
		byte[] bytes    = EncodingDetector.Encode(content, encoding);

		WriteBytesAtomic(fullPath, bytes);

		EolAnalysis eol = EolAnalyzer.Analyze(content);

		_logger.Info("file", "ファイルを保存しました", new Dictionary<string, object?>
		{
			["filePath"] = fullPath,
			["encoding"] = encoding.ToString(),
			["primaryEol"] = eol.Primary.ToString(),
			["eolMixed"] = eol.IsMixed,
			["unifyEol"] = unifyEol?.ToString(),
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
	/// UTF-8（BOM なし）でテキストを書き込む
	/// </summary>
	/// <param name="filePath">保存先</param>
	/// <param name="text">テキスト</param>
	/// <returns>保存結果</returns>
	public SaveFileResult WriteUtf8(string filePath, string text)
	{
		return Save(filePath, text, TextEncodingKind.Utf8, unifyEol: null);
	}

	/// <summary>
	/// 画像を Data URL として読み込む
	/// </summary>
	/// <param name="path">絶対 / 相対パス（embed 指定時は null 可）</param>
	/// <param name="documentPath">Markdown ファイルの絶対パス（相対・埋め込み解決用）</param>
	/// <param name="embed">Obsidian `![[name]]` の名前</param>
	/// <returns>読み込み結果</returns>
	public ReadImageResult ReadImageAsDataUrl(string? path, string? documentPath, string? embed)
	{
		try
		{
			string? resolved = ResolveImagePath(path, documentPath, embed);
			if (resolved is null || !File.Exists(resolved))
			{
				return new ReadImageResult
				{
					Ok    = false,
					Error = "画像ファイルが見つかりません。",
				};
			}

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

			byte[] bytes  = File.ReadAllBytes(resolved);
			string mime   = GuessMimeType(extension);
			string dataUrl = $"data:{mime};base64,{Convert.ToBase64String(bytes)}";

			_logger.Debug("file", "画像を読み込みました", new Dictionary<string, object?>
			{
				["resolvedPath"] = resolved,
				["bytes"]        = bytes.Length,
			});

			return new ReadImageResult
			{
				Ok           = true,
				DataUrl      = dataUrl,
				ResolvedPath = resolved,
			};
		}
		catch (Exception ex)
		{
			_logger.Warn("file", "画像の読み込みに失敗しました", new Dictionary<string, object?>
			{
				["path"]         = path,
				["documentPath"] = documentPath,
				["embed"]        = embed,
				["error"]        = ex.Message,
			});

			return new ReadImageResult
			{
				Ok    = false,
				Error = ex.Message,
			};
		}
	}

	/// <summary>
	/// 対応する画像拡張子か判定する
	/// </summary>
	/// <param name="filePath">ファイルパス</param>
	/// <returns>対応していれば true</returns>
	internal static bool IsSupportedImagePath(string filePath)
	{
		return ImageExtensions.Contains(Path.GetExtension(filePath));
	}

	/// <summary>
	/// 画像バイトを保存し、一意なファイルパスを返す
	/// </summary>
	/// <param name="directory">保存先フォルダ</param>
	/// <param name="bytes">画像バイト</param>
	/// <param name="preferredFileName">希望ファイル名</param>
	/// <returns>保存した絶対パス</returns>
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

		string dest = Path.Combine(directory, stem + extension);
		int suffix  = 1;
		while (File.Exists(dest))
		{
			dest = Path.Combine(directory, $"{stem}-{suffix}{extension}");
			suffix++;
		}

		WriteBytesAtomic(dest, bytes);
		_logger.Info("file", "貼り付け画像を保存しました", new Dictionary<string, object?>
		{
			["filePath"] = dest,
			["bytes"]    = bytes.Length,
		});
		return dest;
	}

	internal static string StripImageSizeSuffix(string value)
	{
		int pipe = value.IndexOf('|');
		return pipe < 0 ? value.Trim() : value[..pipe].Trim();
	}

	private static string? ResolveImagePath(string? path, string? documentPath, string? embed)
	{
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

	private static string? FindEmbedImage(string documentDirectory, string embedName)
	{
		string fileName = Path.GetFileName(embedName);
		if (string.IsNullOrWhiteSpace(fileName))
		{
			return null;
		}

		// パス区切りを含む場合はドキュメントフォルダ基準の相対パスとして解決
		if (embedName.Contains('/') || embedName.Contains('\\'))
		{
			string relative = embedName.Replace('/', Path.DirectorySeparatorChar);
			string candidate = Path.GetFullPath(Path.Combine(documentDirectory, relative));
			return File.Exists(candidate) ? candidate : null;
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

		try
		{
			foreach (string candidate in Directory.EnumerateFiles(documentDirectory, fileName, SearchOption.AllDirectories))
			{
				return candidate;
			}

			if (string.IsNullOrEmpty(Path.GetExtension(fileName)))
			{
				foreach (string extension in ImageExtensions)
				{
					foreach (string candidate in Directory.EnumerateFiles(
						documentDirectory,
						fileName + extension,
						SearchOption.AllDirectories))
					{
						return candidate;
					}
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

		return null;
	}

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

	private static void WriteBytesAtomic(string filePath, byte[] bytes)
	{
		string? directory = Path.GetDirectoryName(filePath);

		if (string.IsNullOrWhiteSpace(directory))
		{
			throw new InvalidOperationException($"Invalid file path: {filePath}");
		}

		Directory.CreateDirectory(directory);

		string tempPath = Path.Combine(directory, $".{Path.GetFileName(filePath)}.{Environment.ProcessId}.tmp");
		File.WriteAllBytes(tempPath, bytes);

		if (File.Exists(filePath))
		{
			File.Delete(filePath);
		}

		File.Move(tempPath, filePath);
	}
}
