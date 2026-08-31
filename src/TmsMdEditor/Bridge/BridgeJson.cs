using System.Text.Json;
using System.Text.Json.Serialization;

namespace TmsMdEditor.Bridge;

/// <summary>
/// ブリッジ共通 JSON 設定
/// </summary>
internal static class BridgeJson
{
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
