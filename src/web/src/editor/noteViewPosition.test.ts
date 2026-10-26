/**
 * 表示位置の記録、マージ、スクロール復元の計算を検証する
 * 実画面の追従ループは持たず、計算とメモリ上の記録だけを見る
 * @file
 */
import { describe, expect, it } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { NOTE_VIEW_POSITION_LIMIT, captureNoteViewPosition, isRestoredScrollLayoutReady, captureNoteViewPositionFromMetrics, computeRestoredScrollTop, mergeNoteViewPositionRecords, normalizeNoteViewPositionDocument, NoteViewPositionMemory, selectionFromNoteViewPosition, type NoteViewPositionRecord } from './noteViewPosition';

/**
 * テスト用の表示位置記録を作る
 * 上書きしない項目は、固定のパスと時刻とオフセットにする
 * @param overrides - 差し替える項目。未指定時はすべて固定値
 * @returns 固定値に overrides を重ねた記録
 */
function record(overrides: Partial<NoteViewPositionRecord> = {}): NoteViewPositionRecord {
	// 固定値に overrides を重ねた記録。未指定の項目はテスト用の定数
	return {
		// 固定のノートパス。overrides が無いときのキー
		filePath: 'C:\\docs\\note.md',
		// 固定の更新時刻。新しい記録との比較に使う
		updatedAt: '2026-10-04T01:00:00.000Z',
		// 固定の行位置。文書オフセット
		anchor: 120,
		// 行上端からのずれ。px。上にはみ出すときは負
		yMargin: -8,
		// 固定の横スクロール。px。0 は左端
		scrollLeft: 0,
		// 固定の選択起点。文書オフセット
		selectionAnchor: 140,
		// 固定の選択終点。文書オフセット
		selectionHead: 150,
		// 折りたたんだ見出しの開始位置。固定値では空
		collapsedHeadingFroms: [],
		// 呼び出し側が差し替える項目。未指定なら上の固定値のまま
		...overrides
	};
}

describe('noteViewPosition', () => {
	it('ビューポート上端の行と選択範囲を記録する', () => {
		// 上端の行と選択。スクロールは行の途中
		expect(
			captureNoteViewPositionFromMetrics({
				// 縦スクロール。px。行の上端より下
				scrollTop: 100,
				// 横スクロール。px。左端ではない
				scrollLeft: 12,
				// 見えている行の文書位置
				blockFrom: 80,
				// その行の上端。px。scrollTop より上なので負のずれになる
				blockTop: 76,
				// 選択の起点。文書オフセット
				selectionAnchor: 90,
				// 選択の終点。文書オフセット。空のキャレットではない
				selectionHead: 94,
				// 折りたたみ。空は折りたたんでいない
				collapsedHeadingFroms: [],
				// 文書長。範囲外の切り詰めには使わない
				docLength: 200
			})
		).toEqual({
			// 記録する行位置。blockFrom と同じ
			anchor: 80,
			// 行上端からビューポート上端までのずれ。px。負は行が上にはみ出す
			yMargin: -24,
			// 記録する横スクロール。px
			scrollLeft: 12,
			// 記録する選択の起点
			selectionAnchor: 90,
			// 記録する選択の終点
			selectionHead: 94,
			// 折りたたみ。空は保存しない
			collapsedHeadingFroms: []
		});
	});

	it('文書長を超える選択と行位置を切り詰める', () => {
		// 文書長 20 を超える行位置と選択。はみ出しは文書末尾へ切り詰める
		const position = captureNoteViewPositionFromMetrics({
			// 縦スクロール。px。先頭
			scrollTop: 0,
			// 横スクロール。px。負は左端へ戻す
			scrollLeft: -4,
			// 行位置。文書長を超える
			blockFrom: 999,
			// 行の上端。px
			blockTop: 10,
			// 選択の起点。文書長を超える
			selectionAnchor: 999,
			// 選択の終点。起点よりさらに先
			selectionHead: 1000,
			// 文書長。これを超える位置は末尾になる
			docLength: 20
		});
		expect(position.anchor).toBe(20);
		expect(position.scrollLeft).toBe(0);
		// 切り詰めたあとの選択。起点と終点はどちらも文書末尾
		expect(selectionFromNoteViewPosition(position, 20)).toEqual({
			// 選択の起点。文書末尾
			anchor: 20,
			// 選択の終点。空のキャレット
			head: 20
		});
	});

	it('高さマップ上の行を記録し、計測の強制実行はしない', () => {
		// 高さマップ上の 2 行。2 行目の上端がスクロール位置に重なる
		const blocks = [
			{
				// 1 行目の開始。文書先頭
				from: 0,
				// 1 行目の終了。文書オフセット
				to: 10,
				// 1 行目の上端。px
				top: 0,
				// 1 行目の下端。px
				bottom: 40
			},
			{
				// 2 行目の開始。スクロール位置 100 はこの行に入る
				from: 11,
				// 2 行目の終了。文書末尾
				to: 40,
				// 2 行目の上端。px。scrollTop より上
				top: 80,
				// 2 行目の下端。px
				bottom: 140
			}
		];
		// 高さからの検索を呼んだ印。false のままなら強制計測していない
		let flushed  = false;
		// 行塊とスクロールだけを持つビュー。描画はしない
		const view   = {
			// 接続済みのスクロール要素。縦 100px、横 4px
			scrollDOM: {
				// 文書へ接続済み。外れていると記録しない
				isConnected: true,
				// 縦スクロール。px。2 行目の途中
				scrollTop: 100,
				// 横スクロール。px
				scrollLeft: 4
			},
			/**
			 * 文書位置を含む行塊を返す。高さの再計測はしない
			 * @param pos - 探す文書オフセット。どの行塊にも入らなければ最後の行塊
			 * @returns from、to、top、bottom を持つ行塊
			 */
			lineBlockAt(pos: number) {
				return blocks.find((block) => pos >= block.from && pos <= block.to) ?? blocks[blocks.length - 1];
			},
			/**
			 * 高さからの検索は、このテストではレイアウトを走らせた印として失敗させる
			 */
			lineBlockAtHeight() {
				flushed = true;
				throw new Error('layout flush');
			},
			// 選択と文書長。高さマップの行と別に記録する
			state: {
				// 主選択。空のキャレットではない
				selection: {
					main: {
						// 選択の起点。2 行目の中
						anchor: 12,
						// 選択の終点
						head: 18
					}
				},
				// 文書長。2 行目の終了と同じ
				doc: { length: 40 }
			}
		} as unknown as EditorView;

		// 高さマップから記録した位置。強制計測はしていない
		expect(captureNoteViewPosition(view)).toEqual({
			// 見えている行。2 行目の開始
			anchor: 11,
			// 行上端からスクロール位置までのずれ。px。負は行が上にはみ出す
			yMargin: -20,
			// 横スクロール。px
			scrollLeft: 4,
			// 選択の起点
			selectionAnchor: 12,
			// 選択の終点
			selectionHead: 18,
			// 折りたたみ。このビューは持たないので空
			collapsedHeadingFroms: []
		});
		expect(flushed).toBe(false);
	});

	it('行アンカーをスクロール範囲内の scrollTop へ戻す', () => {
		expect(computeRestoredScrollTop(200, -24, 1000)).toBe(224);
		expect(computeRestoredScrollTop(10, 40, 1000)).toBe(0);
		expect(computeRestoredScrollTop(500, -100, 300)).toBe(300);
		expect(isRestoredScrollLayoutReady(8000, -20, 7500)).toBe(false);
		expect(isRestoredScrollLayoutReady(8000, -20, 8020)).toBe(true);
	});

	it('壊れた記録を捨て、同じパスは新しい方を残す', () => {
		// 同じパスの新旧と、壊れた記録。残るのは新しい 1 件
		const records = normalizeNoteViewPositionDocument({
			// 読める版。これ以外は空になる
			schemaVersion: 1,
			// 古い記録、新しい記録、項目不足、空白パス
			entries: [
				record({
					// 古い更新時刻
					updatedAt: '2026-10-04T01:00:00.000Z',
					// 古い行位置。新しい記録に負ける
					anchor: 1
				}),
				record({
					// 同じノート。区切りだけが違う
					filePath: 'c:/docs/note.md',
					// 新しい更新時刻。こちらを残す
					updatedAt: '2026-10-04T02:00:00.000Z',
					// 残す行位置
					anchor: 2
				}),
				{
					// 時刻も行位置も無い。壊れた記録として捨てる
					filePath: 'C:\\docs\\broken.md'
				},
				record({
					// 空白だけのパス。記録にしない
					filePath: ' ',
					// 時刻があってもパスが空なら捨てる
					updatedAt: '2026-10-04T03:00:00.000Z'
				})
			]
		});

		expect(records).toHaveLength(1);
		// 残った記録。パスと行位置だけを見る
		expect(records[0]).toMatchObject({
			// 新しい方のパス
			filePath: 'c:/docs/note.md',
			// 新しい方の行位置
			anchor: 2
		});
		// 未知の版。entries が空でなくても読まない
		expect(
			normalizeNoteViewPositionDocument({
				// 対応していない版
				schemaVersion: 99,
				// 中身は見ない
				entries: []
			})
		).toEqual([]);
		// 版 1 は折りたたみを保存しない。渡しても空になる
		expect(
			normalizeNoteViewPositionDocument({
				// 折りたたみを持たない版
				schemaVersion: 1,
				// 版 1 の記録。折りたたみは捨てる
				entries: [
					record({
						// 版 1 では捨てる折りたたみ位置
						collapsedHeadingFroms: [4]
					})
				]
			})[0].collapsedHeadingFroms
		).toEqual([]);
		// 版 2 は折りたたみを昇順かつ重複なしで残す
		expect(
			normalizeNoteViewPositionDocument({
				// 折りたたみを保存する版
				schemaVersion: 2,
				// 版 2 の記録。折りたたみを残す
				entries: [
					record({
						// 順不同で重複がある折りたたみ位置
						collapsedHeadingFroms: [8, 4, 8]
					})
				]
			})[0].collapsedHeadingFroms
		).toEqual([4, 8]);
	});

	it('他ウィンドウの新しい記録を残し、上限を超えた古い記録を捨てる', () => {
		// 今のウィンドウの記録。a は相手より新しい
		const current  = [
			record({
				// 同じノート
				filePath: 'C:\\docs\\a.md',
				// 残す側の更新時刻
				updatedAt: '2026-10-04T03:00:00.000Z',
				// 残す行位置
				anchor: 3
			})
		];
		// 他ウィンドウ。a は古く、b は新しい
		const incoming = [
			record({
				// 今の記録より古い a
				filePath: 'C:\\docs\\a.md',
				// 捨てる側の更新時刻
				updatedAt: '2026-10-04T01:00:00.000Z',
				// 捨てる行位置
				anchor: 1
			}),
			record({
				// 今の記録に無いノート
				filePath: 'C:\\docs\\b.md',
				// 追加する更新時刻
				updatedAt: '2026-10-04T04:00:00.000Z',
				// 追加する行位置
				anchor: 4
			})
		];
		// 新しい順。b が先、a は今のウィンドウの行位置
		expect(mergeNoteViewPositionRecords(current, incoming)).toEqual([
			expect.objectContaining({
				// 追加されたノート
				filePath: 'C:\\docs\\b.md',
				// 追加された行位置
				anchor: 4
			}),
			expect.objectContaining({
				// 古くない方の a
				filePath: 'C:\\docs\\a.md',
				// 今のウィンドウの行位置
				anchor: 3
			})
		]);

		// 上限より 5 件多い記録。古い方から捨てる
		const many   = Array.from({ length: NOTE_VIEW_POSITION_LIMIT + 5 }, (_, index) =>
			record({
				// 連番のパス。0 が最も古い
				filePath: `C:\\docs\\${index}.md`,
				// 秒だけが増える更新時刻。大きい index が新しい
				updatedAt: new Date(Date.UTC(2026, 9, 4, 0, 0, index)).toISOString()
			})
		);
		// 空の記録置き場。replace で上限まで入れる
		const memory = new NoteViewPositionMemory();
		memory.replace(many);
		expect(memory.toDocument().entries).toHaveLength(NOTE_VIEW_POSITION_LIMIT);
		expect(memory.get('C:\\docs\\0.md')).toBeNull();
		expect(memory.get(`C:\\docs\\${NOTE_VIEW_POSITION_LIMIT + 4}.md`)).toMatchObject({ anchor: 120 });
	});
});
