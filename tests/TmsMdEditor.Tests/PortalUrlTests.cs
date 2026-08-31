using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class PortalUrlTests
{
	private const string TestDevelopmentPortalUrl = "https://portal.dev.example/preview/#apps";

	[Fact]
	public void ResolvePortalEnvironment_uses_debug_and_env_override()
	{
		Assert.Equal(PortalEnvironment.Development, PortalUrl.ResolvePortalEnvironment(true, null));
		Assert.Equal(PortalEnvironment.Development, PortalUrl.ResolvePortalEnvironment(true, "production"));
		Assert.Equal(PortalEnvironment.Production, PortalUrl.ResolvePortalEnvironment(false, null));
		Assert.Equal(PortalEnvironment.Production, PortalUrl.ResolvePortalEnvironment(false, "production"));
		Assert.Equal(PortalEnvironment.Development, PortalUrl.ResolvePortalEnvironment(false, "development"));
	}

	[Fact]
	public void GetOfficialPortalUrl_uses_env_for_development_and_falls_back_to_production()
	{
		Assert.Equal(TestDevelopmentPortalUrl, PortalUrl.GetOfficialPortalUrl(PortalEnvironment.Development, TestDevelopmentPortalUrl));
		Assert.Equal(PortalUrl.ProductionPortalUrl, PortalUrl.GetOfficialPortalUrl(PortalEnvironment.Development, ""));
		Assert.Equal(PortalUrl.ProductionPortalUrl, PortalUrl.GetOfficialPortalUrl(PortalEnvironment.Production, TestDevelopmentPortalUrl));
		Assert.Equal(PortalUrl.ProductionPortalUrl, PortalUrl.GetOfficialPortalUrl(PortalEnvironment.Development, "http://portal.dev.example/preview/#apps"));
	}

	[Theory]
	[InlineData("https://tm-systems.jp/#apps", true)]
	[InlineData("https://tm-systems.jp/", true)]
	[InlineData("http://tm-systems.jp/#apps", false)]
	[InlineData("https://evil.example/#apps", false)]
	[InlineData("https://tm-systems.jp/#other", false)]
	[InlineData("https://tm-systems.jp/?q=1#apps", false)]
	[InlineData("https://user:pass@tm-systems.jp/#apps", false)]
	[InlineData("https://portal.dev.example/preview/#apps", false)]
	[InlineData("", false)]
	public void IsAllowedOfficialPortalUrl_allows_production_only_without_development_url(string url, bool expected)
	{
		Assert.Equal(expected, PortalUrl.IsAllowedOfficialPortalUrl(url, ""));
	}

	[Fact]
	public void IsAllowedOfficialPortalUrl_allows_configured_development_url_only()
	{
		Assert.True(PortalUrl.IsAllowedOfficialPortalUrl(TestDevelopmentPortalUrl, TestDevelopmentPortalUrl));
		Assert.True(PortalUrl.IsAllowedOfficialPortalUrl("https://portal.dev.example/preview#apps", TestDevelopmentPortalUrl));
		Assert.False(PortalUrl.IsAllowedOfficialPortalUrl("https://evil.example/#apps", TestDevelopmentPortalUrl));
		Assert.True(PortalUrl.IsAllowedOfficialPortalUrl(PortalUrl.ProductionPortalUrl, TestDevelopmentPortalUrl));
	}
}
