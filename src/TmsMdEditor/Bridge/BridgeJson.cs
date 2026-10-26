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
	// Web 層とプロパティ名の大小、列挙の表記を揃える。片方だけ変えると JSON を読めなくなる
	public static readonly JsonSerializerOptions Options = new()
	{
		// 書き出すプロパティ名を camelCase にする。PascalCase のままでは Web 層が読めない
		PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		// 読み取り時は大小の違いを許容する。Web 層が PascalCase で送っても届く
		PropertyNameCaseInsensitive = true,
		// 列挙を camelCase の文字列にする。数値のままでは Web 層の列挙と一致しない
		Converters =
		{
			new JsonStringEnumConverter(JsonNamingPolicy.CamelCase),
		},
	};
}
