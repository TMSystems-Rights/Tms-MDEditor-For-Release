using System.Diagnostics;

namespace TmsMdEditor.Services;

/// <summary>
/// 公式ポータルの実行環境
/// </summary>
internal enum PortalEnvironment
{
	Development,
	Production,
}

/// <summary>
/// 公式ページ URL の解決と許可判定
/// </summary>
internal static class PortalUrl
{
	/// <summary>パッケージ版で開発ポータルへ誘導する環境変数名</summary>
	public const string PortalEnvVariableName = "TMS_MDEDITOR_PORTAL_ENV";

	/// <summary>開発ポータル URL を渡す環境変数名（ソースには URL を埋め込まない）</summary>
	public const string DevelopmentPortalUrlVariableName = "TMS_PORTAL_DEVELOPMENT_URL";

	/// <summary>本番環境の公式ページ</summary>
	public const string ProductionPortalUrl = "https://tm-systems.jp/#apps";

	private const string AllowedHash = "#apps";

	/// <summary>
	/// 実行環境から公式ポータル環境を解決する。
	/// Debug は常に development。Release は env が development のときだけ開発、それ以外は本番。
	/// </summary>
	/// <param name="isDebugBuild">Debug ビルドなら true</param>
	/// <param name="envValue">環境変数値</param>
	/// <returns>環境</returns>
	public static PortalEnvironment ResolvePortalEnvironment(bool isDebugBuild, string? envValue)
	{
		if (isDebugBuild)
		{
			return PortalEnvironment.Development;
		}

		if (string.Equals(envValue, "development", StringComparison.Ordinal))
		{
			return PortalEnvironment.Development;
		}

		return PortalEnvironment.Production;
	}

	/// <summary>
	/// 現在プロセスの公式ポータル環境を解決する
	/// </summary>
	/// <returns>環境</returns>
	public static PortalEnvironment ResolveCurrentPortalEnvironment()
	{
		return ResolvePortalEnvironment(IsDebugBuild(), ReadPortalEnvValue());
	}

	/// <summary>
	/// 環境名から公式ページ URL を返す。任意 URL は受け取らない。
	/// 開発は <paramref name="developmentUrl"/> または環境変数。未設定・不正なら本番 URL。
	/// </summary>
	/// <param name="environment">環境</param>
	/// <param name="developmentUrl">開発 URL。null のときは環境変数を読む</param>
	/// <returns>公式ページ URL</returns>
	public static string GetOfficialPortalUrl(PortalEnvironment environment, string? developmentUrl = null)
	{
		if (environment != PortalEnvironment.Development)
		{
			return ProductionPortalUrl;
		}

		string? configured = developmentUrl ?? ReadDevelopmentPortalUrl();
		return TryNormalizeDevelopmentPortalUrl(configured, out string normalized)
			? normalized
			: ProductionPortalUrl;
	}

	/// <summary>
	/// 外部起動直前の許可判定。HTTPS・ホスト・パス・ハッシュを検証する。
	/// </summary>
	/// <param name="urlString">開こうとしている URL</param>
	/// <param name="developmentUrl">開発 URL。null のときは環境変数を読む</param>
	/// <returns>許可するなら true</returns>
	public static bool IsAllowedOfficialPortalUrl(string? urlString, string? developmentUrl = null)
	{
		if (!TryParseOfficialPortalUrl(urlString, out Uri? url) || url is null)
		{
			return false;
		}

		if (IsProductionPortalUrl(url))
		{
			return true;
		}

		string? configured = developmentUrl ?? ReadDevelopmentPortalUrl();
		if (!TryParseOfficialPortalUrl(configured, out Uri? allowedDevelopment) || allowedDevelopment is null)
		{
			return false;
		}

		return OfficialPortalUrlsMatch(url, allowedDevelopment);
	}

	/// <summary>
	/// 許可済み公式ページを既定ブラウザで開く
	/// </summary>
	/// <returns>開いた URL</returns>
	public static string OpenOfficialPortal()
	{
		string? developmentUrl = ReadDevelopmentPortalUrl();
		string url = GetOfficialPortalUrl(ResolveCurrentPortalEnvironment(), developmentUrl);
		if (!IsAllowedOfficialPortalUrl(url, developmentUrl))
		{
			throw new InvalidOperationException("公式ページの URL が許可されていません。");
		}

		Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
		return url;
	}

	/// <summary>
	/// Debug ビルドかどうかを返す
	/// </summary>
	/// <returns>Debug なら true</returns>
	public static bool IsDebugBuild()
	{
#if DEBUG
		return true;
#else
		return false;
#endif
	}

	/// <summary>
	/// ポータル環境変数を読む
	/// </summary>
	/// <returns>値。未設定なら null</returns>
	public static string? ReadPortalEnvValue()
	{
		return ReadProcessOrUserEnvironmentVariable(PortalEnvVariableName);
	}

	/// <summary>
	/// 開発ポータル URL 環境変数を読む
	/// </summary>
	/// <returns>値。未設定なら null</returns>
	public static string? ReadDevelopmentPortalUrl()
	{
		return ReadProcessOrUserEnvironmentVariable(DevelopmentPortalUrlVariableName);
	}

	/// <summary>
	/// 開発 URL を正規化する
	/// </summary>
	/// <param name="urlString">候補</param>
	/// <param name="normalized">正規化後</param>
	/// <returns>使ってよいなら true</returns>
	public static bool TryNormalizeDevelopmentPortalUrl(string? urlString, out string normalized)
	{
		normalized = string.Empty;
		if (!TryParseOfficialPortalUrl(urlString, out Uri? url) || url is null)
		{
			return false;
		}

		normalized = urlString!.Trim();
		return true;
	}

	private static bool TryParseOfficialPortalUrl(string? urlString, out Uri? url)
	{
		url = null;
		if (string.IsNullOrWhiteSpace(urlString))
		{
			return false;
		}

		if (!Uri.TryCreate(urlString.Trim(), UriKind.Absolute, out Uri? parsed))
		{
			return false;
		}

		if (!string.Equals(parsed.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		if (!string.IsNullOrEmpty(parsed.UserInfo))
		{
			return false;
		}

		if (!string.IsNullOrEmpty(parsed.Query))
		{
			return false;
		}

		if (!string.IsNullOrEmpty(parsed.Fragment) && !string.Equals("#" + parsed.Fragment.TrimStart('#'), AllowedHash, StringComparison.Ordinal))
		{
			return false;
		}

		url = parsed;
		return true;
	}

	private static bool IsProductionPortalUrl(Uri url)
	{
		if (!string.Equals(url.Host, "tm-systems.jp", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		return url.AbsolutePath is "/" or "";
	}

	private static bool OfficialPortalUrlsMatch(Uri left, Uri right)
	{
		if (!string.Equals(left.Host, right.Host, StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		return string.Equals(NormalizePath(left.AbsolutePath), NormalizePath(right.AbsolutePath), StringComparison.OrdinalIgnoreCase);
	}

	private static string NormalizePath(string path)
	{
		string trimmed = path.TrimEnd('/');
		return trimmed.Length == 0 ? "/" : trimmed;
	}

	private static string? ReadProcessOrUserEnvironmentVariable(string name)
	{
		string? processValue = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Process);
		if (!string.IsNullOrWhiteSpace(processValue))
		{
			return processValue.Trim();
		}

		try
		{
			string? userValue = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);
			return string.IsNullOrWhiteSpace(userValue) ? null : userValue.Trim();
		}
		catch
		{
			return null;
		}
	}
}
