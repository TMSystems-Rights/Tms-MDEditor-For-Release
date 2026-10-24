// ==============================================
// セッションと表示位置が共有する JSON キーを固定する
// ==============================================

// セッションと表示位置がディスク上で共有するキーだけを持つ。値の検証は各ストアが行う

namespace TmsMdEditor.Services;

/// <summary>
/// dataDir 配下の JSON で、版と配列項目に使うプロパティ名
/// ログの追加項目名とは別である
/// </summary>
internal static class StoredJsonProperty
{
	/// <summary>
	/// 文書の版を表すプロパティ名。値は数値で、各ストアが現行版と比較する
	/// </summary>
	public const string SchemaVersion = "schemaVersion";

	/// <summary>
	/// 配列で持つ項目一覧のプロパティ名。中身の形は文書ごとに違う
	/// </summary>
	public const string Entries       = "entries";
}
