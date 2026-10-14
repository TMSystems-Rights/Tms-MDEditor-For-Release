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
	computeColumnRightEdges,
	computeColumnWidths,
	forgetTableLayout,
	getTableLayoutKey,
	isTableHorizontallyOverflowing,
	recallTableLayout,
	rememberTableLayout,
	resolveTableResizeHit,
	resolveTableRelativeOffset,
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
		forgetTableLayout('10:2');
		expect(recallTableLayout('10:2')).toBeUndefined();
	});

	it('結合セルでも列ごとの右端と幅を出す', () => {
		const boxes = [
			{ column: 0, colspan: 3, left: 0, width: 300 },
			{ column: 0, colspan: 1, left: 0, width: 90 },
			{ column: 1, colspan: 1, left: 90, width: 110 },
			{ column: 2, colspan: 1, left: 200, width: 100 },
		];
		expect(computeColumnRightEdges(boxes, 3)).toEqual([90, 200, 300]);
		expect(computeColumnWidths(
			[{ column: 0, colspan: 3, left: 0, width: 300 }],
			3,
		)).toEqual([100, 100, 100]);
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

	it('親の余白とスクロール量を含む表位置を求める', () => {
		expect(resolveTableRelativeOffset(64, 103, 0)).toBe(39);
		expect(resolveTableRelativeOffset(64, 83, 20)).toBe(39);
	});

	it('表本体が表示幅を超えた場合だけ横スクロールを必要とする', () => {
		expect(isTableHorizontallyOverflowing(26, 973, 1000)).toBe(false);
		expect(isTableHorizontallyOverflowing(26, 974.5, 1000)).toBe(false);
		expect(isTableHorizontallyOverflowing(26, 976, 1000)).toBe(true);
	});

	it('表に編集領域の 40% 下限を付けない', () => {
		expect(livePreviewCss).not.toMatch(/\.cm-md-table\s*\{[^}]*min-width:\s*40%/s);
		expect(EXPORT_PREVIEW_CSS).not.toMatch(/\.cm-md-table\s*\{[^}]*min-width:\s*40%/s);
	});

	it('CodeMirror Widget 前後の表余白を0.5行分にする', () => {
		expect(livePreviewCss).toMatch(
			/div\.cm-md-table-wrap,[\s\S]*?div\.cm-md-html-table-wrap\s*\{[^}]*margin:\s*-0\.7em 0;[^}]*overflow-y:\s*hidden;/s,
		);
	});

	it('テーブルWidgetの末尾へ重なる改行記号を非表示にする', () => {
		expect(livePreviewCss).toMatch(
			/\.cm-line\.cm-eol-marker-line:has\(> \.cm-md-table-wrap\)::after,[\s\S]*?\.cm-line\.cm-eol-marker-line:has\(> \.cm-md-html-table-wrap\)::after\s*\{[^}]*content:\s*none;/s,
		);
	});

	it('列ごとの罫線ハンドルを14pxで置く', () => {
		expect(TABLE_RESIZE_HANDLE_PX).toBe(14);
		expect(livePreviewCss).toMatch(/\.cm-md-table-col-resizer\s*\{[^}]*width:\s*14px;/s);
		expect(livePreviewCss).toMatch(/\.cm-md-table-row-resizer\s*\{[^}]*height:\s*14px;/s);
	});

	it('長い表は表示中の編集領域幅で横スクロールする', () => {
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap,[\s\S]*?max-width:\s*var\(--tms-mde-table-max-width,\s*100%\);/);
		expect(livePreviewCss).toMatch(/div\.cm-md-html-table-wrap\s*\{[^}]*overflow-x:\s*auto;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-html-table-wrap\s*\{[^}]*overflow-y:\s*hidden;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap\s*\{[^}]*overflow-x:\s*hidden;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap\.cm-md-table-horizontal-overflow,[\s\S]*?overflow-x:\s*auto;/s);
	});

	it('行列選択ヘッダーの余白は表示中だけ確保する', () => {
		expect(livePreviewCss).toMatch(
			/div\.cm-md-table-wrap\.cm-md-table-structure-controls-visible\s*\{[^}]*max-width:\s*max\(0px,\s*calc\([^}]*padding-top:\s*26px;[^}]*padding-left:\s*26px;/s,
		);
		expect(livePreviewCss).not.toMatch(/\.cm-md-table-has-structure-controls/);
	});

	it('HTML出力でも表本体を縮めずラッパーで横スクロールする', () => {
		expect(EXPORT_PREVIEW_CSS).toMatch(/\.cm-md-table-wrap,[\s\S]*?\.cm-md-html-table-wrap\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);
		expect(EXPORT_PREVIEW_CSS).toMatch(/\.cm-md-table\s*\{[^}]*width:\s*max-content;[^}]*line-height:\s*1\.4;/s);
		expect(EXPORT_PREVIEW_CSS).not.toMatch(/\.cm-md-table\s*\{[^}]*max-width:\s*100%;/s);
	});

	it('HTML出力のノート幅を表示領域へ追従させる', () => {
		expect(EXPORT_PREVIEW_CSS).toMatch(/\.tms-mde-export\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;/s);
		expect(EXPORT_PREVIEW_CSS).not.toMatch(/\.tms-mde-export\s*\{[^}]*max-width:\s*52rem;/s);
	});

	it('列幅を保存したセルはエディタの折り返しがオフでも列内で折り返す', () => {
		expect(livePreviewCss).toMatch(/\.cm-md-table\.is-resized th,[\s\S]*?white-space:\s*pre-wrap;/);
		expect(livePreviewCss).toMatch(/\.cm-md-table\.is-resized td\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
	});
});
