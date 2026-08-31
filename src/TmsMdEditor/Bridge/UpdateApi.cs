using System.Text.Json;
using TmsMdEditor.Models;

namespace TmsMdEditor.Bridge;

/// <summary>
/// 更新関連ブリッジ API
/// </summary>
internal sealed class UpdateApi
{
	private readonly MainForm _mainForm;
	private readonly AppContext _appContext;
	private UpdateReleaseInfo? _availableRelease;
	private string? _downloadedInstallerPath;

	/// <summary>
	/// 更新 API を初期化する
	/// </summary>
	/// <param name="mainForm">メインフォーム</param>
	/// <param name="appContext">アプリケーション状態</param>
	public UpdateApi(MainForm mainForm, AppContext appContext)
	{
		_mainForm   = mainForm;
		_appContext = appContext;
	}

	/// <summary>
	/// 手動更新チェックを行う
	/// </summary>
	/// <returns>更新確認結果</returns>
	public async Task<UpdateCheckResult> CheckAsync()
	{
		UpdateCheckResult result = await _appContext.UpdateService.CheckAsync().ConfigureAwait(false);
		if (result.Status != "error")
		{
			PersistUpdateSettings(lastCheckedAt: DateTimeOffset.Now.ToString("o"));
		}

		if (result.Status == "available") _availableRelease = result.Release;
		return result;
	}

	/// <summary>
	/// 起動時のバックグラウンド更新チェックを開始する
	/// </summary>
	public void StartStartupCheck()
	{
		if (!ShouldCheckOnStartup()) return;
		_ = Task.Run(async () =>
		{
			UpdateCheckResult result = await CheckAsync().ConfigureAwait(false);
			if (result.Status == "available" && result.Release is { } release && !string.Equals(_appContext.Config.Settings.Update.SkippedVersion, release.Version, StringComparison.OrdinalIgnoreCase))
			{
				_mainForm.PostBridgeEvent("update:available", new { release });
			}
		});
	}

	/// <summary>
	/// 検出済み更新のダウンロードを開始する
	/// </summary>
	/// <returns>ダウンロード結果</returns>
	public async Task<UpdateDownloadResult> DownloadAsync()
	{
		if (_availableRelease is null) return new UpdateDownloadResult { Message = "先に更新を確認してください。" };

		var progress = new Progress<UpdateDownloadProgress>(value => _mainForm.PostBridgeEvent("update:downloadProgress", value));
		UpdateDownloadResult result = await _appContext.UpdateService.DownloadAsync(_availableRelease, progress).ConfigureAwait(false);
		if (result.Success && result.InstallerPath is { } installerPath)
		{
			_downloadedInstallerPath = installerPath;
			_mainForm.PostBridgeEvent("update:downloadCompleted", new { version = _availableRelease.Version });
		}
		else if (!result.Cancelled && !string.IsNullOrWhiteSpace(result.Message))
		{
			_mainForm.PostBridgeEvent("update:error", new { message = result.Message });
		}

		return result;
	}

	/// <summary>ダウンロードをキャンセルする</summary>
	public object CancelDownload()
	{
		_appContext.UpdateService.CancelDownload();
		return new { ok = true };
	}

	/// <summary>
	/// 指定バージョンの通知をスキップする
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult SkipVersion(JsonElement paramsElement)
	{
		string version = paramsElement.TryGetProperty("version", out JsonElement versionElement) ? versionElement.GetString() ?? string.Empty : string.Empty;
		if (_availableRelease is null || !string.Equals(version, _availableRelease.Version, StringComparison.OrdinalIgnoreCase))
		{
			return new SaveConfigResult { Success = false, Message = "スキップ対象の更新が見つかりません。" };
		}

		return PersistUpdateSettings(skippedVersion: _availableRelease.Version);
	}

	/// <summary>
	/// アプリ終了後にダウンロード済みインストーラーを起動する
	/// </summary>
	/// <returns>受付結果</returns>
	public object ApplyNow()
	{
		if (string.IsNullOrWhiteSpace(_downloadedInstallerPath) || !File.Exists(_downloadedInstallerPath))
		{
			throw new InvalidOperationException("ダウンロード済みのインストーラーが見つかりません。");
		}

		_mainForm.QueueInstallerAndClose(_downloadedInstallerPath);
		return new { ok = true };
	}

	private bool ShouldCheckOnStartup()
	{
		UpdateSettings settings = _appContext.Config.Settings.Update;
		if (!settings.CheckOnStartup) return false;
		return !DateTimeOffset.TryParse(settings.LastCheckedAt, out DateTimeOffset lastChecked) || lastChecked.LocalDateTime.Date < DateTime.Today;
	}

	private SaveConfigResult PersistUpdateSettings(string? skippedVersion = null, string? lastCheckedAt = null)
	{
		UpdateSettings current = _appContext.Config.Settings.Update;
		JsonElement patch = JsonSerializer.SerializeToElement(new
		{
			update = new UpdateSettings
			{
				CheckOnStartup = current.CheckOnStartup,
				SkippedVersion = skippedVersion ?? current.SkippedVersion,
				LastCheckedAt  = lastCheckedAt ?? current.LastCheckedAt,
			},
		});
		SaveConfigResult result = _appContext.ConfigStore.UpdateSettings(patch);
		if (result.Success && result.Config is not null) _appContext.Config = result.Config;
		return result;
	}
}
