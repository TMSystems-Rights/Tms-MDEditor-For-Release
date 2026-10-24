// ==============================================
// 読み書きとダイアログの結果型を置く
// ==============================================

// 読み書きの結果、ダイアログの選択、貼り付けと更新以外のブリッジ応答をまとめる
// 失敗は例外にせず、各結果のフラグとメッセージで返すものがある

using System.Text.Json.Serialization;

namespace TmsMdEditor.Models;

/// <summary>
/// テキストファイルの読み書きに使う文字コード
/// バイト列から判定できないときは Cp932 を使い、名前が未知のときは例外にする
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TextEncodingKind
{
	/// <summary>
	/// BOM の無い UTF-8。新規ファイルの既定で、有効な UTF-8 と判定したファイルにも使う
	/// </summary>
	Utf8,

	/// <summary>
	/// BOM 付き UTF-8。先頭 3 バイトが EF BB BF のときに選ぶ
	/// </summary>
	Utf8Bom,

	/// <summary>
	/// リトルエンディアンの UTF-16。BOM 付きで読み書きする
	/// </summary>
	Utf16Le,

	/// <summary>
	/// ビッグエンディアンの UTF-16。BOM 付きで読み書きする
	/// </summary>
	Utf16Be,

	/// <summary>
	/// コードページ 932。UTF-8 としても UTF-16 としても読めないバイト列のフォールバック
	/// </summary>
	Cp932,
}

/// <summary>
/// 本文の改行。改行が 1 つも無いときの代表値は CrLf。同数のときは CrLf、Lf、Cr の順で選ぶ
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum EolKind
{
	/// <summary>
	/// CR+LF。Windows の新規ファイルの既定
	/// </summary>
	Crlf,

	/// <summary>
	/// LF のみ
	/// </summary>
	Lf,

	/// <summary>
	/// CR のみ
	/// </summary>
	Cr,
}

/// <summary>
/// ディスクから読んだ 1 ファイルの本文と、判定した文字コード、改行
/// 監視やタブが保持するのはこの値のコピーで、ファイル自体のロックは持たない
/// </summary>
internal sealed class TextFileInfo
{
	/// <summary>
	/// 読み込んだファイルの絶対パス。空のまま返すことはしない
	/// </summary>
	public string FilePath { get; init; } = string.Empty;

	/// <summary>
	/// 復号した本文。改行はファイル上のまま。空ファイルは空文字
	/// </summary>
	public string Text { get; init; } = string.Empty;

	/// <summary>
	/// 復号に使った文字コード。自動判定か、開き直しで指定した値
	/// </summary>
	public TextEncodingKind Encoding { get; init; }

	/// <summary>
	/// 最も多かった改行。改行が無いときは CrLf
	/// </summary>
	public EolKind PrimaryEol { get; init; }

	/// <summary>
	/// 2 種類以上の改行が混在しているか。混在していても本文は変換しない
	/// </summary>
	public bool EolMixed { get; init; }

	/// <summary>
	/// ディスク上のファイルサイズ。バイト。本文の文字数とは別
	/// </summary>
	public long FileSizeBytes { get; init; }
}

/// <summary>
/// 本文に含まれる改行の個数と、代表の改行。保存時に揃える種別の決定に使う
/// 改行が無いときは Primary が CrLf で、各カウントは 0
/// </summary>
/// <param name="Primary">最も多い改行。同数では CrLf、Lf、Cr の順</param>
/// <param name="IsMixed">2 種類以上あるとき true</param>
/// <param name="CrlfCount">CR+LF の個数</param>
/// <param name="LfCount">単独 LF の個数。CR+LF の LF は含めない</param>
/// <param name="CrCount">単独 CR の個数</param>
internal readonly record struct EolAnalysis(
	EolKind Primary,
	bool IsMixed,
	int CrlfCount,
	int LfCount,
	int CrCount);

/// <summary>
/// テキスト保存の結果。失敗時は Success が false で、Message に理由を入れる
/// </summary>
internal sealed class SaveFileResult
{
	/// <summary>
	/// ファイルへ書けたか。false のとき FilePath は要求したパスのまま残ることがある
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// 書き込み先のパス。失敗時も、分かっていればそのパス
	/// </summary>
	public string FilePath { get; init; } = string.Empty;

	/// <summary>
	/// 保存に使った文字コード。失敗時は既定の Utf8 のままのことがある
	/// </summary>
	public TextEncodingKind Encoding { get; init; }

	/// <summary>
	/// 保存後の代表改行。揃えなかったときは元の代表
	/// </summary>
	public EolKind PrimaryEol { get; init; }

	/// <summary>
	/// 保存後も改行が混在しているか。揃えたときは false
	/// </summary>
	public bool EolMixed { get; init; }

	/// <summary>
	/// 失敗理由。成功時は null
	/// </summary>
	public string? Message { get; init; }
}

/// <summary>
/// ファイルを開くダイアログの結果。キャンセルではファイルを読まない
/// </summary>
internal sealed class OpenFileDialogResult
{
	/// <summary>
	/// ユーザーがキャンセルした、またはパスが空だったとき true
	/// </summary>
	public bool Canceled { get; init; }

	/// <summary>
	/// 読み込んだファイル。キャンセル時は null
	/// </summary>
	public TextFileInfo? File { get; init; }
}

/// <summary>
/// 名前を付けて保存、またはエクスポート先ダイアログの結果。この時点ではファイルを書かない
/// </summary>
internal sealed class SaveAsDialogResult
{
	/// <summary>
	/// キャンセル、またはパスが空のとき true
	/// </summary>
	public bool Canceled { get; init; }

	/// <summary>
	/// 選ばれたパス。キャンセル時は null
	/// </summary>
	public string? FilePath { get; init; }
}

/// <summary>
/// HTML や PDF の出力、印刷画面を開いた結果
/// キャンセルと失敗は別のフラグで、どちらも例外にしない
/// </summary>
internal sealed class ExportActionResult
{
	/// <summary>
	/// 出力または印刷を開始できたか。キャンセル時は false
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// ユーザーが保存先や印刷をキャンセルしたとき true
	/// </summary>
	public bool Canceled { get; init; }

	/// <summary>
	/// 失敗理由。成功とキャンセルでは null のことがある
	/// </summary>
	public string? Message { get; init; }
}

/// <summary>
/// 画像を Data URL として読んだ結果。失敗時は Ok が false で Error に理由を入れる
/// </summary>
internal sealed class ReadImageResult
{
	/// <summary>
	/// Data URL を返せたか
	/// </summary>
	public bool Ok { get; init; }

	/// <summary>
	/// data: で始まる URL。失敗時は null
	/// </summary>
	public string? DataUrl { get; init; }

	/// <summary>
	/// 解決したローカルパス。埋め込みやリモートでは null
	/// </summary>
	public string? ResolvedPath { get; init; }

	/// <summary>
	/// 失敗理由。成功時は null
	/// </summary>
	public string? Error { get; init; }
}

/// <summary>
/// エディタへ挿入する貼り付け結果。失敗は例外にせず Error で返す
/// Kind は text、table、image、empty のいずれか
/// </summary>
internal sealed class PasteForEditorResult
{
	/// <summary>
	/// 挿入してよいか。false のとき Text は空で、Error に理由がある
	/// </summary>
	public bool Ok { get; init; }

	/// <summary>
	/// 挿入内容の種別。失敗時と空のクリップボードは empty
	/// </summary>
	public string Kind { get; init; } = "empty";

	/// <summary>
	/// 挿入する Markdown またはプレーンテキスト。失敗時は空文字
	/// </summary>
	public string Text { get; init; } = string.Empty;

	/// <summary>
	/// 失敗理由。成功時は null
	/// </summary>
	public string? Error { get; init; }
}

/// <summary>
/// フォルダ選択ダイアログの結果。キャンセル時は Path が空
/// </summary>
internal sealed class PickFolderResult
{
	/// <summary>
	/// キャンセル、またはパスが空のとき true
	/// </summary>
	public bool Canceled { get; init; }

	/// <summary>
	/// 選ばれたフォルダ。キャンセル時は空文字
	/// </summary>
	public string Path { get; init; } = string.Empty;
}

/// <summary>
/// 最近使ったファイルの一覧。新しいものが先頭。空白のパスは含めない
/// </summary>
internal sealed class RecentFilesResponse
{
	/// <summary>
	/// 絶対パスの一覧。0 件のときは空。最大件数は追加時に 15 で切る
	/// </summary>
	public IReadOnlyList<string> Files { get; init; } = [];
}

/// <summary>
/// ウィンドウタイトル更新の受付結果。タイトル文字列の検証はしない
/// </summary>
internal sealed class WindowTitleResult
{
	/// <summary>
	/// 更新を受け付けたか。既定は true
	/// </summary>
	public bool Success { get; init; } = true;
}

/// <summary>
/// 未保存確認のあと、ネイティブウィンドウを閉じてよいか
/// </summary>
internal sealed class CloseDecisionResult
{
	/// <summary>
	/// true のときシェルは閉じる処理を再開する。false のときはウィンドウを開いたままにする
	/// </summary>
	public bool AllowClose { get; init; }
}
