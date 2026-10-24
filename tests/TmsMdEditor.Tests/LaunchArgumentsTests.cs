// ==============================================
// ポータブル起動スタブの引数正規化
// ==============================================

// ポータブル起動用の表示名と、存在するファイルを絶対パスにして本体へ渡す引数を固定する

using System.Diagnostics;
using TmsMdEditor.PortableLauncher;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリの実ファイルで引数の正規化を見る
/// バージョン情報のケースは、テストの出力先に本体とポータブル起動用の exe があるときに読む
/// </summary>
public sealed class LaunchArgumentsTests : IDisposable
{
	/// <summary>
	/// 正規化に渡す実ファイルを置く一時ディレクトリ
	/// フィールド初期化でパスを決め、コンストラクタで作り、Dispose で削除する
	/// </summary>
	private readonly string _directory = Path.Combine(Path.GetTempPath(), $"TmsMdEditorLaunchArguments-{Guid.NewGuid():N}");

	/// <summary>
	/// 引数に渡すファイルを置く一時ディレクトリを作る
	/// </summary>
	public LaunchArgumentsTests() => Directory.CreateDirectory(_directory);

	/// <summary>
	/// ポータブル起動用の表示名は TMS-MDEditor.portable である
	/// </summary>
	[Fact]
	public void DisplayName_is_portable_product_label()
	{
		Assert.Equal("TMS-MDEditor.portable", LaunchArguments.DisplayName);
	}

	/// <summary>
	/// ポータブル起動用 exe のファイル説明と製品名は、ポータブル用の表示名と一致する
	/// </summary>
	[Fact]
	public void Portable_stub_version_resource_uses_portable_display_name()
	{
		// テストの出力先へコピーされた起動用 exe のバージョン情報を読む
		string exePath = Path.Combine(System.AppContext.BaseDirectory, "TmsMdEditor.Portable.exe");
		Assert.True(File.Exists(exePath), $"起動用 exe が見つかりません: {exePath}");

		FileVersionInfo info = FileVersionInfo.GetVersionInfo(exePath);
		Assert.Equal(LaunchArguments.DisplayName, info.FileDescription);
		Assert.Equal(LaunchArguments.DisplayName, info.ProductName);
	}

	/// <summary>
	/// 本体 exe のファイル説明と製品名は TMS-MDEditor である
	/// </summary>
	[Fact]
	public void Main_app_version_resource_uses_installer_display_name()
	{
		// テストの出力先へコピーされた本体 exe のバージョン情報を読む
		string exePath = Path.Combine(System.AppContext.BaseDirectory, "TmsMdEditor.exe");
		Assert.True(File.Exists(exePath), $"本体 exe が見つかりません: {exePath}");

		FileVersionInfo info = FileVersionInfo.GetVersionInfo(exePath);
		Assert.Equal("TMS-MDEditor", info.FileDescription);
		Assert.Equal("TMS-MDEditor", info.ProductName);
	}

	/// <summary>
	/// 存在するファイルは絶対パスにし、オプションはそのまま残す
	/// </summary>
	[Fact]
	public void Normalize_converts_existing_file_to_full_path()
	{
		string markdownPath = Path.Combine(_directory, "開く対象.md");
		File.WriteAllText(markdownPath, "本文");

		IReadOnlyList<string> forwarded = LaunchArguments.Normalize([markdownPath, "--force-new-window"]);

		Assert.Equal([Path.GetFullPath(markdownPath), "--force-new-window"], forwarded);
	}

	/// <summary>
	/// 引用符付きの存在するファイルは絶対パスにし、無いパスは引用符を外した文字列のまま残す
	/// </summary>
	[Fact]
	public void Normalize_keeps_missing_path_and_strips_quotes_on_existing_file()
	{
		string markdownPath = Path.Combine(_directory, "quoted.md");
		File.WriteAllText(markdownPath, "本文");

		IReadOnlyList<string> forwarded = LaunchArguments.Normalize(["\"" + markdownPath + "\"", "missing-file.md"]);

		Assert.Equal([Path.GetFullPath(markdownPath), "missing-file.md"], forwarded);
	}

	/// <summary>
	/// 引数が無いときは空の列を返す
	/// </summary>
	[Fact]
	public void Normalize_returns_empty_when_no_args()
	{
		Assert.Empty(LaunchArguments.Normalize([]));
	}

	/// <summary>
	/// 一時ディレクトリが残っていれば、中身ごと削除する
	/// </summary>
	public void Dispose()
	{
		if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
	}
}
