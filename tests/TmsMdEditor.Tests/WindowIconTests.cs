// ==============================================
// ウィンドウアイコンの読み込み
// ==============================================

// exe の隣にある icon.ico をウィンドウアイコンにする。ファイルが無いときはアイコン無しで起動できる

using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 指定ディレクトリの icon.ico を読めることを固定する
/// 一時ディレクトリはテストごとに作り、リポジトリの icon.ico が無いと読めるケースは失敗する
/// </summary>
public sealed class WindowIconTests : IDisposable
{
	/// <summary>
	/// このテストが icon.ico を置く一時ディレクトリ
	/// コンストラクタで作り、Dispose で削除する
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// 空の一時ディレクトリを作る。アイコンはまだ置かない
	/// </summary>
	public WindowIconTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-icon-{Guid.NewGuid():N}");
		Directory.CreateDirectory(_tempRoot);
	}

	/// <summary>
	/// 一時ディレクトリが残っていれば、中身ごと削除する
	/// </summary>
	public void Dispose()
	{
		// 一時ディレクトリが残っているときだけ中身ごと削除する。無いときは何もしない
		if (Directory.Exists(_tempRoot))
		{
			Directory.Delete(_tempRoot, recursive: true);
		}
	}

	/// <summary>
	/// exe の隣に置いた icon.ico を読み、破棄できるアイコンを返す
	/// </summary>
	[Fact]
	public void Load_reads_icon_file_beside_executable()
	{
		// リポジトリの build/icon.ico。出力ディレクトリから親を辿る。無いときは直後の存在確認が失敗する
		string source = ResolveRepoIconPath();
		Assert.True(File.Exists(source), $"build/icon.ico が見つかりません: {source}");
		// exe の隣に見立てて一時ディレクトリへ複製した icon.ico
		string copy = Path.Combine(_tempRoot, WindowIcon.FileName);
		File.Copy(source, copy);

		// 複製を置いたディレクトリから読んだアイコン。見つからなければ null
		object? icon = WindowIcon.Load(_tempRoot, executablePath: null);

		Assert.NotNull(icon);
		(icon as IDisposable)?.Dispose();
	}

	/// <summary>
	/// アイコンも実行ファイルも無いディレクトリでは null を返す
	/// </summary>
	[Fact]
	public void Load_returns_null_when_icon_sources_are_missing()
	{
		Assert.Null(WindowIcon.Load(_tempRoot, executablePath: Path.Combine(_tempRoot, "missing.exe")));
	}

	/// <summary>
	/// テストの出力ディレクトリから親へ遡り、リポジトリの build/icon.ico を探す
	/// 見つからないときは相対パスを返し、呼び出し側の存在確認が失敗する
	/// </summary>
	/// <returns>見つかった icon.ico のパス。無いときは build/icon.ico</returns>
	private static string ResolveRepoIconPath()
	{
		// 探索を始めるディレクトリ。出力先から親へ上がり、辿れなくなったら null
		string? directory = System.AppContext.BaseDirectory;
		while (!string.IsNullOrWhiteSpace(directory))
		{
			// この段の build/icon.ico。無ければ親へ上がる
			string candidate = Path.Combine(directory, "build", "icon.ico");
			// この段に icon.ico があるときだけそのパスを返す。無いときは親を見る
			if (File.Exists(candidate))
			{
				return candidate;
			}

			directory = Directory.GetParent(directory)?.FullName;
		}

		return Path.Combine("build", "icon.ico");
	}
}
