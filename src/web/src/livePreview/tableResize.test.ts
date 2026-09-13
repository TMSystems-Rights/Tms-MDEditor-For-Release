import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_PREVIEW_CSS } from '../export/exportCss';
import {
	TABLE_RESIZE_HANDLE_PX,
	clampColumnWidth,
	clampRowHeight,
	clearTableLayouts,
	getTableLayoutKey,
	recallTableLayout,
	rememberTableLayout,
	resolveTableResizeHit,
} from './tableResize';

const livePreviewCss = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '../styles/livePreview.css'),
	'utf8',
);

describe('tableResize', () => {
	afterEach(() => {
		clearTableLayouts();
	});

	it('表位置と列数でレイアウトキーを作る', () => {
		expect(getTableLayoutKey(12, 3)).toBe('12:3');
	});

	it('列幅と行高を覚えて取り出す', () => {
		rememberTableLayout('10:2', { widths: [80, 120], heights: [40, 48] });
		expect(recallTableLayout('10:2')).toEqual({ widths: [80, 120], heights: [40, 48] });
	});

	it('列と行の近い罫線を選ぶ', () => {
		expect(resolveTableResizeHit({ index: 0, distance: 2 }, { index: 1, distance: 5 }))
			.toEqual({ kind: 'col', index: 0 });
		expect(resolveTableResizeHit({ index: 0, distance: 5 }, { index: 1, distance: 2 }))
			.toEqual({ kind: 'row', index: 1 });
		expect(resolveTableResizeHit({ index: 2, distance: 1 }, null))
			.toEqual({ kind: 'col', index: 2 });
		expect(resolveTableResizeHit(null, { index: 0, distance: 1 }))
			.toEqual({ kind: 'row', index: 0 });
		expect(resolveTableResizeHit(null, null)).toBeNull();
	});

	it('列幅と行高の下限を適用する', () => {
		expect(clampColumnWidth(10)).toBe(32);
		expect(clampColumnWidth(80.4)).toBe(80);
		expect(clampRowHeight(8)).toBe(24);
		expect(clampRowHeight(40.6)).toBe(41);
	});

	it('表に編集領域の 40% 下限を付けない', () => {
		expect(livePreviewCss).not.toMatch(/\.cm-md-table\s*\{[^}]*min-width:\s*40%/s);
		expect(EXPORT_PREVIEW_CSS).not.toMatch(/\.cm-md-table\s*\{[^}]*min-width:\s*40%/s);
	});

	it('列ごとの罫線ハンドルを14pxで置く', () => {
		expect(TABLE_RESIZE_HANDLE_PX).toBe(14);
		expect(livePreviewCss).toMatch(/\.cm-md-table-col-resizer\s*\{[^}]*width:\s*14px;/s);
		expect(livePreviewCss).toMatch(/\.cm-md-table-row-resizer\s*\{[^}]*height:\s*14px;/s);
	});

	it('表ラッパーに横スクロールを付けない', () => {
		expect(livePreviewCss).not.toMatch(/\.cm-md-table-wrap\s*\{[^}]*overflow-x:\s*auto;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap\s*\{[^}]*overflow-x:\s*hidden;/s);
	});
});
