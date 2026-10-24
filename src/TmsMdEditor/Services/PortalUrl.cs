// ==============================================
// 公式ページ URL の解決
// ==============================================

// ソースに開発用 URL を埋めない。開いてよいホストは本番の固定 URL か、環境変数で渡された開発 URL だけである

using System.Diagnostics;

namespace TmsMdEditor.Services;

/// <summary>
/// 公式ポータルを、開発用と本番のどちらとして扱うか。URL そのものは持たない
/// </summary>
internal enum PortalEnvironment
{
	/// <summary>
	/// 開発用ポータル。Debug では常にこれになり、URL は環境変数から読む
	/// </summary>
	Development,

	/// <summary>
	/// 本番の公式ページ。Release で開発指定が無いときの既定
	/// </summary>
	Production,
}

/// <summary>
/// 公式ページの URL を環境から決め、外部起動の直前にホストとハッシュを許可判定する
/// 任意の URL は受け取らず、判定を通らなければブラウザを開かない
/// </summary>
internal static class PortalUrl
{
	// ==============================================
	// 許可する URL
	// ==============================================

	/// <summary>
	/// パッケージ版で開発ポータルへ誘導する環境変数名。値は development のときだけ開発扱いにする
	/// </summary>
	public const string PortalEnvVariableName = "TMS_MDEDITOR_PORTAL_ENV";

	/// <summary>
	/// 開発ポータル URL を渡す環境変数名。ソースには URL を埋め込まない
	/// </summary>
	public const string DevelopmentPortalUrlVariableName = "TMS_PORTAL_DEVELOPMENT_URL";

	/// <summary>
	/// 本番環境の公式ページ。開発 URL が未設定または不正なときの代替にも使う
	/// </summary>
	public const string ProductionPortalUrl = "https://tm-systems.jp/#apps";

	/// <summary>
	/// 公式ページで許すフラグメント。これ以外のハッシュは拒否する
	/// </summary>
	private const string AllowedHash = "#apps";

	// ==============================================
	// 環境と起動
	// ==============================================

	/// <summary>
	/// 実行環境から公式ポータル環境を決める
	/// Debug は常に development。Release は環境変数が development のときだけ開発、それ以外は本番
	/// </summary>
	/// <param name="isDebugBuild">Debug ビルドなら true。true のときは環境変数を見ない</param>
	/// <param name="envValue">環境変数の値。null や development 以外は本番</param>
	/// <returns>開発用か本番か</returns>
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
	/// 現在プロセスのビルドと環境変数から、公式ポータル環境を決める
	/// </summary>
	/// <returns>Debug なら開発用。Release は環境変数が development のときだけ開発用</returns>
	public static PortalEnvironment ResolveCurrentPortalEnvironment()
	{
		return ResolvePortalEnvironment(IsDebugBuild(), ReadPortalEnvValue());
	}

	/// <summary>
	/// 環境名から公式ページ URL を返す。任意 URL は受け取らない
	/// 開発は引数または環境変数。未設定か不正なら本番 URL
	/// </summary>
	/// <param name="environment">解決する環境。開発以外は本番 URL を返す</param>
	/// <param name="developmentUrl">開発 URL。null のときは環境変数を読む</param>
	/// <returns>許可判定前の公式ページ URL。開発 URL が不正なら本番 URL</returns>
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
	/// 外部起動直前の許可判定。HTTPS、ホスト、パス、ハッシュを検証する
	/// </summary>
	/// <param name="urlString">開こうとしている URL。null や空は拒否</param>
	/// <param name="developmentUrl">開発 URL。null のときは環境変数を読む。本番 URL はこの値と無関係に許可する</param>
	/// <returns>本番 URL か、設定済みの開発 URL と一致すれば true</returns>
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
	/// 許可済みの公式ページを既定ブラウザで開く。許可を通らなければ開かない
	/// </summary>
	/// <returns>開いた URL</returns>
	/// <exception cref="InvalidOperationException">解決した URL が許可判定を通らない</exception>
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
	/// コンパイル時に DEBUG が定義されていれば true を返す。実行中の環境変数は見ない
	/// </summary>
	/// <returns>Debug ビルドなら true。Release では false</returns>
	public static bool IsDebugBuild()
	{
#if DEBUG
		return true;
#else
		return false;
#endif
	}

	/// <summary>
	/// ポータル環境の環境変数を、プロセス、無ければユーザーから読む
	/// </summary>
	/// <returns>空白を除いた値。未設定なら null</returns>
	public static string? ReadPortalEnvValue()
	{
		return ReadProcessOrUserEnvironmentVariable(PortalEnvVariableName);
	}

	/// <summary>
	/// 開発ポータル URL の環境変数を、プロセス、無ければユーザーから読む
	/// </summary>
	/// <returns>空白を除いた URL。未設定なら null</returns>
	public static string? ReadDevelopmentPortalUrl()
	{
		return ReadProcessOrUserEnvironmentVariable(DevelopmentPortalUrlVariableName);
	}

	/// <summary>
	/// 開発 URL を、公式ページとして開いてよいか検証し、前後の空白を除く
	/// </summary>
	/// <param name="urlString">候補。null や空白、HTTPS 以外は失敗</param>
	/// <param name="normalized">成功時は trim した元の文字列。失敗時は空文字</param>
	/// <returns>ユーザー情報もクエリも無く、フラグメントは無しか #apps のとき true</returns>
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

	// ==============================================
	// URL の照合
	// ==============================================

	/// <summary>
	/// HTTPS の絶対 URL で、ユーザー情報とクエリが無く、フラグメントは無しか #apps のものだけを受ける
	/// </summary>
	/// <param name="urlString">解析する文字列。null や空白は失敗</param>
	/// <param name="url">成功時の URI。失敗時は null</param>
	/// <returns>条件を満たせば true</returns>
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

	/// <summary>
	/// 本番の公式ホストで、パスがルートであるかを返す。フラグメントは呼び出し側が別に見る
	/// </summary>
	/// <param name="url">比較する URI。ホストは大文字小文字を無視する</param>
	/// <returns>ホストが tm-systems.jp で、パスが / または空なら true</returns>
	private static bool IsProductionPortalUrl(Uri url)
	{
		if (!string.Equals(url.Host, "tm-systems.jp", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		return url.AbsolutePath is "/" or "";
	}

	/// <summary>
	/// 開発 URL どうしを、ホストと末尾スラッシュを除いたパスで比較する
	/// </summary>
	/// <param name="left">開こうとしている URL</param>
	/// <param name="right">環境変数から許可した URL</param>
	/// <returns>ホストとパスが一致すれば true。クエリとフラグメントは見ない</returns>
	private static bool OfficialPortalUrlsMatch(Uri left, Uri right)
	{
		if (!string.Equals(left.Host, right.Host, StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		return string.Equals(NormalizePath(left.AbsolutePath), NormalizePath(right.AbsolutePath), StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// パス末尾のスラッシュを除く。空になったらルートとして / を返す
	/// </summary>
	/// <param name="path">比較する絶対パス</param>
	/// <returns>末尾スラッシュを除いたパス。空なら /</returns>
	private static string NormalizePath(string path)
	{
		string trimmed = path.TrimEnd('/');
		return trimmed.Length == 0 ? "/" : trimmed;
	}

	/// <summary>
	/// 環境変数をプロセスから読み、空白だけならユーザー環境変数へ落ちる。ユーザー読み取りの失敗は null
	/// </summary>
	/// <param name="name">環境変数名</param>
	/// <returns>前後の空白を除いた値。両方とも未設定、またはユーザー読み取りに失敗したら null</returns>
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
