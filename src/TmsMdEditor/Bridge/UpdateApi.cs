// ==============================================
// 更新の確認と適用
// ==============================================

// 手動確認、起動時の 1 日 1 回の確認、インストーラーの取得と起動を Web 層へ橋渡しする
// ポータブル版はインストーラーを取得せず、公式ページを開く

using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// update:* を受けるブリッジ。検出したリリースと取得済みインストーラーのパスは、このインスタンスが保持する
/// </summary>
internal sealed class UpdateApi
{
	/// <summary>
	/// 更新イベントの送信と、適用時にウィンドウを閉じる宛先。API より長く生きる
	/// </summary>
	private readonly MainForm _mainForm;

	/// <summary>
	/// 更新サービスと、確認日時やスキップ版の保存先
	/// </summary>
	private readonly AppContext _appContext;

	/// <summary>
	/// 直近の確認で新しいと分かったリリース。無いときは null。次の確認で上書きする
	/// </summary>
	private UpdateReleaseInfo? _availableRelease;

	/// <summary>
	/// 検証済みインストーラーのパス。取得に成功したときだけ入り、適用時に存在を確認する
	/// </summary>
	private string? _downloadedInstallerPath;

	/// <summary>
	/// 更新 API を作る。フォームとコンテキストは借用する
	/// </summary>
	/// <param name="mainForm">進捗イベントと、適用時の終了の宛先。null は渡さない</param>
	/// <param name="appContext">更新サービスと設定。null は渡さない</param>
	public UpdateApi(MainForm mainForm, AppContext appContext)
	{
		_mainForm   = mainForm;
		_appContext = appContext;
	}

	/// <summary>
	/// 新しいリリースがあるかを確認し、エラーでなければ最終確認日時を保存する
	/// ポータブル版はタグ名だけを比較する。通信失敗は結果の status が error になり、例外は出さない
	/// </summary>
	/// <returns>available、not-available、error のいずれか。available のときだけ以降の取得に使うリリースを覚える</returns>
	public async Task<UpdateCheckResult> CheckAsync()
	{
		// true ならタグ名だけを比較する。ポータブル版はインストーラーの有無を見ない
		bool tagNameOnly = AppPaths.IsPortable;
		// 確認結果。status は available、not-available、error。通信失敗でも例外は出ない
		UpdateCheckResult result = await _appContext.UpdateService.CheckAsync(tagNameOnly: tagNameOnly).ConfigureAwait(false);
		// 通信失敗以外のときだけ最終確認日時を残す。error では前回の日時を維持する
		if (result.Status != "error")
		{
			PersistUpdateSettings(lastCheckedAt: DateTimeOffset.Now.ToString("o"));
		}

		// 新しいリリースがあるときだけ、以降の取得に使うリリースを覚える
		if (result.Status == "available") _availableRelease = result.Release;
		return result;
	}

	/// <summary>
	/// 起動時の更新確認をバックグラウンドで始める。同日に確認済み、または設定がオフなら何もしない
	/// 新しいリリースがあり、スキップ対象でなければ Web 層へ通知する
	/// </summary>
	public void StartStartupCheck()
	{
		// 今日すでに確認した、または設定がオフのとき。バックグラウンドでは始めない
		if (!ShouldCheckOnStartup()) return;
		_ = Task.Run(async () =>
		{
			// バックグラウンドの確認結果。error のときは通知しない
			UpdateCheckResult result = await CheckAsync().ConfigureAwait(false);
			// available で、リリースがあり、かつスキップ版と違うときだけ通知する。一つでも欠けると出さない
			if (result.Status == "available" && result.Release is { } release && !string.Equals(_appContext.Config.Settings.Update.SkippedVersion, release.Version, StringComparison.OrdinalIgnoreCase))
			{
				// 起動時に見つかったリリース。スキップ対象はここまで来ない
				_mainForm.PostBridgeEvent(BridgeEventName.UpdateAvailable, new
				{
					// 検出したリリース。バージョン比較に使う
					release,
					// installer または portable。ポータブルは公式ページ案内になる
					mode = result.Mode,
				});
			}
		});
	}

	/// <summary>
	/// 検出済みリリースのインストーラーを検証しながら取得する
	/// ポータブル版、または未確認のときは取得せずメッセージを返す。進捗と完了、失敗はイベントで通知する
	/// </summary>
	/// <returns>取得結果。成功時はインストーラーのパスを覚え、キャンセル時はイベントを出さない</returns>
	public async Task<UpdateDownloadResult> DownloadAsync()
	{
		// ポータブル版はインストーラーを取得しない
		if (AppPaths.IsPortable)
		{
			return new UpdateDownloadResult { Message = "ポータブル版ではインストーラーをダウンロードしません。公式ページから入手してください。" };
		}

		// 先に確認していないとき。取得せずメッセージだけ返す
		if (_availableRelease is null) return new UpdateDownloadResult { Message = "先に更新を確認してください。" };

		// 取得の進み具合。変化のたびに Web 層へ割合を送る
		var progress = new Progress<UpdateDownloadProgress>(value => _mainForm.PostBridgeEvent(BridgeEventName.UpdateDownloadProgress, value));
		// 取得結果。成功時だけインストーラーのパスを覚える。キャンセル時はイベントを出さない
		UpdateDownloadResult result = await _appContext.UpdateService.DownloadAsync(_availableRelease, progress).ConfigureAwait(false);
		// 成功し、かつパスがあるときだけ覚える。片方でも欠けると完了イベントは出さない
		if (result.Success && result.InstallerPath is { } installerPath)
		{
			_downloadedInstallerPath = installerPath;
			_mainForm.PostBridgeEvent(BridgeEventName.UpdateDownloadCompleted, new { version = _availableRelease.Version });
		}
		// キャンセルではなく、かつ失敗メッセージがあるときだけエラーを通知する。どちらかが欠けるとイベントは出さない
		else if (!result.Cancelled && !string.IsNullOrWhiteSpace(result.Message))
		{
			_mainForm.PostBridgeEvent(BridgeEventName.UpdateError, new { message = result.Message });
		}

		return result;
	}

	/// <summary>
	/// 進行中のインストーラー取得を中止する。取得していなくても成功を返す
	/// </summary>
	/// <returns>受付済みを表す ok</returns>
	public object CancelDownload()
	{
		_appContext.UpdateService.CancelDownload();
		return new { ok = true };
	}

	/// <summary>
	/// いま検出しているバージョンを、以後の起動時通知から外して保存する
	/// 検出中のバージョンと違うときは保存しない
	/// </summary>
	/// <param name="paramsElement">version を持つ JSON。無いときは空文字として比較し、失敗を返す</param>
	/// <returns>保存結果。対象が無いときは Success が false</returns>
	public SaveConfigResult SkipVersion(JsonElement paramsElement)
	{
		// 通知から外す版。プロパティが無い、または null のときは空文字で、検出中の版と一致しない
		string version = paramsElement.TryGetProperty(BridgeProperty.Version, out JsonElement versionElement) ? versionElement.GetString() ?? string.Empty : string.Empty;
		// 検出中の版が無い、または要求の版と違うとき。どちらか一方でも保存しない
		if (_availableRelease is null || !string.Equals(version, _availableRelease.Version, StringComparison.OrdinalIgnoreCase))
		{
			// 保存しなかった結果。検出中の版と要求が一致しない
			return new SaveConfigResult
			{
				// false は未保存
				Success = false,
				// 一致しなかった理由。空にはしない
				Message = "スキップ対象の更新が見つかりません。",
			};
		}

		return PersistUpdateSettings(skippedVersion: _availableRelease.Version);
	}

	/// <summary>
	/// アプリ終了後に、取得済みインストーラーを起動するよう予約してウィンドウを閉じる
	/// ポータブル版、またはファイルが無いときは予約しない
	/// </summary>
	/// <returns>予約できたときの ok</returns>
	/// <exception cref="InvalidOperationException">ポータブル版、またはインストーラーのパスが空かファイルが無い</exception>
	public object ApplyNow()
	{
		// ポータブル版はインストーラーを起動しない
		if (AppPaths.IsPortable)
		{
			throw new InvalidOperationException("ポータブル版ではインストーラーを起動しません。");
		}

		// パスが空、またはファイルが無いとき。どちらか一方でも予約しない
		if (string.IsNullOrWhiteSpace(_downloadedInstallerPath) || !File.Exists(_downloadedInstallerPath))
		{
			throw new InvalidOperationException("ダウンロード済みのインストーラーが見つかりません。");
		}

		_mainForm.QueueInstallerAndClose(_downloadedInstallerPath);
		return new { ok = true };
	}

	/// <summary>
	/// 公式の入手ページを既定のブラウザで開く。ポータブル版の更新案内に使う
	/// </summary>
	/// <returns>開けたときの ok と、開いた URL</returns>
	public object OpenOfficialPage()
	{
		// 開いた公式ページの URL。開けなければ PortalUrl 側が失敗する
		string url = PortalUrl.OpenOfficialPortal();
		// 開けた結果。ok と、開いた URL
		return new
		{
			// true はページを開けた
			ok = true,
			// 開いた URL。空にはしない
			url,
		};
	}

	/// <summary>
	/// 起動時確認を今日まだ行ってよいか。設定がオフ、または最終確認日が今日なら false
	/// 日時を解釈できないときは確認する
	/// </summary>
	/// <returns>確認を始めてよいとき true</returns>
	private bool ShouldCheckOnStartup()
	{
		// 更新設定。オフ、または最終確認日が今日なら確認しない
		UpdateSettings settings = _appContext.Config.Settings.Update;
		// 起動時確認がオフのとき。日時は見ない
		if (!settings.CheckOnStartup) return false;
		// 日時を解釈できない、または最終確認の日付が今日より前のとき true。今日なら false
		return !DateTimeOffset.TryParse(settings.LastCheckedAt, out DateTimeOffset lastChecked) || lastChecked.LocalDateTime.Date < DateTime.Today;
	}

	/// <summary>
	/// スキップするバージョンか最終確認日時だけを差し替えて設定を保存する
	/// 引数を省略した項目は現在の値を残す。成功したときだけメモリ上の設定を差し替える
	/// </summary>
	/// <param name="skippedVersion">以後通知しないバージョン。null なら現在値を維持する</param>
	/// <param name="lastCheckedAt">最終確認の ISO 8601 日時。null なら現在値を維持する</param>
	/// <returns>保存結果。失敗時はメモリ上の設定を変えない</returns>
	private SaveConfigResult PersistUpdateSettings(string? skippedVersion = null, string? lastCheckedAt = null)
	{
		// いまの更新設定。省略した引数はここの値を残す
		UpdateSettings current = _appContext.Config.Settings.Update;
		// update だけを差し替える部分 JSON。他の設定項目はストア側が維持する
		JsonElement patch = JsonSerializer.SerializeToElement(new
		{
			// 更新設定だけの差分
			update = new UpdateSettings
			{
				// 起動時確認のオンオフ。この保存では変えない
				CheckOnStartup = current.CheckOnStartup,
				// 通知から外す版。引数が null なら現在値。空文字は除外なし
				SkippedVersion = skippedVersion ?? current.SkippedVersion,
				// 最終確認の ISO 8601。引数が null なら現在値。空なら次の起動で確認する
				LastCheckedAt  = lastCheckedAt ?? current.LastCheckedAt,
			},
		});
		// 部分保存の結果。失敗時はメモリ上の設定を変えない
		SaveConfigResult result = _appContext.ConfigStore.UpdateSettings(patch);
		// 保存に成功し、かつ文書があるときだけメモリを差し替える。片方でも欠けると直前の設定を残す
		if (result.Success && result.Config is not null) _appContext.Config = result.Config;
		return result;
	}
}
