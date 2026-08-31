using System.Diagnostics;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using TmsMdEditor.Models;

namespace TmsMdEditor.Services;

/// <summary>
/// GitHub Release を利用した半自動更新を提供する
/// </summary>
internal sealed class UpdateService : IDisposable
{
	private const string RepositoryOwner = "TMSystems-Rights";
	private const string RepositoryName  = "Tms-MDEditor-For-Release";
	private const string GitHubApiBase   = "https://api.github.com";
	private static readonly Regex Sha256Pattern = new(@"(?im)sha(?:-?256)?\s*[:=]\s*`?([a-f0-9]{64})`?", RegexOptions.Compiled);

	private readonly Logger _logger;
	private readonly HttpClient _httpClient;
	private readonly bool _ownsHttpClient;
	private readonly Func<string?> _tokenResolver;
	private readonly string _currentVersion;
	private CancellationTokenSource? _downloadCancellation;

	/// <summary>
	/// 更新サービスを初期化する
	/// </summary>
	/// <param name="logger">ロガー</param>
	/// <param name="httpClient">HTTP クライアント（テスト用に差し替え可）</param>
	/// <param name="tokenResolver">トークン取得処理（テスト用に差し替え可）</param>
	/// <param name="currentVersion">現行バージョン（テスト用に差し替え可）</param>
	public UpdateService(Logger logger, HttpClient? httpClient = null, Func<string?>? tokenResolver = null, string? currentVersion = null)
	{
		_logger         = logger;
		_httpClient     = httpClient ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
		_ownsHttpClient = httpClient is null;
		_tokenResolver  = tokenResolver ?? ResolveGitHubToken;
		_currentVersion = NormalizeVersion(currentVersion ?? GetAssemblyInformationalVersion());
	}

	/// <summary>
	/// 最新 Release を取得して更新可否を判定する
	/// </summary>
	/// <param name="cancellationToken">キャンセル トークン</param>
	/// <param name="tagNameOnly">true のとき tag_name のみ比較し、インストーラー資産は要求しない</param>
	/// <returns>更新確認結果</returns>
	public async Task<UpdateCheckResult> CheckAsync(CancellationToken cancellationToken = default, bool tagNameOnly = false)
	{
		string mode = tagNameOnly ? "portable" : "installer";
		string? token = _tokenResolver();

		try
		{
			using HttpRequestMessage request = CreateApiRequest(HttpMethod.Get, $"/repos/{RepositoryOwner}/{RepositoryName}/releases/latest", token);
			using HttpResponseMessage response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
			if (!response.IsSuccessStatusCode) return Failure($"更新情報の取得に失敗しました（HTTP {(int)response.StatusCode}）。", mode);

			await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
			using JsonDocument document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
			UpdateReleaseInfo release = tagNameOnly ? ParseReleaseTagOnly(document.RootElement) : ParseRelease(document.RootElement);
			if (!TryParseVersion(release.Version, out Version? latestVersion) || !TryParseVersion(_currentVersion, out Version? currentVersion)) return Failure("Release のバージョン形式が不正です。", mode);

			return new UpdateCheckResult
			{
				Status         = latestVersion > currentVersion ? "available" : "not-available",
				CurrentVersion = _currentVersion,
				Release        = release,
				Mode           = mode,
			};
		}
		catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
		{
			throw;
		}
		catch (Exception ex)
		{
			_logger.Info("update", "更新情報を取得できませんでした", new Dictionary<string, object?> { ["error"] = ex.Message });
			return Failure("更新情報を取得できませんでした。ネットワーク接続を確認してください。", mode);
		}
	}

	/// <summary>
	/// インストーラーを一時フォルダへダウンロードして検証する
	/// </summary>
	/// <param name="release">更新情報</param>
	/// <param name="progress">進捗通知先</param>
	/// <param name="cancellationToken">キャンセル トークン</param>
	/// <returns>ダウンロード結果</returns>
	public async Task<UpdateDownloadResult> DownloadAsync(UpdateReleaseInfo release, IProgress<UpdateDownloadProgress>? progress = null, CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(release.InstallerName)
			|| (release.InstallerAssetId <= 0 && string.IsNullOrWhiteSpace(release.InstallerDownloadUrl)))
		{
			return new UpdateDownloadResult { Message = "インストーラー資産が見つかりません。" };
		}

		string? token = _tokenResolver();

		CancelDownload();
		using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		_downloadCancellation = linkedCancellation;
		string targetPath  = Path.Combine(Path.GetTempPath(), $"TmsMdEditor-{release.Version}-setup.exe");
		string partialPath = targetPath + ".part";

		try
		{
			using HttpRequestMessage request = CreateDownloadRequest(release, token);
			using HttpResponseMessage response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linkedCancellation.Token).ConfigureAwait(false);
			if (!response.IsSuccessStatusCode) return new UpdateDownloadResult { Message = $"インストーラーのダウンロードに失敗しました（HTTP {(int)response.StatusCode}）。" };

			long totalBytes = response.Content.Headers.ContentLength ?? release.InstallerSize;
			long downloadedBytes = 0;
			{
				await using Stream input = await response.Content.ReadAsStreamAsync(linkedCancellation.Token).ConfigureAwait(false);
				await using FileStream output = new(partialPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true);
				byte[] buffer = new byte[81920];
				int read;
				while ((read = await input.ReadAsync(buffer, linkedCancellation.Token).ConfigureAwait(false)) > 0)
				{
					await output.WriteAsync(buffer.AsMemory(0, read), linkedCancellation.Token).ConfigureAwait(false);
					downloadedBytes += read;
					progress?.Report(new UpdateDownloadProgress { DownloadedBytes = downloadedBytes, TotalBytes = totalBytes, Percent = totalBytes > 0 ? (int)Math.Min(100, downloadedBytes * 100 / totalBytes) : 0 });
				}

				await output.FlushAsync(linkedCancellation.Token).ConfigureAwait(false);
			}
			if (release.InstallerSize > 0 && downloadedBytes != release.InstallerSize) return new UpdateDownloadResult { Message = "インストーラーのサイズ検証に失敗しました。" };

			if (!string.IsNullOrWhiteSpace(release.Sha256))
			{
				await using FileStream verificationStream = File.OpenRead(partialPath);
				string actualHash = Convert.ToHexString(await SHA256.HashDataAsync(verificationStream, linkedCancellation.Token).ConfigureAwait(false));
				if (!string.Equals(actualHash, release.Sha256, StringComparison.OrdinalIgnoreCase)) return new UpdateDownloadResult { Message = "インストーラーの SHA-256 検証に失敗しました。" };
			}

			File.Move(partialPath, targetPath, overwrite: true);
			return new UpdateDownloadResult { Success = true, InstallerPath = targetPath };
		}
		catch (OperationCanceledException) when (linkedCancellation.IsCancellationRequested)
		{
			return new UpdateDownloadResult { Cancelled = true, Message = "更新のダウンロードをキャンセルしました。" };
		}
		catch (Exception ex)
		{
			_logger.Warn("update", "インストーラーのダウンロードに失敗しました", new Dictionary<string, object?> { ["error"] = ex.Message });
			return new UpdateDownloadResult { Message = "インストーラーのダウンロードに失敗しました。" };
		}
		finally
		{
			if (File.Exists(partialPath)) File.Delete(partialPath);
			if (ReferenceEquals(_downloadCancellation, linkedCancellation)) _downloadCancellation = null;
		}
	}

	/// <summary>実行中のダウンロードをキャンセルする</summary>
	public void CancelDownload() => _downloadCancellation?.Cancel();

	/// <summary>ダウンロード済みインストーラーを起動する</summary>
	/// <param name="installerPath">インストーラーパス</param>
	public void LaunchInstaller(string installerPath)
	{
		if (!File.Exists(installerPath)) throw new FileNotFoundException("インストーラーが見つかりません。", installerPath);
		Process.Start(new ProcessStartInfo(installerPath) { UseShellExecute = true });
	}

	/// <inheritdoc />
	public void Dispose()
	{
		CancelDownload();
		_downloadCancellation?.Dispose();
		if (_ownsHttpClient) _httpClient.Dispose();
	}

	internal static string NormalizeVersion(string value) => value.Trim().TrimStart('v', 'V').Split('+', '-')[0];

	internal static bool TryParseVersion(string value, out Version? version) => Version.TryParse(NormalizeVersion(value), out version);

	private static string GetAssemblyInformationalVersion()
		=> typeof(UpdateService).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
			?? typeof(UpdateService).Assembly.GetName().Version?.ToString()
			?? "0.0.0";

	private UpdateCheckResult Failure(string message, string mode = "installer") => new() { Status = "error", CurrentVersion = _currentVersion, Message = message, Mode = mode };

	private static HttpRequestMessage CreateApiRequest(HttpMethod method, string relativePath, string? token)
	{
		var request = new HttpRequestMessage(method, GitHubApiBase + relativePath);
		ApplyOptionalAuthorization(request, token);
		request.Headers.UserAgent.Add(new ProductInfoHeaderValue("TMS-MDEditor", "1.0"));
		request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
		request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
		return request;
	}

	private static HttpRequestMessage CreateDownloadRequest(UpdateReleaseInfo release, string? token)
	{
		if (!string.IsNullOrWhiteSpace(release.InstallerDownloadUrl))
		{
			var publicRequest = new HttpRequestMessage(HttpMethod.Get, release.InstallerDownloadUrl);
			publicRequest.Headers.UserAgent.Add(new ProductInfoHeaderValue("TMS-MDEditor", "1.0"));
			return publicRequest;
		}

		HttpRequestMessage request = CreateApiRequest(HttpMethod.Get, $"/repos/{RepositoryOwner}/{RepositoryName}/releases/assets/{release.InstallerAssetId}", token);
		request.Headers.Accept.Clear();
		request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
		return request;
	}

	private static void ApplyOptionalAuthorization(HttpRequestMessage request, string? token)
	{
		if (!string.IsNullOrWhiteSpace(token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
	}

	private static UpdateReleaseInfo ParseRelease(JsonElement root)
	{
		string tagName    = root.GetProperty("tag_name").GetString() ?? string.Empty;
		string releaseUrl = root.TryGetProperty("html_url", out JsonElement urlElement) ? urlElement.GetString() ?? string.Empty : string.Empty;
		string body       = root.TryGetProperty("body", out JsonElement bodyElement) ? bodyElement.GetString() ?? string.Empty : string.Empty;
		JsonElement asset = root.TryGetProperty("assets", out JsonElement assetsElement) && assetsElement.ValueKind == JsonValueKind.Array
			? assetsElement.EnumerateArray().FirstOrDefault(item => item.TryGetProperty("name", out JsonElement nameElement) && (nameElement.GetString() ?? string.Empty).EndsWith("-setup.exe", StringComparison.OrdinalIgnoreCase))
			: default;
		if (asset.ValueKind == JsonValueKind.Undefined) throw new InvalidDataException("Release にインストーラー資産がありません。");

		Match hashMatch = Sha256Pattern.Match(body);
		return new UpdateReleaseInfo
		{
			Version          = NormalizeVersion(tagName),
			TagName          = tagName,
			ReleaseUrl       = releaseUrl,
			InstallerName        = asset.GetProperty("name").GetString() ?? string.Empty,
			InstallerAssetId     = asset.GetProperty("id").GetInt64(),
			InstallerDownloadUrl = asset.TryGetProperty("browser_download_url", out JsonElement downloadUrlElement) ? downloadUrlElement.GetString() ?? string.Empty : string.Empty,
			InstallerSize        = asset.TryGetProperty("size", out JsonElement sizeElement) ? sizeElement.GetInt64() : 0,
			Sha256           = hashMatch.Success ? hashMatch.Groups[1].Value : null,
		};
	}

	/// <summary>
	/// tag_name だけを読む。インストーラー資産は要求しない。
	/// </summary>
	/// <param name="root">Release JSON</param>
	/// <returns>更新情報</returns>
	private static UpdateReleaseInfo ParseReleaseTagOnly(JsonElement root)
	{
		string tagName    = root.GetProperty("tag_name").GetString() ?? string.Empty;
		string releaseUrl = root.TryGetProperty("html_url", out JsonElement urlElement) ? urlElement.GetString() ?? string.Empty : string.Empty;
		return new UpdateReleaseInfo
		{
			Version    = NormalizeVersion(tagName),
			TagName    = tagName,
			ReleaseUrl = releaseUrl,
		};
	}

	private static string? ResolveGitHubToken()
	{
		string? processValue = Environment.GetEnvironmentVariable("GH_TOKEN", EnvironmentVariableTarget.Process);
		if (!string.IsNullOrWhiteSpace(processValue)) return processValue.Trim();

		try
		{
			using RegistryKey? environmentKey = Registry.CurrentUser.OpenSubKey("Environment");
			return environmentKey?.GetValue("GH_TOKEN") as string is { } userValue && !string.IsNullOrWhiteSpace(userValue) ? userValue.Trim() : null;
		}
		catch (Exception)
		{
			return null;
		}
	}
}
