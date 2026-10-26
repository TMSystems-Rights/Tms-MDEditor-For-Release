// ==============================================
// GitHub Release を問い合わせ、インストーラを検証する
// ==============================================

// 最新 Release の問い合わせと、インストーラの一時ファイルだけを所有する
// ポータブルはタグ比較で終え、適用の起動は呼び出し元が決める

using System.Diagnostics;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// 公開リポジトリの最新 Release を見て、インストーラ版だけ資産を検証してから起動する
/// 取得失敗は結果のメッセージで返し、進行中のダウンロードは次の要求で取り消す
/// </summary>
internal sealed class UpdateService : IDisposable
{
	// ==============================================
	// 接続先と進行中のダウンロード
	// ==============================================

	/// <summary>
	/// Release を読む GitHub の所有者。実行中は変えない
	/// </summary>
	private const string RepositoryOwner = "TMSystems-Rights";

	/// <summary>
	/// Release を読むリポジトリ名
	/// </summary>
	private const string RepositoryName  = "Tms-MDEditor-For-Release";

	/// <summary>
	/// GitHub REST API の起点。資産の公開 URL とは別に使う
	/// </summary>
	private const string GitHubApiBase   = "https://api.github.com";

	/// <summary>
	/// Release JSON のタグ名プロパティ
	/// </summary>
	private const string ReleaseTagNameProperty       = "tag_name";

	/// <summary>
	/// Release の HTML ページ URL プロパティ
	/// </summary>
	private const string ReleaseHtmlUrlProperty       = "html_url";

	/// <summary>
	/// Release ノート本文のプロパティ。SHA-256 の記載をここから探す
	/// </summary>
	private const string ReleaseBodyProperty          = "body";

	/// <summary>
	/// Release に付く資産配列のプロパティ
	/// </summary>
	private const string ReleaseAssetsProperty        = "assets";

	/// <summary>
	/// 資産のファイル名プロパティ。setup.exe で終わるものだけを対象にする
	/// </summary>
	private const string AssetNameProperty            = "name";

	/// <summary>
	/// 資産 ID のプロパティ。公開 URL が無いときの API 取得に使う
	/// </summary>
	private const string AssetIdProperty              = "id";

	/// <summary>
	/// 資産の公開ダウンロード URL プロパティ
	/// </summary>
	private const string AssetBrowserDownloadProperty = "browser_download_url";

	/// <summary>
	/// 資産サイズのプロパティ。単位はバイト
	/// </summary>
	private const string AssetSizeProperty            = "size";

	/// <summary>
	/// Release ノートから 64 桁の SHA-256 を取り出すパターン。プロセスで共有する
	/// </summary>
	private static readonly Regex Sha256Pattern = new(@"(?im)sha(?:-?256)?\s*[:=]\s*`?([a-f0-9]{64})`?", RegexOptions.Compiled);

	/// <summary>
	/// 更新確認とダウンロードの失敗を記録するログ。利用者向け文言は結果で返す
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// GitHub へ送る HTTP クライアント。テストが差し替えたときはこのサービスでは破棄しない
	/// </summary>
	private readonly HttpClient _httpClient;

	/// <summary>
	/// このサービスが HTTP クライアントを生成したか。true のときだけ Dispose で破棄する
	/// </summary>
	private readonly bool _ownsHttpClient;

	/// <summary>
	/// 比較に使う現行バージョン。先頭の v と、+ または - 以降を除いてある
	/// </summary>
	private readonly string _currentVersion;

	/// <summary>
	/// 進行中ダウンロードのキャンセル。新しい要求が前回を取り消し、待機中でなければ null
	/// </summary>
	private CancellationTokenSource? _downloadCancellation;

	/// <summary>
	/// ログと、任意の HTTP クライアント、任意の現行バージョンで更新サービスを作る
	/// </summary>
	/// <param name="logger">取得失敗を記録するログ</param>
	/// <param name="httpClient">テスト用のクライアント。null ならタイムアウト 30 秒のクライアントを所有する</param>
	/// <param name="currentVersion">比較する現行バージョン。null ならアセンブリの情報バージョン</param>
	public UpdateService(Logger logger, HttpClient? httpClient = null, string? currentVersion = null)
	{
		_logger         = logger;
		_httpClient     = httpClient ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
		_ownsHttpClient = httpClient is null;
		_currentVersion = NormalizeVersion(currentVersion ?? GetAssemblyInformationalVersion());
	}

	// ==============================================
	// 確認と適用
	// ==============================================

	/// <summary>
	/// 最新 Release を取得し、現行より新しいかを判定する。ポータブルは資産を要求しない
	/// </summary>
	/// <param name="cancellationToken">問い合わせを取り消すトークン。取り消すと例外になる</param>
	/// <param name="tagNameOnly">true のとき tag だけを比較し、インストーラ資産は要求しない</param>
	/// <returns>利用可否、現行バージョン、Release 情報。通信失敗は status が error</returns>
	/// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> が取り消された</exception>
	public async Task<UpdateCheckResult> CheckAsync(CancellationToken cancellationToken = default, bool tagNameOnly = false)
	{
		// ポータブル版は自動適用しないため、資産を要求せずタグ比較だけ行う
		// portable はタグだけ。installer は資産の有無まで見る
		string mode = tagNameOnly ? "portable" : "installer";
		try
		{
			// 最新 Release の API 要求。未送信
			using HttpRequestMessage request = CreateApiRequest(HttpMethod.Get, $"/repos/{RepositoryOwner}/{RepositoryName}/releases/latest");
			// 応答。失敗ステータスでも本文は失敗結果に変える
			using HttpResponseMessage response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
			// 成功ステータス以外は Release を解析せず失敗にする
			if (!response.IsSuccessStatusCode) return Failure($"更新情報の取得に失敗しました（HTTP {(int)response.StatusCode}）。", mode);

			// Release JSON の本体
			await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
			// 解析した文書。使い終わったら破棄する
			using JsonDocument document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
			// ポータブルは tag だけ。インストーラは setup.exe と SHA-256 まで読む
			UpdateReleaseInfo release = tagNameOnly ? ParseReleaseTagOnly(document.RootElement) : ParseRelease(document.RootElement);
			// SemVerのビルド・プレリリース部分を除いたVersionで、単純な大小比較へ揃える
			// 最新か現行のどちらかが Version として読めなければ失敗。両方読めたときだけ比較へ進む
			if (!TryParseVersion(release.Version, out Version? latestVersion) || !TryParseVersion(_currentVersion, out Version? currentVersion)) return Failure("Release のバージョン形式が不正です。", mode);

			// 比較結果。通信失敗はこの形にしない
			return new UpdateCheckResult
			{
				// 現行より新しければ available。同じか古ければ not-available
				Status         = latestVersion > currentVersion ? "available" : "not-available",
				// 比較に使った現行バージョン。先頭の v は除いてある
				CurrentVersion = _currentVersion,
				// 解析した Release。ポータブルは資産項目が空
				Release        = release,
				// 問い合わせ方。portable か installer
				Mode           = mode,
			};
		}
		catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
		{
			throw;
		}
		catch (Exception ex)
		{
			_logger.Info(LogCategory.Update, "更新情報を取得できませんでした", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			return Failure("更新情報を取得できませんでした。ネットワーク接続を確認してください。", mode);
		}
	}

	/// <summary>
	/// インストーラを一時ファイルへ受信し、サイズと SHA-256 を検証してから確定パスへ移す
	/// </summary>
	/// <param name="release">ダウンロードする Release。資産名と、資産 ID か公開 URL が必要</param>
	/// <param name="progress">受信バイト数の通知先。null なら通知しない。単位はバイトと百分率</param>
	/// <param name="cancellationToken">この要求と、以前から続くダウンロードを止めるトークン。取り消しは結果の Cancelled で返す</param>
	/// <returns>検証済みインストーラのパス。失敗や取り消しは Success が false</returns>
	public async Task<UpdateDownloadResult> DownloadAsync(UpdateReleaseInfo release, IProgress<UpdateDownloadProgress>? progress = null, CancellationToken cancellationToken = default)
	{
		// 資産名が空白、または ID も公開 URL も無いときはダウンロードしない。名前が空なら ID があっても入る
		if (string.IsNullOrWhiteSpace(release.InstallerName)
			|| (release.InstallerAssetId <= 0 && string.IsNullOrWhiteSpace(release.InstallerDownloadUrl)))
		{
			return new UpdateDownloadResult { Message = "インストーラー資産が見つかりません。" };
		}

		// 同時に複数の更新を走らせず、新しい要求が以前のダウンロードを引き継がないようにする
		CancelDownload();
		// この要求と、以前から続くダウンロードの両方で止まるトークン
		using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		_downloadCancellation = linkedCancellation;
		// 検証後に置く確定パス。OS の一時ディレクトリ
		string targetPath  = Path.Combine(Path.GetTempPath(), $"TmsMdEditor-{release.Version}-setup.exe");
		// 受信中の不完全ファイル。失敗時は finally で消す
		string partialPath = targetPath + ".part";

		try
		{
			// 公開 URL か API の取得要求
			using HttpRequestMessage request = CreateDownloadRequest(release);
			// ヘッダだけ先に受け、本文はストリームで読む
			using HttpResponseMessage response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linkedCancellation.Token).ConfigureAwait(false);
			// 成功ステータス以外は .part を書かず失敗にする
			if (!response.IsSuccessStatusCode) return new UpdateDownloadResult { Message = $"インストーラーのダウンロードに失敗しました（HTTP {(int)response.StatusCode}）。" };

			// 全体をメモリへ載せず.partへ逐次保存し、受信バイト数から進捗を通知する
			// 全体サイズ。単位はバイト。ヘッダが無ければ Release の size。どちらも無ければ 0 で百分率は出さない
			long totalBytes = response.Content.Headers.ContentLength ?? release.InstallerSize;
			// ここまで書いたバイト数。単位はバイト。開始時は 0
			long downloadedBytes = 0;
			{
				// 応答本文。使い終わったら閉じる
				await using Stream input = await response.Content.ReadAsStreamAsync(linkedCancellation.Token).ConfigureAwait(false);
				// .part を新規作成。共有せず 81920 バイト単位で書く
				await using FileStream output = new(partialPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true);
				// 1 回の読み取りバッファ。81920 バイト
				byte[] buffer = new byte[81920];
				// 今回読めたバイト数。0 で受信完了
				int read;
				while ((read = await input.ReadAsync(buffer, linkedCancellation.Token).ConfigureAwait(false)) > 0)
				{
					await output.WriteAsync(buffer.AsMemory(0, read), linkedCancellation.Token).ConfigureAwait(false);
					downloadedBytes += read;
					// 受信途中の進捗。全体サイズが 0 のとき百分率は 0 のまま
					progress?.Report(new UpdateDownloadProgress
					{
						// ここまで書いたバイト数。単位はバイト
						DownloadedBytes = downloadedBytes,
						// 分かっている全体サイズ。単位はバイト。不明なら 0
						TotalBytes = totalBytes,
						// 0 から 100。全体が 0 のときは 0 のまま
						Percent = totalBytes > 0 ? (int)Math.Min(100, downloadedBytes * 100 / totalBytes) : 0,
					});
				}

				await output.FlushAsync(linkedCancellation.Token).ConfigureAwait(false);
			}
			// 完成ファイルへ昇格する前に、Releaseメタデータのサイズとハッシュを順に検証する
			// Release がサイズを持ち、かつ受信バイト数が一致しないときだけ失敗。サイズ 0 では検証しない
			if (release.InstallerSize > 0 && downloadedBytes != release.InstallerSize) return new UpdateDownloadResult { Message = "インストーラーのサイズ検証に失敗しました。" };

			// ノートに SHA-256 があるときだけハッシュを比べる。空ならサイズ検証だけで進む
			if (!string.IsNullOrWhiteSpace(release.Sha256))
			{
				// 書き終えた .part。ハッシュ計算用に読み直す
				await using FileStream verificationStream = File.OpenRead(partialPath);
				// 受信ファイルの SHA-256。16 進大文字
				string actualHash = Convert.ToHexString(await SHA256.HashDataAsync(verificationStream, linkedCancellation.Token).ConfigureAwait(false));
				// 大文字小文字を無視してノートの値と違うときは確定パスへ移さない
				if (!string.Equals(actualHash, release.Sha256, StringComparison.OrdinalIgnoreCase)) return new UpdateDownloadResult { Message = "インストーラーの SHA-256 検証に失敗しました。" };
			}

			// 検証を通過した.partだけを、後で起動する確定パスへ置き換える
			File.Move(partialPath, targetPath, overwrite: true);
			// 検証を通過したインストーラ
			return new UpdateDownloadResult
			{
				// サイズとハッシュを通過した
				Success = true,
				// 起動に使う確定パス
				InstallerPath = targetPath,
			};
		}
		catch (OperationCanceledException) when (linkedCancellation.IsCancellationRequested)
		{
			// 取り消し。不完全な .part は finally で消す
			return new UpdateDownloadResult
			{
				// 失敗ではなくキャンセル
				Cancelled = true,
				// 利用者向け
				Message = "更新のダウンロードをキャンセルしました。",
			};
		}
		catch (Exception ex)
		{
			_logger.Warn(LogCategory.Update, "インストーラーのダウンロードに失敗しました", new Dictionary<string, object?> { [LogProperty.Error] = ex.Message });
			// 通信やディスクの失敗。Success は既定の false
			return new UpdateDownloadResult
			{
				// 利用者向け。詳細はログ
				Message = "インストーラーのダウンロードに失敗しました。",
			};
		}
		finally
		{
			// 失敗・キャンセル時の不完全ファイルと、現在要求だけが所有するCTSを片付ける
			// 失敗やキャンセルで残った不完全ファイルだけ消す。昇格済みなら無い
			if (File.Exists(partialPath)) File.Delete(partialPath);
			// この要求がまだ進行中の印を持っているときだけ外す。次の要求が差し替えていれば入らない
			if (ReferenceEquals(_downloadCancellation, linkedCancellation)) _downloadCancellation = null;
		}
	}

	/// <summary>
	/// 進行中のダウンロードがあれば取り消す。待機中でなければ何もしない
	/// </summary>
	public void CancelDownload() => _downloadCancellation?.Cancel();

	/// <summary>
	/// 検証済みインストーラを OS の関連付けで起動する。終了コードは待たない
	/// </summary>
	/// <param name="installerPath">起動する setup.exe のパス</param>
	/// <exception cref="FileNotFoundException"><paramref name="installerPath"/> のファイルが存在しない</exception>
	public void LaunchInstaller(string installerPath)
	{
		// 検証後に消えた、またはパスが違うときは起動しない
		if (!File.Exists(installerPath)) throw new FileNotFoundException("インストーラーが見つかりません。", installerPath);
		Process.Start(new ProcessStartInfo(installerPath) { UseShellExecute = true });
	}

	/// <summary>
	/// 進行中のダウンロードを取り消し、このサービスが所有する HTTP クライアントを破棄する
	/// </summary>
	public void Dispose()
	{
		CancelDownload();
		_downloadCancellation?.Dispose();
		// このサービスが生成したクライアントだけ破棄する。テストが渡したものは触らない
		if (_ownsHttpClient) _httpClient.Dispose();
	}

	// ==============================================
	// Release の解釈
	// ==============================================

	/// <summary>
	/// 比較用に、前後の空白と先頭の v、+ または - 以降を除く
	/// </summary>
	/// <param name="value">タグやアセンブリのバージョン文字列</param>
	/// <returns>大小比較に使う版の文字列。空になることがある</returns>
	internal static string NormalizeVersion(string value) => value.Trim().TrimStart('v', 'V').Split('+', '-')[0];

	/// <summary>
	/// 正規化した文字列を Version として読めるかを返す
	/// </summary>
	/// <param name="value">タグや現行バージョン。正規化してから解析する</param>
	/// <param name="version">読めた版。失敗時は null</param>
	/// <returns>Version として解釈できれば true</returns>
	internal static bool TryParseVersion(string value, out Version? version) => Version.TryParse(NormalizeVersion(value), out version);

	/// <summary>
	/// アセンブリの情報バージョンを返し、無ければアセンブリバージョン、それも無ければ 0.0.0
	/// </summary>
	/// <returns>未正規化のバージョン文字列</returns>
	private static string GetAssemblyInformationalVersion()
		=> typeof(UpdateService).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
			?? typeof(UpdateService).Assembly.GetName().Version?.ToString()
			?? "0.0.0";

	/// <summary>
	/// 更新確認の失敗結果を作る。例外にはしない
	/// </summary>
	/// <param name="message">利用者向けの失敗理由</param>
	/// <param name="mode">portable または installer。省略時は installer</param>
	/// <returns>status が error の確認結果。現行バージョンは保持する</returns>
	private UpdateCheckResult Failure(string message, string mode = "installer") =>
		// 例外にしない失敗結果。現行バージョンは残す
		new()
	{
		// 通信や形式の失敗を表す status
		Status = "error",
		// 比較に使う現行バージョン。取得失敗でも残す
		CurrentVersion = _currentVersion,
		// 利用者向けの失敗理由
		Message = message,
		// portable または installer。省略時は installer
		Mode = mode,
	};

	/// <summary>
	/// GitHub API 向けの要求を作る。User-Agent と API バージョンを付ける
	/// </summary>
	/// <param name="method">HTTP メソッド</param>
	/// <param name="relativePath">API 起点からのパス。先頭の / を含める</param>
	/// <returns>未送信の要求。呼び出し元が破棄する</returns>
	private static HttpRequestMessage CreateApiRequest(HttpMethod method, string relativePath)
	{
		// API 起点へメソッドと相対パスを付けた未送信の要求
		var request = new HttpRequestMessage(method, GitHubApiBase + relativePath);
		request.Headers.UserAgent.Add(new ProductInfoHeaderValue("TMS-MDEditor", "1.0"));
		request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
		request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
		return request;
	}

	/// <summary>
	/// インストーラの取得要求を作る。公開 URL があるときは資格情報を付けない
	/// </summary>
	/// <param name="release">資産の公開 URL または資産 ID を持つ Release</param>
	/// <returns>未送信の要求。公開 URL が無ければ API の asset エンドポイント</returns>
	private static HttpRequestMessage CreateDownloadRequest(UpdateReleaseInfo release)
	{
		// 公開 URL があるときは API ではなくその URL を開く
		if (!string.IsNullOrWhiteSpace(release.InstallerDownloadUrl))
		{
			// 公開asset URLは認証不要なので、資格情報を別ホストへのリダイレクトへ持ち出さない
			// 資格情報を付けない GET
			var publicRequest = new HttpRequestMessage(HttpMethod.Get, release.InstallerDownloadUrl);
			publicRequest.Headers.UserAgent.Add(new ProductInfoHeaderValue("TMS-MDEditor", "1.0"));
			return publicRequest;
		}

		// 公開URLがない場合も、公開リポジトリのAPI assetエンドポイントから取得する
		// API の asset エンドポイント。Accept は直後でバイナリへ変える
		HttpRequestMessage request = CreateApiRequest(HttpMethod.Get, $"/repos/{RepositoryOwner}/{RepositoryName}/releases/assets/{release.InstallerAssetId}");
		request.Headers.Accept.Clear();
		request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
		return request;
	}

	/// <summary>
	/// Release JSON から setup.exe の資産と、ノートに書かれた SHA-256 を読む
	/// </summary>
	/// <param name="root">最新 Release の JSON オブジェクト</param>
	/// <returns>比較用バージョン、資産、任意の SHA-256。ポータブル ZIP は対象にしない</returns>
	/// <exception cref="InvalidDataException">setup.exe の資産が無い</exception>
	private static UpdateReleaseInfo ParseRelease(JsonElement root)
	{
		// タグ名。null は空文字。比較前に v を除く
		string tagName    = root.GetProperty(ReleaseTagNameProperty).GetString() ?? string.Empty;
		// Release ページ。プロパティが無ければ空文字
		string releaseUrl = root.TryGetProperty(ReleaseHtmlUrlProperty, out JsonElement urlElement) ? urlElement.GetString() ?? string.Empty : string.Empty;
		// ノート本文。SHA-256 を探す。無ければ空文字
		string body       = root.TryGetProperty(ReleaseBodyProperty, out JsonElement bodyElement) ? bodyElement.GetString() ?? string.Empty : string.Empty;
		// 配布対象をsetup.exeへ限定し、portable ZIPなどを自動適用しない
		// setup.exe で終わる資産。配列が無ければ default で未定義
		JsonElement asset = root.TryGetProperty(ReleaseAssetsProperty, out JsonElement assetsElement) && assetsElement.ValueKind == JsonValueKind.Array
			? assetsElement.EnumerateArray().FirstOrDefault(item => item.TryGetProperty(AssetNameProperty, out JsonElement nameElement) && (nameElement.GetString() ?? string.Empty).EndsWith("-setup.exe", StringComparison.OrdinalIgnoreCase))
			: default;
		// インストーラ資産が無い Release はダウンロード対象にしない
		if (asset.ValueKind == JsonValueKind.Undefined) throw new InvalidDataException("Release にインストーラー資産がありません。");

		// ノートから取った 64 桁。見つからなければ Success は false で Sha256 は null
		Match hashMatch = Sha256Pattern.Match(body);
		// 比較とダウンロードに使う Release
		return new UpdateReleaseInfo
		{
			// 先頭の v と、+ または - 以降を除いた比較用バージョン
			Version          = NormalizeVersion(tagName),
			// 表示用のタグ。正規化前
			TagName          = tagName,
			// Release ページ。空ならリンクを出せない
			ReleaseUrl       = releaseUrl,
			// setup.exe のファイル名。null は空文字
			InstallerName        = asset.GetProperty(AssetNameProperty).GetString() ?? string.Empty,
			// API 取得に使う資産 ID
			InstallerAssetId     = asset.GetProperty(AssetIdProperty).GetInt64(),
			// 公開 URL。無ければ空で API 取得へ落ちる
			InstallerDownloadUrl = asset.TryGetProperty(AssetBrowserDownloadProperty, out JsonElement downloadUrlElement) ? downloadUrlElement.GetString() ?? string.Empty : string.Empty,
			// 資産サイズ。単位はバイト。無ければ 0 でサイズ検証をしない
			InstallerSize        = asset.TryGetProperty(AssetSizeProperty, out JsonElement sizeElement) ? sizeElement.GetInt64() : 0,
			// ノートの SHA-256。見つからなければ null でハッシュ検証をしない
			Sha256           = hashMatch.Success ? hashMatch.Groups[1].Value : null,
		};
	}

	/// <summary>
	/// tag と Release ページだけを読む。インストーラ資産は要求しない
	/// </summary>
	/// <param name="root">最新 Release の JSON オブジェクト</param>
	/// <returns>比較用バージョンとページ URL。資産項目は空のまま</returns>
	private static UpdateReleaseInfo ParseReleaseTagOnly(JsonElement root)
	{
		// タグ名。null は空文字
		string tagName    = root.GetProperty(ReleaseTagNameProperty).GetString() ?? string.Empty;
		// Release ページ。無ければ空文字。資産は読まない
		string releaseUrl = root.TryGetProperty(ReleaseHtmlUrlProperty, out JsonElement urlElement) ? urlElement.GetString() ?? string.Empty : string.Empty;
		// タグ比較だけの Release。資産項目は空のまま
		return new UpdateReleaseInfo
		{
			// 比較用に v とビルド番号を除いた版
			Version    = NormalizeVersion(tagName),
			// 表示用のタグ
			TagName    = tagName,
			// Release ページ
			ReleaseUrl = releaseUrl,
		};
	}

}
