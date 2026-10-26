// ==============================================
// セッション JSON の保存と破損時の扱い
// ==============================================

// 対応するスキーマのセッションは data ディレクトリへ保存して読み戻し、壊れたファイルは上書きしない

using System.Text.Json;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリを AppData の代わりにして、セッションファイルの保存と読込を検証する
/// 差し替えは各テストの終了時に戻す
/// </summary>
public class SessionStoreTests : IDisposable
{
	/// <summary>
	/// セッションファイルを置く一時ルート。テストごとに作り、Dispose で削除する
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// セッションの保存先ディレクトリを決める実設定ストア。コンストラクタで初期ファイルを作る
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// 検証対象。設定ストアが指す data ディレクトリへセッションを書く
	/// </summary>
	private readonly SessionStore _sessionStore;

	/// <summary>
	/// AppData を一時ディレクトリへ差し替え、設定を初期化してからセッションを操作できる状態にする
	/// </summary>
	public SessionStoreTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-session-test-{Guid.NewGuid():N}");
		AppPaths.SetOverrideAppDataRoot(_tempRoot);
		// 設定とセッションの両方へ渡すログ。ファイルへは書かない
		var logger = new Logger();
		// データディレクトリのポインタ。このテストでは既定の data を指す
		var bootstrapConfigStore = new BootstrapConfigStore(logger);
		_configStore  = new ConfigStore(logger, bootstrapConfigStore);
		_sessionStore = new SessionStore(logger, _configStore);
		_configStore.Load();
	}

	/// <summary>
	/// AppData の差し替えを戻し、一時ディレクトリが残っていれば削除する
	/// </summary>
	public void Dispose()
	{
		AppPaths.SetOverrideAppDataRoot(null);
		// 一時ディレクトリが残っているときだけ削除する。無いときは何もしない
		if (Directory.Exists(_tempRoot)) Directory.Delete(_tempRoot, recursive: true);
	}

	/// <summary>
	/// 保存したセッション JSON を data ディレクトリから、同じタブ ID で読み戻す
	/// </summary>
	[Fact]
	public void Save_and_load_round_trips_session_in_data_dir()
	{
		// schemaVersion 1 のタブ1件。ファイルパスは実在しなくてよい
		using JsonDocument document = JsonDocument.Parse("""{"schemaVersion":1,"tabs":[{"tabId":"tab-1","filePath":"C:\\docs\\one.md"}]}""");

		// 保存の成否。失敗時は Success が false で Message に理由がある
		SessionSaveResult save = _sessionStore.Save(document.RootElement);
		// data ディレクトリから読み戻したセッション。失敗時は Success が false で Session は null
		SessionLoadResult load = _sessionStore.Load();

		Assert.True(save.Success, save.Message);
		Assert.True(load.Success, load.Message);
		Assert.Equal("tab-1", load.Session?.GetProperty("tabs")[0].GetProperty("tabId").GetString());
		Assert.True(File.Exists(AppPaths.GetSessionPath(AppPaths.DefaultDataDir)));
	}

	/// <summary>
	/// 未対応のスキーマは保存せず、セッションファイルを作らない
	/// </summary>
	[Fact]
	public void Save_rejects_unknown_schema_version()
	{
		// 未対応の schemaVersion 99。保存してはいけない
		using JsonDocument document = JsonDocument.Parse("""{"schemaVersion":99}""");

		// 拒否された保存結果。Success は false で、ファイルは作らない
		SessionSaveResult result = _sessionStore.Save(document.RootElement);

		Assert.False(result.Success);
		Assert.False(File.Exists(AppPaths.GetSessionPath(AppPaths.DefaultDataDir)));
	}

	/// <summary>
	/// 壊れたセッションは失敗にし、ファイルの中身は壊れたまま残す
	/// </summary>
	[Fact]
	public void Load_ignores_corrupt_session_without_replacing_it()
	{
		// 壊れた JSON を置くセッションファイル。Load 後もこの中身のまま残る
		string sessionPath = AppPaths.GetSessionPath(AppPaths.DefaultDataDir);
		File.WriteAllText(sessionPath, "{broken");

		// 壊れたファイルの読込結果。Success は false で Session は null
		SessionLoadResult result = _sessionStore.Load();

		Assert.False(result.Success);
		Assert.Null(result.Session);
		Assert.Equal("{broken", File.ReadAllText(sessionPath));
	}
}
