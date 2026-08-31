using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor;

/// <summary>
/// アプリケーション全体の状態を保持する
/// </summary>
internal sealed class AppContext : IDisposable
{
	/// <summary>
	/// アプリケーションコンテキストを初期化する
	/// </summary>
	public AppContext()
	{
		Logger               = new Logger();
		BootstrapConfigStore = new BootstrapConfigStore(Logger);
		ConfigStore          = new ConfigStore(Logger, BootstrapConfigStore);
		SessionStore         = new SessionStore(Logger, ConfigStore);
		FileService          = new FileService(Logger);
		FileWatcherService   = new FileWatcherService(Logger);
		UpdateService        = new UpdateService(Logger);
		RecentFilesService   = new RecentFilesService();
	}

	/// <summary>
	/// ロガー
	/// </summary>
	public Logger Logger { get; }

	/// <summary>
	/// ブートストラップ設定ストア
	/// </summary>
	public BootstrapConfigStore BootstrapConfigStore { get; }

	/// <summary>
	/// 設定ストア
	/// </summary>
	public ConfigStore ConfigStore { get; }

	/// <summary>
	/// セッションストア
	/// </summary>
	public SessionStore SessionStore { get; }

	/// <summary>
	/// ファイルサービス
	/// </summary>
	public FileService FileService { get; }

	public FileWatcherService FileWatcherService { get; }

	/// <summary>
	/// 更新サービス
	/// </summary>
	public UpdateService UpdateService { get; }

	/// <summary>
	/// 最近使ったファイルサービス
	/// </summary>
	public RecentFilesService RecentFilesService { get; }

	/// <summary>
	/// 読み込み済み設定
	/// </summary>
	public AppConfigDocument Config { get; internal set; } = ConfigStore.CreateDefaultConfig();

	/// <summary>
	/// 設定読込メッセージ
	/// </summary>
	public string? ConfigLoadMessage { get; private set; }

	/// <summary>
	/// 起動時初期化を行う
	/// </summary>
	/// <returns>初期化結果</returns>
	public LoadConfigResult Initialize()
	{
		LoadConfigResult result = ConfigStore.Load();
		Config            = result.Config;
		ConfigLoadMessage = result.Message;

		if (result.RecoveredFromBackup)
		{
			Logger.Warn("shell", result.Message ?? "設定をバックアップから復旧しました");
		}
		else if (!result.Success && !string.IsNullOrWhiteSpace(result.Message))
		{
			Logger.Warn("shell", result.Message);
		}

		Logger.Info("shell", "設定を読み込みました", new Dictionary<string, object?>
		{
			["dataDir"] = ConfigStore.CachedDataDir ?? BootstrapConfigStore.Load().DataDir,
		});

		return result;
	}

	/// <summary>
	/// ウィンドウサイズを設定へ反映する
	/// </summary>
	/// <param name="width">幅</param>
	/// <param name="height">高さ</param>
	/// <param name="maximized">最大化状態</param>
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

	public void Dispose()
	{
		FileWatcherService.Dispose();
		UpdateService.Dispose();
	}
}
