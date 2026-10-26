// ==============================================
// 設定文書と更新結果の型を置く
// ==============================================

// app-config.json が dataDir を指し、config.json が画面と編集の設定を持つ
// 読込に失敗しても既定値の文書を返し、理由は結果のメッセージに残す

using System.Text.Json.Serialization;

namespace TmsMdEditor.Models;

/// <summary>
/// 本体より先に読む app-config.json。config.json の場所だけを持ち、画面設定は持たない
/// ポータブル版では dataDir を本体横の既定位置へ戻し、移行待ちも消す
/// </summary>
internal sealed class BootstrapConfigDocument
{
	/// <summary>
	/// app-config.json の形式版。保存時に現行版へ揃える。0 以下は壊れた文書として扱わないよう、ストアが正規化する
	/// </summary>
	public int SchemaVersion { get; set; } = 1;

	/// <summary>
	/// 設定とセッションを置くフォルダの絶対パス。空のときは既定のデータフォルダ
	/// </summary>
	public string DataDir { get; set; } = string.Empty;

	/// <summary>
	/// データ保存先の移行が途中のとき、まだ移し終えていない元フォルダ。空なら移行待ちは無い
	/// ポータブル版では空のままにする
	/// </summary>
	public string PendingMigrationSourceDir { get; set; } = string.Empty;
}

/// <summary>
/// 画面と編集の設定を持つ config.json。dataDir 自体はこの文書に含めない
/// 保存に失敗したメモリ上の差し替えは、呼び出し側が Success を見てから行う
/// </summary>
internal sealed class AppConfigDocument
{
	/// <summary>
	/// config.json の形式版。保存時に現行版へ上げる。古い版は読込時に不足項目を補う
	/// </summary>
	public int SchemaVersion { get; set; } = 1;

	/// <summary>
	/// 前回終了時のウィンドウサイズ。設定のリセット対象にはしない
	/// </summary>
	public WindowConfig Window { get; set; } = new();

	/// <summary>
	/// テーマ、フォント、キー、更新などのユーザー設定。項目単位で既定値へ戻せる
	/// </summary>
	public AppSettings Settings { get; set; } = new();

	/// <summary>
	/// ライブプレビューのカスタム装飾。不正な正規表現は保存したまま、Web 層が適用時にスキップする
	/// </summary>
	public List<CustomDecorationRule> CustomDecorations { get; set; } = [];

	/// <summary>
	/// 最近使ったファイルの絶対パス。先頭が新しい。追加時に 15 件を超えた古いものから捨てる
	/// </summary>
	public List<string> RecentFiles { get; set; } = [];
}

/// <summary>
/// メインウィンドウの外側サイズ。読込時に幅 600 から 4096、高さ 400 から 4096 ピクセルへ収める
/// </summary>
internal sealed class WindowConfig
{
	/// <summary>
	/// 通常表示の外側の幅。ピクセル。既定は 1000。最大化中に保存する値は RestoreBounds の幅
	/// </summary>
	public int Width { get; set; } = 1000;

	/// <summary>
	/// 通常表示の外側の高さ。ピクセル。既定は 700。最大化中に保存する値は RestoreBounds の高さ
	/// </summary>
	public int Height { get; set; } = 700;

	/// <summary>
	/// 前回、最大化して閉じたか。true のとき次回も最大化で開く
	/// </summary>
	public bool Maximized { get; set; }
}

/// <summary>
/// エディタとシェルが読むユーザー設定。未知の文字列は読込時に既定値へ戻す
/// </summary>
internal sealed class AppSettings
{
	/// <summary>
	/// 画面テーマ。system、dark、light のいずれか。それ以外は読込時に system へ戻る
	/// </summary>
	public string Theme { get; set; } = "system";

	/// <summary>
	/// エディタ本文の CSS font-family。空白は既定のスタックへ戻る
	/// </summary>
	public string EditorFontFamily { get; set; } = "\"Consolas\", \"BIZ UDゴシック\", monospace";

	/// <summary>
	/// ライブプレビューのコードブロック・インラインコード用フォント
	/// </summary>
	public string CodeFontFamily { get; set; } = "Consolas, \"Cascadia Mono\", \"Meiryo UI\", monospace";

	/// <summary>
	/// エディタ本文のフォントサイズ。ピクセル。読込時に 8 から 72 へ収める。既定は 15
	/// </summary>
	public int EditorFontSize { get; set; } = 15;

	/// <summary>
	/// 行番号を表示するか。既定は表示する
	/// </summary>
	public bool ShowLineNumbers { get; set; } = true;

	/// <summary>
	/// 改行コード記号の表示。未設定時は Normalize で true（既定 ON）
	/// </summary>
	public bool? ShowEolMarkers { get; set; } = true;

	/// <summary>
	/// エディタの折り返し。既定は折り返す
	/// </summary>
	public bool WordWrap { get; set; } = true;

	/// <summary>
	/// 新しいタブの表示モード。live-preview または source。それ以外は live-preview へ戻る
	/// </summary>
	public string DefaultViewMode { get; set; } = "live-preview";

	/// <summary>
	/// タブ文字の表示幅。スペース換算の文字数。読込時に 1 から 8。既定は 4
	/// </summary>
	public int TabSize { get; set; } = 4;

	/// <summary>
	/// 大きいファイルとみなすサイズ。MB。1 MB は 1024×1024 バイトとして比較する。読込時に 1 から 100。既定は 2
	/// </summary>
	public int LargeFileThresholdMb { get; set; } = 2;

	/// <summary>
	/// リモートの画像をライブプレビューで取得するか。既定は取得する
	/// </summary>
	public bool LoadRemoteImages { get; set; } = true;

	/// <summary>
	/// クリップボード画像の保存先。空ならピクチャ配下の既定フォルダを使う
	/// </summary>
	public string AttachmentFolder { get; set; } = string.Empty;

	/// <summary>
	/// ライブプレビュー画像の枠線。幅 0 は枠を出さない
	/// </summary>
	public ImageBorderSettings ImageBorder { get; set; } = new();

	/// <summary>
	/// 新規ファイルの文字コード名。空白は utf8 へ戻る。未知の名前は、その設定でファイルを書くときに失敗する
	/// </summary>
	public string NewFileEncoding { get; set; } = "utf8";

	/// <summary>
	/// 新規ファイルの改行。crlf または lf。それ以外は crlf へ戻る
	/// </summary>
	public string NewFileEol { get; set; } = "crlf";

	/// <summary>
	/// 外部変更の扱い。auto-reload または confirm。それ以外は auto-reload へ戻る
	/// </summary>
	public string ExternalChangeBehavior { get; set; } = "auto-reload";

	/// <summary>
	/// 起動済みプロセスの扱い。single-instance は既存ウィンドウへ渡し、new-window は別プロセスを残す
	/// それ以外は single-instance へ戻る
	/// </summary>
	public string InstanceMode { get; set; } = "single-instance";

	/// <summary>
	/// 主ウィンドウの起動時に、前回のタブ構成を開くか。既定は開かない。副ウィンドウは見ない
	/// </summary>
	public bool RestoreSessionOnStartup { get; set; }

	/// <summary>
	/// 最後のタブを閉じたときアプリも終了するか。既定は終了しない。判断は Web 層が行う
	/// </summary>
	public bool CloseAppWhenLastTabClosed { get; set; }

	/// <summary>
	/// アウトラインの表示位置と幅
	/// </summary>
	public OutlineSettings Outline { get; set; } = new();

	/// <summary>
	/// HTML 出力の見た目。印刷向けの clean は値として残るが、出力には使わない
	/// </summary>
	public ExportSettings Export { get; set; } = new();

	/// <summary>
	/// http と https を開くブラウザ
	/// </summary>
	public ExternalBrowserSettings ExternalBrowser { get; set; } = new();

	/// <summary>
	/// 起動時の更新確認と、通知をスキップするバージョン
	/// </summary>
	public UpdateSettings Update { get; set; } = new();

	/// <summary>
	/// 有効な CSS スニペットのファイル名
	/// </summary>
	public CssSnippetsSettings CssSnippets { get; set; } = new();

	/// <summary>
	/// メニューと Web 層が共有するショートカット表記
	/// </summary>
	public KeybindingsSettings Keybindings { get; set; } = new();

	/// <summary>
	/// 検索移動のあと、折りたたみを戻すか
	/// </summary>
	public SearchSettings Search { get; set; } = new();

	/// <summary>
	/// エディタとタブのコンテキストメニューに出す項目の順序
	/// </summary>
	public ContextMenuSettings ContextMenu { get; set; } = new();
}

/// <summary>
/// ライブプレビュー画像の枠線。幅はピクセルで、通常は 0 から 8、ホバーは 0 から 16 へ読込時に収める
/// </summary>
internal sealed class ImageBorderSettings
{
	/// <summary>
	/// 通常時の枠幅。ピクセル。0 は枠なし。既定は 1
	/// </summary>
	public int Width { get; set; } = 1;

	/// <summary>
	/// 通常時の枠色。#RRGGBB。空や不正な値は読込時に #888888 へ戻る
	/// </summary>
	public string Color { get; set; } = "#888888";

	/// <summary>
	/// ホバー時の枠幅。ピクセル。既定は 3
	/// </summary>
	public int HoverWidth { get; set; } = 3;

	/// <summary>
	/// ホバー時の枠線色。空ならテーマのアクセント色を使う
	/// </summary>
	public string HoverColor { get; set; } = string.Empty;
}

/// <summary>
/// 右クリックメニューの項目 ID と、隠す ID。未知の ID は並びのまま保存し、表示側が解釈する
/// </summary>
internal sealed class ContextMenuSettings
{
	/// <summary>
	/// エディタのコンテキストメニューに出す項目 ID。上から順。区切りも ID として含む
	/// </summary>
	public List<string> EditorOrder { get; set; } =
	[
		"undo",
		"redo",
		"editorSeparatorClipboard",
		"cut",
		"copy",
		"paste",
		"pastePlain",
		"selectAll",
		"editorSeparatorSearch",
		"find",
		"replace",
		"editorSeparatorContext",
		"toggleCheckbox",
		"mergeTableCells",
		"unmergeTableCells",
		"openLink",
		"editorSeparatorView",
		"collapseAllHeadings",
		"expandAllHeadings",
		"toggleViewMode",
		"toggleOutline",
		"editorSeparatorSplit",
		"splitHorizontal",
		"splitVertical",
		"unsplit",
	];

	/// <summary>
	/// エディタメニューに出さない項目 ID。空なら並びにあるものをすべて出す
	/// </summary>
	public List<string> EditorHidden { get; set; } = [];

	/// <summary>
	/// タブのコンテキストメニューに出す項目 ID。上から順
	/// </summary>
	public List<string> TabOrder { get; set; } =
	[
		"toggleViewMode",
		"toggleOutline",
		"tabSeparatorSplit",
		"splitHorizontal",
		"splitVertical",
		"unsplit",
		"tabSeparatorClose",
		"close",
		"closeOthers",
		"closeRight",
		"tabSeparatorPath",
		"copyPath",
		"showInFolder",
	];

	/// <summary>
	/// タブメニューに出さない項目 ID。空なら並びにあるものをすべて出す
	/// </summary>
	public List<string> TabHidden { get; set; } = [];
}

/// <summary>
/// http と https の開き方。custom のときだけ CustomCommand を使い、空コマンドは起動時に失敗する
/// </summary>
internal sealed class ExternalBrowserSettings
{
	/// <summary>
	/// default は OS の既定、custom は CustomCommand。それ以外は default へ戻る
	/// </summary>
	public string Mode { get; set; } = "default";

	/// <summary>
	/// custom のときに起動するコマンド。実行ファイルと、URL より前の引数。空白はトリムする
	/// </summary>
	public string CustomCommand { get; set; } = string.Empty;
}

/// <summary>
/// 自動更新。ポータブル版は確認だけ行い、インストーラーは取得しない
/// </summary>
internal sealed class UpdateSettings
{
	/// <summary>
	/// 起動時に 1 日 1 回、更新を確認するか。既定は確認する
	/// </summary>
	public bool CheckOnStartup { get; set; } = true;

	/// <summary>
	/// 起動時の通知から外すバージョン。空なら除外は無い。大文字小文字は区別しない
	/// </summary>
	public string SkippedVersion { get; set; } = string.Empty;

	/// <summary>
	/// 最後に確認した日時。ISO 8601。空や解釈できない値のときは、次の起動で確認する
	/// </summary>
	public string LastCheckedAt { get; set; } = string.Empty;
}

/// <summary>
/// dataDir 配下の CSS スニペットのうち、適用するもの。ファイルが無くても名前は残る
/// </summary>
internal sealed class CssSnippetsSettings
{
	/// <summary>
	/// 有効なスニペットのファイル名。空白は読込時に除き、大文字小文字の違いは 1 件にまとめる
	/// </summary>
	public List<string> Enabled { get; set; } = [];
}

/// <summary>
/// 検索で移動したあとの折りたたみの戻し方。置換文字列は持たない
/// 項目が無い古い設定では false で、展開したコールアウトは戻さない
/// </summary>
internal sealed class SearchSettings
{
	/// <summary>
	/// 検索移動で自動展開したコールアウトを、移動前の折りたたみ状態へ戻す
	/// </summary>
	public bool RestoreCalloutFoldStateOnMove { get; set; }
}

/// <summary>
/// メニュー表示と Web 層が読むショートカット表記。空白は読込時に各プロパティの既定へ戻る
/// </summary>
internal sealed class KeybindingsSettings
{
	/// <summary>
	/// 新規タブを作るショートカット。既定は Ctrl+N
	/// </summary>
	public string NewFile { get; set; } = "Ctrl+N";

	/// <summary>
	/// ファイルを開くショートカット。既定は Ctrl+O
	/// </summary>
	public string OpenFile { get; set; } = "Ctrl+O";

	/// <summary>
	/// 上書き保存のショートカット。既定は Ctrl+S
	/// </summary>
	public string Save { get; set; } = "Ctrl+S";

	/// <summary>
	/// 名前を付けて保存のショートカット。既定は Ctrl+Shift+S
	/// </summary>
	public string SaveAs { get; set; } = "Ctrl+Shift+S";

	/// <summary>
	/// 現在のタブを閉じるショートカット。既定は Ctrl+W。メニュー表示の対象外
	/// </summary>
	public string CloseTab { get; set; } = "Ctrl+W";

	/// <summary>
	/// 次のタブへ移るショートカット。既定は Ctrl+Tab
	/// </summary>
	public string NextTab { get; set; } = "Ctrl+Tab";

	/// <summary>
	/// 前のタブへ移るショートカット。既定は Ctrl+Shift+Tab
	/// </summary>
	public string PrevTab { get; set; } = "Ctrl+Shift+Tab";

	/// <summary>
	/// 検索パネルを開くショートカット。既定は Ctrl+F
	/// </summary>
	public string Find { get; set; } = "Ctrl+F";

	/// <summary>
	/// 置換パネルを開くショートカット。既定は Ctrl+R
	/// </summary>
	public string Replace { get; set; } = "Ctrl+R";

	/// <summary>
	/// 次の一致へ移るショートカット。既定は F3
	/// </summary>
	public string FindNext { get; set; } = "F3";

	/// <summary>
	/// 前の一致へ移るショートカット。既定は Shift+F3
	/// </summary>
	public string FindPrev { get; set; } = "Shift+F3";

	/// <summary>
	/// ソースとライブプレビューを切り替えるショートカット。既定は Ctrl+E
	/// </summary>
	public string ToggleViewMode { get; set; } = "Ctrl+E";

	/// <summary>
	/// アウトラインの表示を切り替えるショートカット。既定は Ctrl+Shift+O
	/// </summary>
	public string ToggleOutline { get; set; } = "Ctrl+Shift+O";

	/// <summary>
	/// ペインを上下に分割するショートカット。既定は Ctrl+Shift+-
	/// </summary>
	public string SplitHorizontal { get; set; } = "Ctrl+Shift+-";

	/// <summary>
	/// ペインを左右に分割するショートカット。既定は Ctrl+Shift+\
	/// </summary>
	public string SplitVertical { get; set; } = "Ctrl+Shift+\\";

	/// <summary>
	/// 分割を解除するショートカット。既定は Ctrl+Shift+U
	/// </summary>
	public string Unsplit { get; set; } = "Ctrl+Shift+U";

	/// <summary>
	/// チェックボックスを切り替えるショートカット。既定は Ctrl+Enter
	/// </summary>
	public string ToggleCheckbox { get; set; } = "Ctrl+Enter";

	/// <summary>
	/// HTML エクスポートのショートカット。既定は Ctrl+Shift+H
	/// </summary>
	public string ExportHtml { get; set; } = "Ctrl+Shift+H";

	/// <summary>
	/// PDF エクスポートのショートカット。既定は Ctrl+Shift+P
	/// </summary>
	public string ExportPdf { get; set; } = "Ctrl+Shift+P";

	/// <summary>
	/// 印刷のショートカット。既定は Ctrl+P
	/// </summary>
	public string Print { get; set; } = "Ctrl+P";

	/// <summary>
	/// 書式を付けずに貼り付けるショートカット。既定は Ctrl+Shift+V
	/// </summary>
	public string PastePlain { get; set; } = "Ctrl+Shift+V";
}

/// <summary>
/// 編集画面のアウトラインペイン。HTML 出力のアウトラインとは別で、幅はピクセル
/// </summary>
internal sealed class OutlineSettings
{
	/// <summary>
	/// ウィンドウ起動時にアウトラインを表示するか
	/// </summary>
	public bool Visible { get; set; } = true;

	/// <summary>
	/// アウトラインを置く側。left または right。それ以外は right へ戻る
	/// </summary>
	public string Side { get; set; } = "right";

	/// <summary>
	/// アウトラインペインの幅。ピクセル。既定は 300
	/// </summary>
	public int Width { get; set; } = 300;
}

/// <summary>
/// HTML 出力のアウトライン。Side は互換のため残す（位置は出力 HTML 内の切り替え）
/// </summary>
internal sealed class ExportOutlineSettings
{
	/// <summary>
	/// HTML にアウトラインを出すか。既定は出す
	/// </summary>
	public bool Enabled { get; set; } = true;

	/// <summary>
	/// 互換のために残す左右の指定。left または right。出力位置の切り替えは HTML 側が行う
	/// </summary>
	public string Side { get; set; } = "right";
}

/// <summary>
/// エクスポート設定。Style は互換のため残す（印刷向けクリーン文書は未提供で出力には使わない）
/// </summary>
internal sealed class ExportSettings
{
	/// <summary>
	/// 出力スタイル。live-preview または clean。clean は保存できるが、出力には使わない
	/// </summary>
	public string Style { get; set; } = "live-preview";

	/// <summary>
	/// HTML 出力に含める見出し一覧。画面のアウトライン設定とは別
	/// </summary>
	public ExportOutlineSettings Outline { get; set; } = new();
}

/// <summary>
/// ライブプレビューで正規表現に一致した範囲へ CSS クラスを付ける規則
/// 不正な正規表現やクラス名は保存し、適用時に Web 層がスキップする
/// </summary>
internal sealed class CustomDecorationRule
{
	/// <summary>
	/// 設定画面に出す規則の名前。空でも保存できる
	/// </summary>
	public string Name { get; set; } = string.Empty;

	/// <summary>
	/// この規則を適用するか。false のときはパターンが不正でもスキップし、エラーにしない
	/// </summary>
	public bool Enabled { get; set; } = true;

	/// <summary>
	/// 装飾する範囲の正規表現。空や構文エラーは適用しない
	/// </summary>
	public string Pattern { get; set; } = string.Empty;

	/// <summary>
	/// 一致範囲の両端にある区切り文字をライブプレビューで隠すか。既定は隠さない
	/// </summary>
	public bool HideDelimiters { get; set; }

	/// <summary>
	/// 一致範囲へ付ける CSS クラス名。英字かアンダースコアで始まり、以降は英数字、アンダースコア、ハイフンだけを適用する
	/// </summary>
	public string CssClass { get; set; } = string.Empty;
}

/// <summary>
/// config.json の読込結果。失敗でも Config には既定値か読めた文書が入る
/// </summary>
internal sealed class LoadConfigResult
{
	/// <summary>
	/// 目的のファイルを読めたか。バックアップからの復旧も true。dataDir が無いときは false
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// 採用した設定。失敗時は既定値。呼び出し側はこれをメモリへ載せる
	/// </summary>
	public AppConfigDocument Config { get; init; } = new();

	/// <summary>
	/// ユーザーへ見せる読込メッセージ。問題が無ければ null
	/// </summary>
	public string? Message { get; init; }

	/// <summary>
	/// 本体が読めず、バックアップから復旧したとき true。Success も true になる
	/// </summary>
	public bool RecoveredFromBackup { get; init; }
}

/// <summary>
/// 設定保存の結果。失敗時はディスクもメモリ上の Config も変えない
/// </summary>
internal sealed class SaveConfigResult
{
	/// <summary>
	/// ファイルへ書けたか
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// 保存後にメモリへ載せる文書。失敗時は null
	/// </summary>
	public AppConfigDocument? Config { get; init; }

	/// <summary>
	/// 失敗理由。成功時は null
	/// </summary>
	public string? Message { get; init; }
}

/// <summary>
/// 現在と既定のデータ保存先。ポータブル版では変更できない
/// </summary>
internal sealed class DataDirInfo
{
	/// <summary>
	/// いま使っているデータフォルダの絶対パス
	/// </summary>
	public string DataDir { get; init; } = string.Empty;

	/// <summary>
	/// インストール形態ごとの既定フォルダ。設定を戻すときの比較に使う
	/// </summary>
	public string DefaultDataDir { get; init; } = string.Empty;

	/// <summary>
	/// ポータブル版か。true のとき保存先の変更は拒否する
	/// </summary>
	public bool IsPortable { get; init; }
}

/// <summary>
/// データ保存先を移した結果。失敗時は元の場所のまま
/// </summary>
internal sealed class MigrateDataDirResult
{
	/// <summary>
	/// 移動と設定の更新ができたか。ポータブル版とキャンセルは false
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// 移動後のフォルダ。失敗時は null
	/// </summary>
	public string? DataDir { get; init; }

	/// <summary>
	/// 失敗理由。成功時は null
	/// </summary>
	public string? Message { get; init; }
}

/// <summary>
/// 1 件の CSS スニペット。読めないファイルは CssText が空で Error に理由を入れる
/// </summary>
internal sealed class CssSnippetInfo
{
	/// <summary>
	/// ファイル名。有効一覧と突き合わせるキー
	/// </summary>
	public string Name { get; init; } = string.Empty;

	/// <summary>
	/// 設定で有効になっているか。ファイルが読めなくてもフラグは残る
	/// </summary>
	public bool Enabled { get; init; }

	/// <summary>
	/// ファイル本文。読込失敗時は空文字
	/// </summary>
	public string CssText { get; init; } = string.Empty;

	/// <summary>
	/// 読込失敗の理由。読めたときは null
	/// </summary>
	public string? Error { get; init; }
}

/// <summary>
/// CSS スニペットのフォルダと、その中のファイル一覧。フォルダが無いときは Error を入れ、一覧は空
/// </summary>
internal sealed class CssSnippetsResponse
{
	/// <summary>
	/// スニペットを置くフォルダの絶対パス
	/// </summary>
	public string DirectoryPath { get; init; } = string.Empty;

	/// <summary>
	/// フォルダを読めない理由。読めたときは null
	/// </summary>
	public string? Error { get; init; }

	/// <summary>
	/// フォルダ内のスニペット。0 件のときは空
	/// </summary>
	public List<CssSnippetInfo> Snippets { get; init; } = [];
}

/// <summary>
/// 更新確認の結果。通信失敗は例外にせず Status を error にする
/// </summary>
internal sealed class UpdateCheckResult
{
	/// <summary>
	/// available、not-available、error のいずれか。未設定の初期値は error
	/// </summary>
	public string Status { get; init; } = "error";

	/// <summary>
	/// いま動いているアプリのバージョン。比較に使った表記
	/// </summary>
	public string CurrentVersion { get; init; } = string.Empty;

	/// <summary>
	/// 取得した最新リリース。error のときは null。not-available でも最新の情報は入る
	/// </summary>
	public UpdateReleaseInfo? Release { get; init; }

	/// <summary>
	/// 失敗理由。成功時は null
	/// </summary>
	public string? Message { get; init; }

	/// <summary>
	/// installer はインストーラーを取得できる確認、portable はタグ名だけの確認
	/// </summary>
	public string Mode { get; init; } = "installer";
}

/// <summary>
/// GitHub Release から取った 1 件の更新情報。ポータブル確認ではインストーラー項目が空のことがある
/// </summary>
internal sealed class UpdateReleaseInfo
{
	/// <summary>
	/// 比較に使うバージョン。タグ名からビルド番号を除いた表記
	/// </summary>
	public string Version { get; init; } = string.Empty;

	/// <summary>
	/// GitHub のタグ名。表示と、ポータブル版の比較に使う
	/// </summary>
	public string TagName { get; init; } = string.Empty;

	/// <summary>
	/// リリースノートのページ URL
	/// </summary>
	public string ReleaseUrl { get; init; } = string.Empty;

	/// <summary>
	/// インストーラー資産のファイル名。ポータブル確認では空
	/// </summary>
	public string InstallerName { get; init; } = string.Empty;

	/// <summary>
	/// インストーラー資産の ID。0 以下は未取得
	/// </summary>
	public long InstallerAssetId { get; init; }

	/// <summary>
	/// インストーラーのダウンロード URL。資産 ID が無いときの取得先
	/// </summary>
	public string InstallerDownloadUrl { get; init; } = string.Empty;

	/// <summary>
	/// インストーラーのサイズ。バイト。不明なときは 0
	/// </summary>
	public long InstallerSize { get; init; }

	/// <summary>
	/// リリースノートから取り出した SHA-256。16 進 64 文字。無いときは null で、そのときはハッシュ検証をしない
	/// </summary>
	public string? Sha256 { get; init; }
}

/// <summary>
/// インストーラー取得の途中経過。バイト数と、全体が分かるときの百分率
/// </summary>
internal sealed class UpdateDownloadProgress
{
	/// <summary>
	/// ここまでに書いたバイト数
	/// </summary>
	public long DownloadedBytes { get; init; }

	/// <summary>
	/// 全体のバイト数。不明なときは 0
	/// </summary>
	public long TotalBytes { get; init; }

	/// <summary>
	/// 完了の割合。0 から 100。全体が不明なときは 0 のまま進むことがある
	/// </summary>
	public int Percent { get; init; }
}

/// <summary>
/// インストーラー取得の結果。キャンセルは Success が false で Cancelled が true
/// </summary>
internal sealed class UpdateDownloadResult
{
	/// <summary>
	/// 検証済みファイルを用意できたか
	/// </summary>
	public bool Success { get; init; }

	/// <summary>
	/// ユーザーか新しい取得で中止したとき true。このときはエラーイベントを出さない
	/// </summary>
	public bool Cancelled { get; init; }

	/// <summary>
	/// 検証済みインストーラーのパス。失敗時は null
	/// </summary>
	public string? InstallerPath { get; init; }

	/// <summary>
	/// 失敗理由や、取得しなかった理由。成功時は null
	/// </summary>
	public string? Message { get; init; }
}

/// <summary>
/// config:get の応答。メモリ上の設定と、保存先の情報をまとめて返す
/// </summary>
internal sealed class ConfigGetResponse
{
	/// <summary>
	/// メモリ上の設定文書。この応答のためにはディスクを読み直さない
	/// </summary>
	public AppConfigDocument Config { get; init; } = new();

	/// <summary>
	/// 現在と既定のデータ保存先
	/// </summary>
	public DataDirInfo DataDirInfo { get; init; } = new();

	/// <summary>
	/// ポータブル版か。設定文書の外で、実行ファイルの配置から決まる
	/// </summary>
	public bool IsPortable { get; init; }

	/// <summary>
	/// 添付フォルダを空にしたときに使う既定フォルダ。設定値そのものではない
	/// </summary>
	public string DefaultAttachmentFolder { get; init; } = string.Empty;
}
