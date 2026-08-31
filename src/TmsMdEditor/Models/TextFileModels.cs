using System.Text.Json.Serialization;

namespace TmsMdEditor.Models;

/// <summary>
/// テキストファイルの文字コード種別
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TextEncodingKind
{
	Utf8,
	Utf8Bom,
	Utf16Le,
	Utf16Be,
	Cp932,
}

/// <summary>
/// 改行コード種別
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum EolKind
{
	Crlf,
	Lf,
	Cr,
}

/// <summary>
/// 読み込んだテキストファイル情報
/// </summary>
internal sealed class TextFileInfo
{
	public string FilePath { get; init; } = string.Empty;

	public string Text { get; init; } = string.Empty;

	public TextEncodingKind Encoding { get; init; }

	public EolKind PrimaryEol { get; init; }

	public bool EolMixed { get; init; }

	public long FileSizeBytes { get; init; }
}

/// <summary>
/// 改行コード解析結果
/// </summary>
internal readonly record struct EolAnalysis(
	EolKind Primary,
	bool IsMixed,
	int CrlfCount,
	int LfCount,
	int CrCount);

/// <summary>
/// ファイル保存結果
/// </summary>
internal sealed class SaveFileResult
{
	public bool Success { get; init; }

	public string FilePath { get; init; } = string.Empty;

	public TextEncodingKind Encoding { get; init; }

	public EolKind PrimaryEol { get; init; }

	public bool EolMixed { get; init; }

	public string? Message { get; init; }
}

/// <summary>
/// ファイル選択ダイアログ結果
/// </summary>
internal sealed class OpenFileDialogResult
{
	public bool Canceled { get; init; }

	public TextFileInfo? File { get; init; }
}

/// <summary>
/// 名前を付けて保存ダイアログ結果
/// </summary>
internal sealed class SaveAsDialogResult
{
	public bool Canceled { get; init; }

	public string? FilePath { get; init; }
}

/// <summary>
/// エクスポート / 印刷の実行結果
/// </summary>
internal sealed class ExportActionResult
{
	public bool Success { get; init; }

	public bool Canceled { get; init; }

	public string? Message { get; init; }
}

/// <summary>
/// 画像 Data URL 読み込み結果
/// </summary>
internal sealed class ReadImageResult
{
	public bool Ok { get; init; }

	public string? DataUrl { get; init; }

	public string? ResolvedPath { get; init; }

	public string? Error { get; init; }
}

/// <summary>
/// 最近使ったファイル一覧応答
/// </summary>
internal sealed class RecentFilesResponse
{
	public IReadOnlyList<string> Files { get; init; } = [];
}

/// <summary>
/// ウィンドウタイトル更新結果
/// </summary>
internal sealed class WindowTitleResult
{
	public bool Success { get; init; } = true;
}

/// <summary>
/// クローズ確認結果
/// </summary>
internal sealed class CloseDecisionResult
{
	public bool AllowClose { get; init; }
}
