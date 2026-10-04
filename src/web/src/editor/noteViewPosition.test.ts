import { describe, expect, it } from 'vitest';
import type { EditorView } from '@codemirror/view';
import {
	NOTE_VIEW_POSITION_LIMIT,
	captureNoteViewPosition,
	isRestoredScrollLayoutReady,
	captureNoteViewPositionFromMetrics,
	computeRestoredScrollTop,
	mergeNoteViewPositionRecords,
	normalizeNoteViewPositionDocument,
	NoteViewPositionMemory,
	selectionFromNoteViewPosition,
	type NoteViewPositionRecord,
} from './noteViewPosition';

/**
 * @param {Partial<NoteViewPositionRecord>} overrides 上書き
 * @returns {NoteViewPositionRecord} 記録
 */
function record(overrides: Partial<NoteViewPositionRecord> = {}): NoteViewPositionRecord {
	return {
		filePath       : 'C:\\docs\\note.md',
		updatedAt      : '2026-10-04T01:00:00.000Z',
		anchor         : 120,
		yMargin        : -8,
		scrollLeft     : 0,
		selectionAnchor: 140,
		selectionHead  : 150,
		...overrides,
	};
}

describe('noteViewPosition', () => {
	it('ビューポート上端の行と選択範囲を記録する', () => {
		expect(captureNoteViewPositionFromMetrics({
			scrollTop      : 100,
			scrollLeft     : 12,
			blockFrom      : 80,
			blockTop       : 76,
			selectionAnchor: 90,
			selectionHead  : 94,
			docLength      : 200,
		})).toEqual({
			anchor         : 80,
			yMargin        : -24,
			scrollLeft     : 12,
			selectionAnchor: 90,
			selectionHead  : 94,
		});
	});

	it('文書長を超える選択と行位置を切り詰める', () => {
		const position = captureNoteViewPositionFromMetrics({
			scrollTop      : 0,
			scrollLeft     : -4,
			blockFrom      : 999,
			blockTop       : 10,
			selectionAnchor: 999,
			selectionHead  : 1000,
			docLength      : 20,
		});
		expect(position.anchor).toBe(20);
		expect(position.scrollLeft).toBe(0);
		expect(selectionFromNoteViewPosition(position, 20)).toEqual({ anchor: 20, head: 20 });
	});

	it('高さマップ上の行を記録し、計測の強制実行はしない', () => {
		const blocks = [
			{ from: 0, to: 10, top: 0, bottom: 40 },
			{ from: 11, to: 40, top: 80, bottom: 140 },
		];
		let flushed  = false;
		const view   = {
			scrollDOM: { isConnected: true, scrollTop: 100, scrollLeft: 4 },
			/**
			 * @param {number} pos 文書位置
			 * @returns {{ from: number, to: number, top: number, bottom: number }} 行塊
			 */
			lineBlockAt(pos: number) {
				return blocks.find((block) => pos >= block.from && pos <= block.to) ?? blocks[blocks.length - 1];
			},
			/**
			 * @returns {never}
			 */
			lineBlockAtHeight() {
				flushed = true;
				throw new Error('layout flush');
			},
			state: { selection: { main: { anchor: 12, head: 18 } }, doc: { length: 40 } },
		} as unknown as EditorView;

		expect(captureNoteViewPosition(view)).toEqual({
			anchor         : 11,
			yMargin        : -20,
			scrollLeft     : 4,
			selectionAnchor: 12,
			selectionHead  : 18,
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
		const records = normalizeNoteViewPositionDocument({
			schemaVersion: 1,
			entries      : [
				record({ updatedAt: '2026-10-04T01:00:00.000Z', anchor: 1 }),
				record({ filePath: 'c:/docs/note.md', updatedAt: '2026-10-04T02:00:00.000Z', anchor: 2 }),
				{ filePath: 'C:\\docs\\broken.md' },
				record({ filePath: ' ', updatedAt: '2026-10-04T03:00:00.000Z' }),
			],
		});

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ filePath: 'c:/docs/note.md', anchor: 2 });
		expect(normalizeNoteViewPositionDocument({ schemaVersion: 2, entries: [] })).toEqual([]);
	});

	it('他ウィンドウの新しい記録を残し、上限を超えた古い記録を捨てる', () => {
		const current  = [record({ filePath: 'C:\\docs\\a.md', updatedAt: '2026-10-04T03:00:00.000Z', anchor: 3 })];
		const incoming = [
			record({ filePath: 'C:\\docs\\a.md', updatedAt: '2026-10-04T01:00:00.000Z', anchor: 1 }),
			record({ filePath: 'C:\\docs\\b.md', updatedAt: '2026-10-04T04:00:00.000Z', anchor: 4 }),
		];
		expect(mergeNoteViewPositionRecords(current, incoming)).toEqual([
			expect.objectContaining({ filePath: 'C:\\docs\\b.md', anchor: 4 }),
			expect.objectContaining({ filePath: 'C:\\docs\\a.md', anchor: 3 }),
		]);

		const many   = Array.from({ length: NOTE_VIEW_POSITION_LIMIT + 5 }, (_, index) => record({
			filePath : `C:\\docs\\${index}.md`,
			updatedAt: new Date(Date.UTC(2026, 9, 4, 0, 0, index)).toISOString(),
		}));
		const memory = new NoteViewPositionMemory();
		memory.replace(many);
		expect(memory.toDocument().entries).toHaveLength(NOTE_VIEW_POSITION_LIMIT);
		expect(memory.get('C:\\docs\\0.md')).toBeNull();
		expect(memory.get(`C:\\docs\\${NOTE_VIEW_POSITION_LIMIT + 4}.md`)).toMatchObject({ anchor: 120 });
	});
});
