import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	buildTableHeaderPinFrames,
	isTableHeaderCovering,
	resolveTableHeaderPinSpan,
	type TableHeaderPinFrame,
} from './tableHeaderPin';

const livePreviewCss = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '../styles/livePreview.css'),
	'utf8',
);

/**
 * キーフレームをスクロール位置で線形補間する。
 * @param {TableHeaderPinFrame[]} frames キーフレーム
 * @param {number} scroll スクロール量
 * @param {number} maxScroll 最大スクロール量
 * @returns {number} translateY
 */
function translateAt(frames: TableHeaderPinFrame[], scroll: number, maxScroll: number): number {
	const progress = scroll / maxScroll;
	const first    = frames[0];
	const last     = frames[frames.length - 1];
	if (!first || !last || progress <= first.offset) {
		return first?.translateY ?? 0;
	}

	for (let index = 1; index < frames.length; index += 1) {
		const prev = frames[index - 1];
		const next = frames[index];
		if (!prev || !next || progress > next.offset) {
			continue;
		}

		const ratio = (progress - prev.offset) / (next.offset - prev.offset);
		return prev.translateY + (ratio * (next.translateY - prev.translateY));
	}

	return last.translateY;
}

describe('表見出しの固定', () => {
	it('見出しへ到達するまではずらさず、通過した量だけ下げ、表の下端で止める', () => {
		const headerDocTop = 200;
		const maxTravel    = 80;
		const maxScroll    = 1000;
		const frames       = buildTableHeaderPinFrames(headerDocTop, maxTravel, maxScroll);
		expect(translateAt(frames, 100, maxScroll)).toBe(0);
		expect(translateAt(frames, 200, maxScroll)).toBe(0);
		expect(translateAt(frames, 230, maxScroll)).toBeCloseTo(30);
		expect(translateAt(frames, 280, maxScroll)).toBeCloseTo(80);
		expect(translateAt(frames, 600, maxScroll)).toBeCloseTo(80);
	});

	it('データ行が見出しの裏に入ったときだけ仕切りを出す', () => {
		expect(isTableHeaderCovering(100, 200, 0)).toBe(false);
		expect(isTableHeaderCovering(201, 200, 0)).toBe(true);
		expect(isTableHeaderCovering(100, 200, 8)).toBe(true);
	});

	it('文書先頭の表は最初からスクロール量だけ下げ、最大量で止める', () => {
		const frames = buildTableHeaderPinFrames(0, 40, 500);
		expect(translateAt(frames, 0, 500)).toBe(0);
		expect(translateAt(frames, 25, 500)).toBeCloseTo(25);
		expect(translateAt(frames, 400, 500)).toBeCloseTo(40);
	});

	it('表の枠が縦スクロールするときは、見える高さだけ見出しを動かす', () => {
		const span = resolveTableHeaderPinSpan(true, 500, 240, 80, 40, 2000);
		expect(span).toEqual({ headerDocTop: 500, maxTravel: 200 });
		const frames = buildTableHeaderPinFrames(span.headerDocTop, span.maxTravel, 3000);
		expect(translateAt(frames, 500, 3000)).toBeCloseTo(0);
		expect(translateAt(frames, 560, 3000)).toBeCloseTo(60);
		expect(translateAt(frames, 900, 3000)).toBeCloseTo(200);
	});

	it('表の枠が縦スクロールしないときは、表の下端まで見出しを動かす', () => {
		expect(resolveTableHeaderPinSpan(false, 100, 400, 120, 36, 700)).toEqual({
			headerDocTop: 120,
			maxTravel    : 544,
		});
	});

	it('スクロールできないときと、見出しが表より高いときは固定しない', () => {
		expect(buildTableHeaderPinFrames(10, 40, 0)).toEqual([]);
		expect(buildTableHeaderPinFrames(10, 0, 400)).toEqual([]);
	});

	it('見出し背景は不透明で、固定セルは選択より後の規則で手前に置く', () => {
		expect(livePreviewCss).toMatch(/\.cm-md-table th\s*\{[^}]*background:\s*#253c45;/);
		expect(livePreviewCss).not.toMatch(/background:\s*#253c45ed/);
		const selectedAt = livePreviewCss.indexOf('.cm-md-table-cell-selected');
		const pinAt      = livePreviewCss.indexOf('.cm-md-table-pin-cell');
		expect(selectedAt).toBeGreaterThan(-1);
		expect(pinAt).toBeGreaterThan(selectedAt);
		expect(livePreviewCss).toMatch(/\.cm-md-table-pin-cell\s*\{[^}]*position:\s*sticky;/);
		expect(livePreviewCss).toMatch(/\.cm-md-table-pin-cell\s*\{[^}]*z-index:\s*2;/);
		expect(livePreviewCss).toMatch(/\.cm-md-table-pin-cell::before\s*\{[^}]*top:\s*-3px;/);
		expect(livePreviewCss).toMatch(/\.cm-md-table-pin-cell::after\s*\{[^}]*height:\s*22px;/);
		expect(livePreviewCss).toMatch(/#7dcec8/);
		expect(livePreviewCss).toMatch(/\.cm-md-table-pin-covering::after\s*\{[^}]*opacity:\s*1;/);
	});
});