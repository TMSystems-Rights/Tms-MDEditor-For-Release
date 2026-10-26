// ==============================================
// 起動引数から開くファイルを分ける
// ==============================================

// 切り離し用の転送ファイルとウィンドウオプションを、開く Markdown のパスから除く

using System.Drawing;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリの実ファイルを引数に渡し、オプションと開くパスの分離を固定する
/// ディレクトリを作れないときは、各テストの前に失敗する
/// </summary>
public sealed class StartupArgumentsTests : IDisposable
{
	/// <summary>
	/// 起動引数に渡す実ファイルを置く一時ディレクトリ
	/// フィールド初期化でパスを決め、コンストラクタで作り、Dispose で削除する
	/// </summary>
	private readonly string _directory = Path.Combine(Path.GetTempPath(), $"TmsMdEditorStartupArguments-{Guid.NewGuid():N}");

	/// <summary>
	/// 引数に渡すファイルを置く一時ディレクトリを作る
	/// </summary>
	public StartupArgumentsTests() => Directory.CreateDirectory(_directory);

	/// <summary>
	/// 切り離し用の転送ファイルとオプションを除いたパスだけを開き、同じ引数から強制別ウィンドウ、転送ファイル、座標も読める
	/// </summary>
	[Fact]
	public void ResolveFilePaths_excludes_detach_transfer_file_and_options()
	{
		// 開く対象として残す実在の Markdown。中身は読まない
		string markdownPath = Path.Combine(_directory, "表示対象.md");
		// 開く対象から除く、切り離し用の転送ファイル。中身は空の JSON
		string transferPath = Path.Combine(_directory, "transfer.json");
		File.WriteAllText(markdownPath, "本文");
		File.WriteAllText(transferPath, "{}");

		// オプションと転送ファイルを除いた、開くパス。Markdown だけが残る
		string[] paths = StartupArguments.ResolveFilePaths(["--force-new-window", "--detached-tab", transferPath, "--window-x", "123", "--window-y", "456", markdownPath]);

		Assert.Equal([Path.GetFullPath(markdownPath)], paths);
		Assert.True(StartupArguments.IsForceNewWindow(["--FORCE-NEW-WINDOW"]));
		Assert.Equal(transferPath, StartupArguments.GetDetachedTabPath(["--detached-tab", transferPath]));
		Assert.Equal(new Point(123, 456), StartupArguments.GetDetachedWindowPoint(["--window-x", "123", "--window-y", "456"]));
	}

	/// <summary>
	/// 一時ディレクトリが残っていれば、中身ごと削除する
	/// </summary>
	public void Dispose()
	{
		// 一時ディレクトリが残っているときだけ中身ごと削除する。無いときは何もしない
		if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
	}
}
