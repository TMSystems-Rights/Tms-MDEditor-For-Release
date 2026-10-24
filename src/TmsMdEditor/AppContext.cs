// ==============================================
// ウィンドウより長く生きるサービスを組み立てる
// ==============================================

// ロガーと各ストアの生成順を固定し、ウィンドウより長く生きる
// 設定の読込失敗は既定値で続行し、破棄時は監視と更新だけを止める

using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor;

/// <summary>
/// ウィンドウとブリッジが共有するサービスと、読み込み済みの設定
/// プロセスに 1 つ。Dispose はファイル監視と更新チェックを止め、設定ファイルは残す
/// </summary>
internal sealed class AppContext : IDisposable
{
	/// <summary>
	/// ロガー、設定、セッション、ファイル、更新のサービスを生成順に作る
	/// 設定ファイルはまだ読まない。失敗しても例外は出さず、各サービスのコンストラクタに任せる
	/// </summary>
	public AppContext()
	{
		Logger                = new Logger();
		BootstrapConfigStore  = new BootstrapConfigStore(Logger);
		ConfigStore           = new ConfigStore(Logger, BootstrapConfigStore);
		SessionStore          = new SessionStore(Logger, ConfigStore);
		NoteViewPositionStore = new NoteViewPositionStore(Logger, ConfigStore);
		FileService           = new FileService(Logger);
		FileWatcherService    = new FileWatcherService(Logger);
		UpdateService         = new UpdateService(Logger);
		RecentFilesService    = new RecentFilesService();
	}

	/// <summary>
	/// 日次ログ。コンストラクタで作り、プロセス終了まで同じインスタンスを使う
	/// </summary>
	public Logger Logger { get; }

	/// <summary>
	/// dataDir を指す app-config.json の読み書き。config.json より先に使う
	/// </summary>
	public BootstrapConfigStore BootstrapConfigStore { get; }

	/// <summary>
	/// config.json の読み書き。Initialize 以降の設定変更はここを通す
	/// </summary>
	public ConfigStore ConfigStore { get; }

	/// <summary>
	/// 次回起動で開くタブ構成。主ウィンドウだけが保存する
	/// </summary>
	public SessionStore SessionStore { get; }

	/// <summary>
	/// ノートごとのカーソル位置とスクロール位置。ファイルパスをキーにプロセス内で共有する
	/// </summary>
	public NoteViewPositionStore NoteViewPositionStore { get; }

	/// <summary>
	/// テキストと画像の読み書き。ウィンドウを知らず、監視の抑止は呼び出し側が行う
	/// </summary>
	public FileService FileService { get; }

	/// <summary>
	/// 開いているファイルの外部変更の監視。Dispose で watcher を止める
	/// </summary>
	public FileWatcherService FileWatcherService { get; }

	/// <summary>
	/// GitHub Release の確認とインストーラーの取得。Dispose で通信を止める
	/// </summary>
	public UpdateService UpdateService { get; }

	/// <summary>
	/// 最近使ったファイルの追加と削除。実体は Config の一覧で、保存は ConfigStore へ委譲する
	/// </summary>
	public RecentFilesService RecentFilesService { get; }

	/// <summary>
	/// メモリ上の設定。Initialize と保存成功のあとだけ差し替える。保存失敗時は直前の値を残す
	/// </summary>
	public AppConfigDocument Config { get; internal set; } = ConfigStore.CreateDefaultConfig();

	/// <summary>
	/// 起動時の設定読込でユーザーへ見せるメッセージ。問題が無ければ null のまま
	/// </summary>
	public string? ConfigLoadMessage { get; private set; }

	/// <summary>
	/// config.json を読み、Config と ConfigLoadMessage を更新する
	/// 破損時はバックアップか既定値で続行し、理由を警告ログへ残す。起動は止めない
	/// </summary>
	/// <returns>読込結果。失敗でも Config には使える文書が入っている</returns>
	public LoadConfigResult Initialize()
	{
		LoadConfigResult result = ConfigStore.Load();
		Config            = result.Config;
		ConfigLoadMessage = result.Message;

		if (result.RecoveredFromBackup)
		{
			Logger.Warn(LogCategory.Shell, result.Message ?? "設定をバックアップから復旧しました");
		}
		else if (!result.Success && !string.IsNullOrWhiteSpace(result.Message))
		{
			Logger.Warn(LogCategory.Shell, result.Message);
		}

		Logger.Info(LogCategory.Shell, "設定を読み込みました", new Dictionary<string, object?>
		{
			[LogProperty.DataDir] = ConfigStore.CachedDataDir ?? BootstrapConfigStore.Load().DataDir,
		});

		return result;
	}

	/// <summary>
	/// 閉じる直前のウィンドウサイズを設定へ保存し、成功したときだけ Config を差し替える
	/// 保存に失敗しても例外は出さず、メモリ上の設定は変えない
	/// </summary>
	/// <param name="width">通常表示の外側の幅。ピクセル。最大化中は RestoreBounds の幅を渡す</param>
	/// <param name="height">通常表示の外側の高さ。ピクセル。最大化中は RestoreBounds の高さを渡す</param>
	/// <param name="maximized">閉じる時点で最大化していたか。true のとき次回も最大化で開く</param>
	public void PersistWindowState(int width, int height, bool maximized)
	{
		AppConfigDocument next = new()
		{
			SchemaVersion     = Config.SchemaVersion,
			Window            = new WindowConfig
			{
				Width     = width,
				Height    = height,
				Maximized = maximized,
			},
			Settings          = Config.Settings,
			CustomDecorations = Config.CustomDecorations,
			RecentFiles       = Config.RecentFiles,
		};

		SaveConfigResult result = ConfigStore.Save(next);
		if (result.Success && result.Config is not null)
		{
			Config = result.Config;
		}
	}

	/// <summary>
	/// ファイル監視と更新チェックを止める。設定とログファイルは削除しない
	/// </summary>
	public void Dispose()
	{
		FileWatcherService.Dispose();
		UpdateService.Dispose();
	}
}
