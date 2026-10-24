// ==============================================
// ブリッジ JSON の名前と列挙の表記を揃える
// ==============================================

// Web 層との要求と応答で、プロパティ名の大文字小文字と列挙の表記を揃える
// ここを変えると Web 層がプロパティを読めなくなる

using System.Text.Json;
using System.Text.Json.Serialization;

namespace TmsMdEditor.Bridge;

/// <summary>
/// ブリッジの入出力で使い回すシリアライザ設定。状態は持たない
/// </summary>
internal static class BridgeJson
{
	/// <summary>
	/// camelCase で読み書きし、列挙は camelCase の文字列にする設定
	/// プロセス内で共有し、実行中は変えない
	/// </summary>
	public static readonly JsonSerializerOptions Options = new()
	{
		PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		PropertyNameCaseInsensitive = true,
		Converters =
		{
			new JsonStringEnumConverter(JsonNamingPolicy.CamelCase),
		},
	};
}
