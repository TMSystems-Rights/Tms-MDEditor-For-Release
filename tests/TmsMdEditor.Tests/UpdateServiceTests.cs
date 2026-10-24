// ==============================================
// 更新確認とインストーラの検証
// ==============================================

// 認証なしのリリース応答から更新の有無を決め、ダウンロードはサイズと SHA-256 が一致するときだけ成功にする

using System.Net;
using System.Text;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// HTTP はテスト内のスタブへ差し替え、GitHub へは接続しない
/// ダウンロードしたインストーラは検証のあと削除する
/// </summary>
public sealed class UpdateServiceTests
{
	/// <summary>
	/// タグの接頭辞と空白、セマンティックバージョンの接尾辞を除いた3桁の版にする
	/// </summary>
	/// <param name="source">タグや空白、プレビュー用の接尾辞を含んでよい版の文字列。null は渡さない</param>
	/// <param name="expected">比較に使うメジャー.マイナー.パッチ</param>
	[Theory]
	[InlineData("v1.2.3", "1.2.3")]
	[InlineData("  V2.0.0-preview+build ", "2.0.0")]
	public void NormalizeVersion_removes_tag_prefix_and_semantic_suffix(string source, string expected)
	{
		Assert.Equal(expected, UpdateService.NormalizeVersion(source));
	}

	/// <summary>
	/// 認証なしの最新リリース応答を、更新ありとインストーラ情報として返す
	/// </summary>
	[Fact]
	public async Task CheckAsync_returns_available_release_without_authentication()
	{
		var handler = new StubHttpMessageHandler(_ => JsonResponse("""
		{
		  "tag_name": "v1.2.0",
		  "html_url": "https://example.test/releases/v1.2.0",
		  "body": "SHA-256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		  "assets": [{ "id": 42, "name": "TmsMdEditor-1.2.0-setup.exe", "size": 12, "browser_download_url": "https://example.test/TmsMdEditor-1.2.0-setup.exe" }]
		}
		"""));
		using var client = new HttpClient(handler);
		using var service = new UpdateService(new Logger(), client, "1.0.0");

		UpdateCheckResult result = await service.CheckAsync();

		Assert.Equal("available", result.Status);
		Assert.Equal("1.2.0", result.Release?.Version);
		Assert.Equal(42, result.Release?.InstallerAssetId);
		Assert.Equal("https://example.test/TmsMdEditor-1.2.0-setup.exe", result.Release?.InstallerDownloadUrl);
		Assert.Null(handler.LastRequest?.Headers.Authorization);
	}

	/// <summary>
	/// タグ名だけの確認ではインストーラが無くても更新ありとなり、モードはポータブルになる
	/// </summary>
	[Fact]
	public async Task CheckAsync_tag_name_only_succeeds_without_installer_asset()
	{
		var handler = new StubHttpMessageHandler(_ => JsonResponse("""
		{
		  "tag_name": "v1.2.0",
		  "html_url": "https://example.test/releases/v1.2.0",
		  "assets": [{ "id": 9, "name": "TMS-MDEditor-1.2.0-portable-x64.zip", "size": 4 }]
		}
		"""));
		using var client = new HttpClient(handler);
		using var service = new UpdateService(new Logger(), client, "1.0.0");

		UpdateCheckResult result = await service.CheckAsync(tagNameOnly: true);

		Assert.Equal("available", result.Status);
		Assert.Equal("portable", result.Mode);
		Assert.Equal("1.2.0", result.Release?.Version);
		Assert.True(string.IsNullOrEmpty(result.Release?.InstallerName));
	}

	/// <summary>
	/// サイズと SHA-256 が一致したインストーラの実体を返し、要求に認証ヘッダは付かない。
	/// </summary>
	[Fact]
	public async Task DownloadAsync_verifies_size_and_sha256_before_returning_installer()
	{
		byte[] content = Encoding.UTF8.GetBytes("verified installer content");
		string hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(content));
		var handler = new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
		{
			Content = new ByteArrayContent(content),
		});
		using var client = new HttpClient(handler);
		using var service = new UpdateService(new Logger(), client, "1.0.0");
		var release = new UpdateReleaseInfo
		{
			Version              = "1.2.0",
			InstallerName        = "TmsMdEditor-1.2.0-setup.exe",
			InstallerAssetId     = 42,
			InstallerDownloadUrl = "https://example.test/TmsMdEditor-1.2.0-setup.exe",
			InstallerSize        = content.Length,
			Sha256               = hash,
		};

		UpdateDownloadResult result = await service.DownloadAsync(release);

		try
		{
			Assert.True(result.Success);
			Assert.NotNull(result.InstallerPath);
			Assert.Equal(content, await File.ReadAllBytesAsync(result.InstallerPath!));
			Assert.Equal(new Uri("https://example.test/TmsMdEditor-1.2.0-setup.exe"), handler.LastRequest?.RequestUri);
			Assert.Null(handler.LastRequest?.Headers.Authorization);
		}
		finally
		{
			if (result.InstallerPath is { } installerPath && File.Exists(installerPath)) File.Delete(installerPath);
		}
	}

	/// <summary>
	/// 更新確認の応答として、固定した JSON を 200 で返す
	/// </summary>
	/// <param name="json">本文。UTF-8 の application/json。空でも応答自体は成功にする</param>
	/// <returns>成功の HTTP 応答</returns>
	private static HttpResponseMessage JsonResponse(string json) => new(HttpStatusCode.OK)
	{
		Content = new StringContent(json, Encoding.UTF8, "application/json"),
	};

	/// <summary>
	/// 更新確認の HTTP を、テストが渡した応答へ差し替える
	/// 最後に受け取った要求を残し、認証ヘッダの有無を検証できるようにする
	/// </summary>
	private sealed class StubHttpMessageHandler : HttpMessageHandler
	{
		/// <summary>
		/// 要求ごとの応答を決める関数。テストが固定し、実行中は変えない
		/// </summary>
		private readonly Func<HttpRequestMessage, HttpResponseMessage> _handler;

		/// <summary>
		/// 応答関数を固定する
		/// </summary>
		/// <param name="handler">要求を受け取り、返す応答。null は渡さない</param>
		public StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) => _handler = handler;

		/// <summary>
		/// 最後に届いた要求。まだ送っていなければ null
		/// テストが認証ヘッダと URL を見るために残す
		/// </summary>
		public HttpRequestMessage? LastRequest { get; private set; }

		/// <summary>
		/// 要求を LastRequest に残し、固定した応答を完了結果として返す
		/// </summary>
		/// <param name="request">検証対象の要求。null は渡さない</param>
		/// <param name="cancellationToken">未使用。キャンセルしても固定した応答を返す</param>
		/// <returns>固定した応答を持つ完了タスク</returns>
		protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
		{
			LastRequest = request;
			return Task.FromResult(_handler(request));
		}
	}
}
