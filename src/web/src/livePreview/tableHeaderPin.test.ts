/**
 * 表見出しを留める移動量と、データ行が裏に入ったかの判定を検証する
 * CSS は読み取り専用で、スクロールする DOM は作らない
 * @file
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildTableHeaderPinFrames, isTableHeaderCovering, resolveTableHeaderPinSpan, type TableHeaderPinFrame } from './tableHeaderPin';

/**
 * 見出し固定のクラス名が載っているかを見る、ライブプレビュー CSS
 * テスト中は読み取るだけで、書き換えない
 */
const livePreviewCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles/livePreview.css'), 'utf8');

/**
 * キーフレームをスクロール位置で線形補間する
 * @param frames - キーフレーム
 * @param scroll - スクロール量
 * @param maxScroll - 最大スクロール量
 * @returns translateY
 */
function translateAt(frames: TableHeaderPinFrame[], scroll: number, maxScroll: number): number {
	// スクロール位置を 0〜1 に正規化した割合。maxScroll が 0 のときは無限大になり得る
	const progress = scroll / maxScroll;
	// 先頭キーフレーム。配列が空なら undefined
	const first    = frames[0];
	// 末尾キーフレーム。1 件なら first と同じ
	const last     = frames[frames.length - 1];
	// 端が欠けるか、割合が先頭以下のときは先頭の移動量。空配列は 0
	if (!first || !last || progress <= first.offset) {
		return first?.translateY ?? 0;
	}

	for (let index = 1; index < frames.length; index += 1) {
		// 区間の手前。欠けるとこの区間は使わない
		const prev = frames[index - 1];
		// 区間の奥。割合がこれを超えたら次の区間へ進む
		const next = frames[index];
		// 両端が揃い、割合が next 以下の区間だけ補間する。どちらか欠けると進まない
		if (!prev || !next || progress > next.offset) {
			continue;
		}

		// 区間内の割合。0 が prev、1 が next
		const ratio = (progress - prev.offset) / (next.offset - prev.offset);
		return prev.translateY + ratio * (next.translateY - prev.translateY);
	}

	return last.translateY;
}

describe('表見出しの固定', () => {
	it('見出しへ到達するまではずらさず、通過した量だけ下げ、表の下端で止める', () => {
		// 見出しの文書上端。ここより手前では移動量 0
		const headerDocTop = 200;
		// 表の下端で止まる移動量。これを超えて下げない
		const maxTravel    = 80;
		// 補間に使うスクロールの最大。0 だと固定しない
		const maxScroll    = 1000;
		// 到達前・通過中・下端のキーフレーム
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
		// 文書先頭の表。最初からスクロール量だけ下げ、40 で止まる
		const frames = buildTableHeaderPinFrames(0, 40, 500);
		expect(translateAt(frames, 0, 500)).toBe(0);
		expect(translateAt(frames, 25, 500)).toBeCloseTo(25);
		expect(translateAt(frames, 400, 500)).toBeCloseTo(40);
	});

	it('表の枠が縦スクロールするときは、見える高さだけ見出しを動かす', () => {
		// 枠が縦スクロールするときの固定範囲。見える高さだけ動く
		const span = resolveTableHeaderPinSpan(true, 500, 240, 80, 40, 2000);
		// 文書上端と、見える範囲での移動上限
		expect(span).toEqual({
			// 見出しの文書上端。引数の表位置
			headerDocTop: 500,
			// 見える高さから見出し高を引いた移動量
			maxTravel: 200
		});
		// その範囲のキーフレーム。スクロール最大は枠より大きい
		const frames = buildTableHeaderPinFrames(span.headerDocTop, span.maxTravel, 3000);
		expect(translateAt(frames, 500, 3000)).toBeCloseTo(0);
		expect(translateAt(frames, 560, 3000)).toBeCloseTo(60);
		expect(translateAt(frames, 900, 3000)).toBeCloseTo(200);
	});

	it('表の枠が縦スクロールしないときは、表の下端まで見出しを動かす', () => {
		// 縦スクロールしない表の固定範囲。下端まで動ける
		expect(resolveTableHeaderPinSpan(false, 100, 400, 120, 36, 700)).toEqual({
			// 見出しの文書上端。スクロールしないときは見出し位置
			headerDocTop: 120,
			// 表の下端まで動ける量
			maxTravel: 544
		});
	});

	it('スクロールできないときと、見出しが表より高いときは固定しない', () => {
		expect(buildTableHeaderPinFrames(10, 40, 0)).toEqual([]);
		expect(buildTableHeaderPinFrames(10, 0, 400)).toEqual([]);
	});

	it('見出し背景は不透明で、固定セルは選択より後の規則で手前に置く', () => {
		expect(livePreviewCss).toMatch(/\.cm-md-table th\s*\{[^}]*background:\s*#253c45;/);
		expect(livePreviewCss).not.toMatch(/background:\s*#253c45ed/);
		// 選択規則の位置。見つからなければ -1
		const selectedAt = livePreviewCss.indexOf('.cm-md-table-cell-selected');
		// 固定セル規則の位置。選択より後ろなら手前に描く
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
