using System.Net;
using System.Text;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class UpdateServiceTests
{
	[Theory]
	[InlineData("v1.2.3", "1.2.3")]
	[InlineData("  V2.0.0-preview+build ", "2.0.0")]
	public void NormalizeVersion_removes_tag_prefix_and_semantic_suffix(string source, string expected)
	{
		Assert.Equal(expected, UpdateService.NormalizeVersion(source));
	}

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

	private static HttpResponseMessage JsonResponse(string json) => new(HttpStatusCode.OK)
	{
		Content = new StringContent(json, Encoding.UTF8, "application/json"),
	};

	private sealed class StubHttpMessageHandler : HttpMessageHandler
	{
		private readonly Func<HttpRequestMessage, HttpResponseMessage> _handler;

		public StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) => _handler = handler;

		public HttpRequestMessage? LastRequest { get; private set; }

		protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
		{
			LastRequest = request;
			return Task.FromResult(_handler(request));
		}
	}
}
