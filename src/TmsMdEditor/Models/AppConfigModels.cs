using System.Text.Json.Serialization;

namespace TmsMdEditor.Models;

/// <summary>
/// ブートストラップ設定（app-config.json）
/// </summary>
internal sealed class BootstrapConfigDocument
{
	public int SchemaVersion { get; set; } = 1;

	public string DataDir { get; set; } = string.Empty;

	public string PendingMigrationSourceDir { get; set; } = string.Empty;
}

/// <summary>
/// アプリケーション設定（config.json）
/// </summary>
internal sealed class AppConfigDocument
{
	public int SchemaVersion { get; set; } = 1;

	public WindowConfig Window { get; set; } = new();

	public AppSettings Settings { get; set; } = new();

	public List<CustomDecorationRule> CustomDecorations { get; set; } = [];

	public List<string> RecentFiles { get; set; } = [];
}

/// <summary>
/// ウィンドウ状態
/// </summary>
internal sealed class WindowConfig
{
	public int Width { get; set; } = 1000;

	public int Height { get; set; } = 700;

	public bool Maximized { get; set; }
}

/// <summary>
/// ユーザー設定
/// </summary>
internal sealed class AppSettings
{
	public string Theme { get; set; } = "system";

	public string EditorFontFamily { get; set; } = "\"Consolas\", \"BIZ UDゴシック\", monospace";

	/// <summary>
	/// ライブプレビューのコードブロック・インラインコード用フォント
	/// </summary>
	public string CodeFontFamily { get; set; } = "Consolas, \"Cascadia Mono\", \"Meiryo UI\", monospace";

	public int EditorFontSize { get; set; } = 15;

	public bool ShowLineNumbers { get; set; } = true;

	/// <summary>
	/// 改行コード記号の表示。未設定時は Normalize で true（既定 ON）
	/// </summary>
	public bool? ShowEolMarkers { get; set; } = true;

	public bool WordWrap { get; set; } = true;

	public string DefaultViewMode { get; set; } = "live-preview";

	public int TabSize { get; set; } = 4;

	public int LargeFileThresholdMb { get; set; } = 2;

	public bool LoadRemoteImages { get; set; } = true;

	public string NewFileEncoding { get; set; } = "utf8";

	public string NewFileEol { get; set; } = "crlf";

	public string ExternalChangeBehavior { get; set; } = "auto-reload";

	public string InstanceMode { get; set; } = "single-instance";

	public bool RestoreSessionOnStartup { get; set; }

	public bool CloseAppWhenLastTabClosed { get; set; }

	public OutlineSettings Outline { get; set; } = new();

	public ExportSettings Export { get; set; } = new();

	public ExternalBrowserSettings ExternalBrowser { get; set; } = new();

	public UpdateSettings Update { get; set; } = new();

	public CssSnippetsSettings CssSnippets { get; set; } = new();

	public KeybindingsSettings Keybindings { get; set; } = new();

	public SearchSettings Search { get; set; } = new();

	public ContextMenuSettings ContextMenu { get; set; } = new();
}

/// <summary>
/// コンテキストメニュー設定
/// </summary>
internal sealed class ContextMenuSettings
{
	public List<string> EditorOrder { get; set; } =
	[
		"undo",
		"redo",
		"editorSeparatorClipboard",
		"cut",
		"copy",
		"paste",
		"selectAll",
		"editorSeparatorSearch",
		"find",
		"replace",
		"editorSeparatorContext",
		"toggleCheckbox",
		"openLink",
		"editorSeparatorView",
		"toggleViewMode",
		"toggleOutline",
		"editorSeparatorSplit",
		"splitHorizontal",
		"splitVertical",
		"unsplit",
	];

	public List<string> EditorHidden { get; set; } = [];

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

	public List<string> TabHidden { get; set; } = [];
}

/// <summary>
/// 外部リンク起動設定
/// </summary>
internal sealed class ExternalBrowserSettings
{
	public string Mode { get; set; } = "default";

	public string CustomCommand { get; set; } = string.Empty;
}

/// <summary>
/// 自動更新設定
/// </summary>
internal sealed class UpdateSettings
{
	public bool CheckOnStartup { get; set; } = true;

	public string SkippedVersion { get; set; } = string.Empty;

	public string LastCheckedAt { get; set; } = string.Empty;
}

/// <summary>
/// CSS スニペット設定
/// </summary>
internal sealed class CssSnippetsSettings
{
	public List<string> Enabled { get; set; } = [];
}

/// <summary>
/// 検索・置換設定
/// </summary>
internal sealed class SearchSettings
{
	/// <summary>
	/// 検索移動で自動展開したコールアウトを、移動前の折りたたみ状態へ戻す
	/// </summary>
	public bool RestoreCalloutFoldStateOnMove { get; set; }
}

/// <summary>
/// キーバインド設定
/// </summary>
internal sealed class KeybindingsSettings
{
	public string NewFile { get; set; } = "Ctrl+N";

	public string OpenFile { get; set; } = "Ctrl+O";

	public string Save { get; set; } = "Ctrl+S";

	public string SaveAs { get; set; } = "Ctrl+Shift+S";

	public string CloseTab { get; set; } = "Ctrl+W";

	public string NextTab { get; set; } = "Ctrl+Tab";

	public string PrevTab { get; set; } = "Ctrl+Shift+Tab";

	public string Find { get; set; } = "Ctrl+F";

	public string Replace { get; set; } = "Ctrl+R";

	public string FindNext { get; set; } = "F3";

	public string FindPrev { get; set; } = "Shift+F3";

	public string ToggleViewMode { get; set; } = "Ctrl+E";

	public string ToggleOutline { get; set; } = "Ctrl+Shift+O";

	public string SplitHorizontal { get; set; } = "Ctrl+Shift+-";

	public string SplitVertical { get; set; } = "Ctrl+Shift+\\";

	public string Unsplit { get; set; } = "Ctrl+Shift+U";

	public string ToggleCheckbox { get; set; } = "Ctrl+Enter";

	public string ExportHtml { get; set; } = "Ctrl+Shift+H";

	public string ExportPdf { get; set; } = "Ctrl+Shift+P";

	public string Print { get; set; } = "Ctrl+P";
}

/// <summary>
/// アプリ画面のアウトライン配置
/// </summary>
internal sealed class OutlineSettings
{
	public string Side { get; set; } = "right";
}

/// <summary>
/// HTML 出力のアウトライン。Side は互換のため残す（位置は出力 HTML 内の切り替え）。
/// </summary>
internal sealed class ExportOutlineSettings
{
	public bool Enabled { get; set; } = true;

	public string Side { get; set; } = "right";
}

/// <summary>
/// エクスポート設定。Style は互換のため残す（印刷向けクリーン文書は未提供で出力には使わない）。
/// </summary>
internal sealed class ExportSettings
{
	public string Style { get; set; } = "live-preview";

	public ExportOutlineSettings Outline { get; set; } = new();
}

/// <summary>
/// カスタム装飾ルール
/// </summary>
internal sealed class CustomDecorationRule
{
	public string Name { get; set; } = string.Empty;

	public bool Enabled { get; set; } = true;

	public string Pattern { get; set; } = string.Empty;

	public bool HideDelimiters { get; set; }

	public string CssClass { get; set; } = string.Empty;
}

/// <summary>
/// 設定読込結果
/// </summary>
internal sealed class LoadConfigResult
{
	public bool Success { get; init; }

	public AppConfigDocument Config { get; init; } = new();

	public string? Message { get; init; }

	public bool RecoveredFromBackup { get; init; }
}

/// <summary>
/// 設定保存結果
/// </summary>
internal sealed class SaveConfigResult
{
	public bool Success { get; init; }

	public AppConfigDocument? Config { get; init; }

	public string? Message { get; init; }
}

/// <summary>
/// dataDir 参照情報
/// </summary>
internal sealed class DataDirInfo
{
	public string DataDir { get; init; } = string.Empty;

	public string DefaultDataDir { get; init; } = string.Empty;

	public bool IsPortable { get; init; }
}

/// <summary>
/// dataDir 移行結果
/// </summary>
internal sealed class MigrateDataDirResult
{
	public bool Success { get; init; }

	public string? DataDir { get; init; }

	public string? Message { get; init; }
}

/// <summary>
/// CSS スニペット情報
/// </summary>
internal sealed class CssSnippetInfo
{
	public string Name { get; init; } = string.Empty;

	public bool Enabled { get; init; }

	public string CssText { get; init; } = string.Empty;

	public string? Error { get; init; }
}

/// <summary>
/// CSS スニペット一覧応答
/// </summary>
internal sealed class CssSnippetsResponse
{
	public string DirectoryPath { get; init; } = string.Empty;

	public string? Error { get; init; }

	public List<CssSnippetInfo> Snippets { get; init; } = [];
}

/// <summary>
/// 更新確認の結果
/// </summary>
internal sealed class UpdateCheckResult
{
	public string Status { get; init; } = "error";

	public string CurrentVersion { get; init; } = string.Empty;

	public UpdateReleaseInfo? Release { get; init; }

	public string? Message { get; init; }

	public string Mode { get; init; } = "installer";
}

/// <summary>
/// GitHub Release から取得した更新情報
/// </summary>
internal sealed class UpdateReleaseInfo
{
	public string Version { get; init; } = string.Empty;

	public string TagName { get; init; } = string.Empty;

	public string ReleaseUrl { get; init; } = string.Empty;

	public string InstallerName { get; init; } = string.Empty;

	public long InstallerAssetId { get; init; }

	public string InstallerDownloadUrl { get; init; } = string.Empty;

	public long InstallerSize { get; init; }

	public string? Sha256 { get; init; }
}

/// <summary>
/// 更新ダウンロードの進捗
/// </summary>
internal sealed class UpdateDownloadProgress
{
	public long DownloadedBytes { get; init; }

	public long TotalBytes { get; init; }

	public int Percent { get; init; }
}

/// <summary>
/// 更新ダウンロードの結果
/// </summary>
internal sealed class UpdateDownloadResult
{
	public bool Success { get; init; }

	public bool Cancelled { get; init; }

	public string? InstallerPath { get; init; }

	public string? Message { get; init; }
}

/// <summary>
/// config:get 応答
/// </summary>
internal sealed class ConfigGetResponse
{
	public AppConfigDocument Config { get; init; } = new();

	public DataDirInfo DataDirInfo { get; init; } = new();

	public bool IsPortable { get; init; }
}
