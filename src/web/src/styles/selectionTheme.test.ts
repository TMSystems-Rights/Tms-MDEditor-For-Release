/**
 * 範囲選択の CSS 変数と、選択レイヤーの重なりを検証する
 * @file
 */

/* eslint-disable-next-line spaced-comment */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** このテストファイルがある styles ディレクトリ */
const stylesDir = dirname(fileURLToPath(import.meta.url));

describe('範囲選択の CSS 変数', () => {
	// 色と透過度の変数を読む CSS 本文。テスト中は書き換えない
	const baseCss        = readFileSync(join(stylesDir, 'base.css'), 'utf8');
	// 選択レイヤーの重なりを読む CSS 本文。テスト中は書き換えない
	const shellCss       = readFileSync(join(stylesDir, 'shell.css'), 'utf8');
	// ライブプレビュー側の選択スタイルを読む CSS 本文。テスト中は書き換えない
	const livePreviewCss = readFileSync(join(stylesDir, 'livePreview.css'), 'utf8');

	it('色と透過度を CSS 変数として公開する', () => {
		expect(baseCss).toContain('--tms-mde-color-selection:');
		expect(baseCss).not.toContain('--tms-mde-color-selection-rgb:');
		expect(baseCss).toContain('--tms-mde-selection-opacity:');
		expect(baseCss).toContain('--tms-mde-selection-opacity-focused:');
		expect(baseCss).toContain('color-mix(in srgb, var(--tms-mde-color-selection)');
		expect(baseCss).toContain('calc(var(--tms-mde-selection-opacity) * 100%)');
		expect(baseCss).toContain('--tms-mde-selection-layer-z-index: 1');
	});

	it('選択レイヤーを行背景より前面に描画する', () => {
		expect(shellCss).toContain('.cm-layer.cm-selectionLayer');
		expect(shellCss).toContain('z-index: var(--tms-mde-selection-layer-z-index) !important');
		expect(shellCss).toContain('pointer-events: none');
	});

	it('キャレット色は color-mix より前に定義する', () => {
		// :root、ダーク、ライトの 3 ブロック。キャレット変数が color-mix より前かを見る
		const blocks = [baseCss.slice(baseCss.indexOf(':root {'), baseCss.indexOf('body.tms-mde-theme-dark')), baseCss.slice(baseCss.indexOf('body.tms-mde-theme-dark'), baseCss.indexOf('body.tms-mde-theme-light')), baseCss.slice(baseCss.indexOf('body.tms-mde-theme-light'))];

		blocks.forEach((block) => {
			// キャレット色の定義位置。見つからなければ -1
			const caretAt = block.indexOf('--tms-mde-color-caret:');
			// color-mix の定義位置。キャレット変数より後ろであることを見る
			const mixAt   = block.indexOf('color-mix(');
			expect(caretAt).toBeGreaterThan(-1);
			expect(mixAt).toBeGreaterThan(-1);
			expect(caretAt).toBeLessThan(mixAt);
		});
	});

	it('描画キャレットを選択レイヤーより前面に固定しネイティブキャレットを隠す', () => {
		expect(baseCss).toContain('--tms-mde-caret-layer-z-index: 150');
		expect(shellCss).toContain('.cm-layer.cm-cursorLayer');
		expect(shellCss).toContain('z-index: var(--tms-mde-caret-layer-z-index) !important');
		expect(shellCss).toContain('caret-color: transparent !important');
		expect(shellCss).toContain('border-left-color: var(--tms-mde-color-caret) !important');
	});

	it('表セル選択は縞模様より後に定義し、選択色で範囲を示す', () => {
		// 縞模様の定義位置。選択色はこの後ろに無いと上書きされる
		const zebraAt    = livePreviewCss.indexOf('.cm-md-table tr:nth-child(even) td');
		// セル選択の最後の定義位置。縞模様より後ろであることを見る
		const selectedAt = livePreviewCss.lastIndexOf('cm-md-table-cell-selected');
		expect(zebraAt).toBeGreaterThan(-1);
		expect(selectedAt).toBeGreaterThan(zebraAt);
		expect(livePreviewCss).toContain('tr:nth-child(even) td.cm-md-table-cell-selected');
		expect(livePreviewCss).toContain('var(--tms-mde-color-selection)');
		expect(livePreviewCss).toContain('cm-md-table-sel-n');
	});

	it('行番号ガターを CM ライト既定色ではなくテーマ変数で塗る', () => {
		expect(shellCss).toContain('.cm-editor .cm-gutters');
		expect(shellCss).toContain('background-color: var(--tms-mde-color-surface) !important');
		expect(shellCss).toContain('.cm-editor .cm-gutterElement');
		expect(shellCss).toContain('color: var(--tms-mde-color-text-muted) !important');
		expect(shellCss).toContain('.cm-editor .cm-activeLineGutter');
		expect(shellCss).toContain('background-color: var(--tms-mde-color-active-line) !important');
	});
});
