// ==============================================
// ノート表示位置の保存とマージ
// ==============================================

// 表示位置は data ディレクトリへ保存し、同じノートは新しい時刻を残し、上限を超えた分は古いものから捨てる

using System.Text.Json;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 一時ディレクトリを AppData の代わりにして、表示位置ファイルの保存と読込を検証する
/// 差し替えは各テストの終了時に戻す。壊れたファイルは上書きしない
/// </summary>
public class NoteViewPositionStoreTests : IDisposable
{
	/// <summary>
	/// 表示位置ファイルを置く一時ルート。テストごとに作り、Dispose で削除する
	/// </summary>
	private readonly string _tempRoot;

	/// <summary>
	/// 表示位置の保存先ディレクトリを決める実設定ストア。コンストラクタで初期ファイルを作る
	/// </summary>
	private readonly ConfigStore _configStore;

	/// <summary>
	/// 検証対象。設定ストアが指す data ディレクトリへ表示位置を書く
	/// </summary>
	private readonly NoteViewPositionStore _store;

	/// <summary>
	/// AppData を一時ディレクトリへ差し替え、設定を初期化してから表示位置を操作できる状態にする
	/// </summary>
	public NoteViewPositionStoreTests()
	{
		_tempRoot = Path.Combine(Path.GetTempPath(), $"tms-mdeditor-viewpos-test-{Guid.NewGuid():N}");
		AppPaths.SetOverrideAppDataRoot(_tempRoot);
		// 設定と表示位置の両方へ渡すログ。ファイルへは書かない
		var logger = new Logger();
		// データディレクトリのポインタ。このテストでは既定の data を指す
		var bootstrapConfigStore = new BootstrapConfigStore(logger);
		_configStore = new ConfigStore(logger, bootstrapConfigStore);
		_store       = new NoteViewPositionStore(logger, _configStore);
		_configStore.Load();
	}

	/// <summary>
	/// AppData の差し替えを戻し、一時ディレクトリが残っていれば削除する
	/// </summary>
	public void Dispose()
	{
		AppPaths.SetOverrideAppDataRoot(null);
		// 一時ディレクトリが残っているときだけ削除する。無いときは何もしない
		if (Directory.Exists(_tempRoot)) Directory.Delete(_tempRoot, recursive: true);
	}

	/// <summary>
	/// 保存したアンカー、余白、パスを読み戻し、見出しの折りたたみは空になる
	/// </summary>
	[Fact]
	public void Save_and_load_round_trips_note_view_positions()
	{
		// アンカー、余白、選択範囲を持つ保存入力。折りたたみは含まない
		using JsonDocument document = JsonDocument.Parse("""
			{
			  "schemaVersion": 1,
			  "entries": [
			    {
			      "filePath": "C:\\docs\\one.md",
			      "anchor": 120,
			      "yMargin": -8.5,
			      "scrollLeft": 4,
			      "selectionAnchor": 140,
			      "selectionHead": 150,
			      "updatedAt": "2026-10-04T01:00:00.000Z"
			    }
			  ]
			}
			""");

		// 保存の成否。失敗時は Success が false で Message に理由がある
		NoteViewPositionSaveResult save = _store.Save(document.RootElement);
		// data ディレクトリから読み戻した表示位置。失敗時は Success が false
		NoteViewPositionLoadResult load = _store.Load();

		Assert.True(save.Success, save.Message);
		Assert.True(load.Success);
		// 読み戻した先頭エントリ。折りたたみは空
		JsonElement entry = load.Document.GetProperty("entries")[0];
		Assert.Equal(120, entry.GetProperty("anchor").GetInt32());
		Assert.Equal(-8.5, entry.GetProperty("yMargin").GetDouble());
		Assert.Equal("C:\\docs\\one.md", entry.GetProperty("filePath").GetString());
		Assert.Equal(NoteViewPositionStore.CurrentSchemaVersion, load.Document.GetProperty("schemaVersion").GetInt32());
		Assert.Empty(entry.GetProperty("collapsedHeadingFroms").EnumerateArray());
	}

	/// <summary>
	/// 折りたたみ位置の重複を除き、昇順で読み戻す
	/// </summary>
	[Fact]
	public void Save_and_load_round_trips_collapsed_headings()
	{
		// 重複を含む折りたたみ位置の保存結果。失敗時は Success が false
		NoteViewPositionSaveResult save = Save("""
			{
			  "schemaVersion": 2,
			  "entries": [
			    {
			      "filePath": "C:\\docs\\fold.md",
			      "anchor": 10,
			      "yMargin": 0,
			      "scrollLeft": 0,
			      "selectionAnchor": 10,
			      "selectionHead": 10,
			      "collapsedHeadingFroms": [40, 5, 40],
			      "updatedAt": "2026-10-13T01:00:00.000Z"
			    }
			  ]
			}
			""");

		// 読み戻した表示位置。折りたたみは先頭エントリにある
		NoteViewPositionLoadResult load = _store.Load();
		// 重複を除いて昇順にした折りたたみ位置。空なら保存に失敗している
		JsonElement collapsed = load.Document.GetProperty("entries")[0].GetProperty("collapsedHeadingFroms");

		Assert.True(save.Success, save.Message);
		// 同じ見出し位置は1つにし、小さい順で保存する
		Assert.Equal([5, 40], collapsed.EnumerateArray().Select(item => item.GetInt32()));
	}

	/// <summary>
	/// 新しい既存エントリは残し、別パスは追加して、新しい順に並ぶ
	/// </summary>
	[Fact]
	public void Save_keeps_newer_existing_entry_and_adds_new_path()
	{
		Save("""
			{
			  "schemaVersion": 1,
			  "entries": [
			    {
			      "filePath": "C:\\docs\\a.md",
			      "anchor": 3,
			      "yMargin": 0,
			      "scrollLeft": 0,
			      "selectionAnchor": 3,
			      "selectionHead": 3,
			      "updatedAt": "2026-10-04T03:00:00.000Z"
			    }
			  ]
			}
			""");

		// 区切り文字と大文字小文字が違っても同じファイルとみなし、古い時刻では上書きしない
		// その2件を保存した結果。失敗時は Success が false
		NoteViewPositionSaveResult save = Save("""
			{
			  "schemaVersion": 1,
			  "entries": [
			    {
			      "filePath": "c:/docs/a.md",
			      "anchor": 1,
			      "yMargin": 0,
			      "scrollLeft": 0,
			      "selectionAnchor": 1,
			      "selectionHead": 1,
			      "updatedAt": "2026-10-04T01:00:00.000Z"
			    },
			    {
			      "filePath": "C:\\docs\\b.md",
			      "anchor": 4,
			      "yMargin": 0,
			      "scrollLeft": 0,
			      "selectionAnchor": 4,
			      "selectionHead": 4,
			      "updatedAt": "2026-10-04T04:00:00.000Z"
			    }
			  ]
			}
			""");

		// 新しい順に並んだ保存後の表示位置
		NoteViewPositionLoadResult load = _store.Load();
		Assert.True(save.Success, save.Message);
		// 先頭が b.md、2件目の anchor は上書きされず 3 のまま
		JsonElement entries = load.Document.GetProperty("entries");
		Assert.Equal(2, entries.GetArrayLength());
		Assert.Equal("C:\\docs\\b.md", entries[0].GetProperty("filePath").GetString());
		Assert.Equal(3, entries[1].GetProperty("anchor").GetInt32());
	}

	/// <summary>
	/// 上限を超えた分は古いエントリから捨て、最新が先頭に残る
	/// </summary>
	[Fact]
	public void Save_drops_entries_beyond_the_limit()
	{
		// 上限より1件多いエントリ JSON。index が大きいほど新しい
		List<string> entries = [];
		for (int index = 0; index < NoteViewPositionStore.MaxEntries + 1; index++)
		{
			// 基準時刻から index 秒後の更新時刻。文字列はラウンドトリップ形式
			string updatedAt = DateTimeOffset.Parse("2026-10-04T00:00:00Z").AddSeconds(index).ToString("o");
			entries.Add($$"""
				{
				  "filePath": "C:\\docs\\{{index}}.md",
				  "anchor": {{index}},
				  "yMargin": 0,
				  "scrollLeft": 0,
				  "selectionAnchor": 0,
				  "selectionHead": 0,
				  "updatedAt": "{{updatedAt}}"
				}
				""");
		}

		// 上限超過の一覧を保存した結果。失敗時は Success が false
		NoteViewPositionSaveResult save = Save($$"""{"schemaVersion":1,"entries":[{{string.Join(',', entries)}}]}""");
		// 保存後に読み戻した表示位置
		NoteViewPositionLoadResult load = _store.Load();

		Assert.True(save.Success, save.Message);
		// 新しい方から上限件だけ残したエントリ。最も古い anchor 0 は含まない
		JsonElement stored = load.Document.GetProperty("entries");
		Assert.Equal(NoteViewPositionStore.MaxEntries, stored.GetArrayLength());
		// 残すのは新しい方から上限件で、最も古い anchor 0 は落ちる
		Assert.Equal(NoteViewPositionStore.MaxEntries, stored[0].GetProperty("anchor").GetInt32());
		Assert.All(stored.EnumerateArray(), entry => Assert.NotEqual(0, entry.GetProperty("anchor").GetInt32()));
	}

	/// <summary>
	/// 未対応のスキーマは保存せず、表示位置ファイルを作らない
	/// </summary>
	[Fact]
	public void Save_rejects_unknown_schema_version()
	{
		// 未対応の schemaVersion 99。保存してはいけない
		using JsonDocument document = JsonDocument.Parse("""{"schemaVersion":99,"entries":[]}""");

		// 拒否された保存結果。Success は false で、ファイルは作らない
		NoteViewPositionSaveResult result = _store.Save(document.RootElement);

		Assert.False(result.Success);
		Assert.False(File.Exists(AppPaths.GetNoteViewPositionsPath(AppPaths.DefaultDataDir)));
	}

	/// <summary>
	/// 壊れた表示位置は失敗にして空のエントリを返し、ファイルの中身は壊れたまま残す
	/// </summary>
	[Fact]
	public void Load_ignores_corrupt_file_without_replacing_it()
	{
		// 壊れた JSON を置く表示位置ファイル。Load 後もこの中身のまま残る
		string path = AppPaths.GetNoteViewPositionsPath(AppPaths.DefaultDataDir);
		File.WriteAllText(path, "{broken");

		// 壊れたファイルの読込結果。Success は false で、エントリは空
		NoteViewPositionLoadResult result = _store.Load();

		Assert.False(result.Success);
		Assert.Equal(0, result.Document.GetProperty("entries").GetArrayLength());
		Assert.Equal("{broken", File.ReadAllText(path));
	}

	/// <summary>
	/// JSON 文字列を表示位置の保存へ渡す
	/// </summary>
	/// <param name="json">保存する文書。スキーマが不正なら失敗結果になる。null は渡さない</param>
	/// <returns>保存結果。マージ後の内容は Load で見る</returns>
	private NoteViewPositionSaveResult Save(string json)
	{
		// 渡した JSON を要素へした保存入力。不正な JSON はこの前に失敗する
		using JsonDocument document = JsonDocument.Parse(json);
		return _store.Save(document.RootElement);
	}
}
