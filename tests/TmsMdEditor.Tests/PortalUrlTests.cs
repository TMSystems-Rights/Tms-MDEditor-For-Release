// ==============================================
// 公式ポータル URL の許可
// ==============================================

// デバッグと環境変数で開発と本番を分け、許可する公式ポータルは本番と設定した開発用 URL に限る

using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// ポータル環境の解決と、公式 URL の許可判定を固定する
/// ネットワークへは接続せず、引数で渡した URL だけを見る
/// </summary>
public sealed class PortalUrlTests
{
	/// <summary>
	/// 開発環境として許可するポータル URL。本番のホストではなく、このテストだけが使う
	/// </summary>
	private const string TestDevelopmentPortalUrl = "https://portal.dev.example/preview/#apps";

	/// <summary>
	/// デバッグビルドは環境変数より優先して開発になり、リリースでは development の指定があるときだけ開発になる
	/// </summary>
	[Fact]
	public void ResolvePortalEnvironment_uses_debug_and_env_override()
	{
		Assert.Equal(PortalEnvironment.Development, PortalUrl.ResolvePortalEnvironment(true, null));
		Assert.Equal(PortalEnvironment.Development, PortalUrl.ResolvePortalEnvironment(true, "production"));
		Assert.Equal(PortalEnvironment.Production, PortalUrl.ResolvePortalEnvironment(false, null));
		Assert.Equal(PortalEnvironment.Production, PortalUrl.ResolvePortalEnvironment(false, "production"));
		Assert.Equal(PortalEnvironment.Development, PortalUrl.ResolvePortalEnvironment(false, "development"));
	}

	/// <summary>
	/// 開発環境では渡した https の URL を使い、空や https 以外、本番環境では本番 URL に戻す
	/// </summary>
	[Fact]
	public void GetOfficialPortalUrl_uses_env_for_development_and_falls_back_to_production()
	{
		Assert.Equal(TestDevelopmentPortalUrl, PortalUrl.GetOfficialPortalUrl(PortalEnvironment.Development, TestDevelopmentPortalUrl));
		Assert.Equal(PortalUrl.ProductionPortalUrl, PortalUrl.GetOfficialPortalUrl(PortalEnvironment.Development, ""));
		Assert.Equal(PortalUrl.ProductionPortalUrl, PortalUrl.GetOfficialPortalUrl(PortalEnvironment.Production, TestDevelopmentPortalUrl));
		Assert.Equal(PortalUrl.ProductionPortalUrl, PortalUrl.GetOfficialPortalUrl(PortalEnvironment.Development, "http://portal.dev.example/preview/#apps"));
	}

	/// <summary>
	/// 開発用 URL が空のときは、パスとフラグメントが一致する本番の https URL だけを許可する
	/// </summary>
	/// <param name="url">判定する URL。空文字は不許可で、null は渡さない</param>
	/// <param name="expected">開発用 URL が空のときの許可結果</param>
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

	/// <summary>
	/// 設定した開発用 URL と本番 URL を許可し、フラグメント直前のスラッシュ違いは同一とみなし、別ホストは拒否する
	/// </summary>
	[Fact]
	public void IsAllowedOfficialPortalUrl_allows_configured_development_url_only()
	{
		Assert.True(PortalUrl.IsAllowedOfficialPortalUrl(TestDevelopmentPortalUrl, TestDevelopmentPortalUrl));
		Assert.True(PortalUrl.IsAllowedOfficialPortalUrl("https://portal.dev.example/preview#apps", TestDevelopmentPortalUrl));
		Assert.False(PortalUrl.IsAllowedOfficialPortalUrl("https://evil.example/#apps", TestDevelopmentPortalUrl));
		Assert.True(PortalUrl.IsAllowedOfficialPortalUrl(PortalUrl.ProductionPortalUrl, TestDevelopmentPortalUrl));
	}
}
