/* eslint-disable-next-line spaced-comment */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesDir = dirname(fileURLToPath(import.meta.url));

describe('範囲選択の CSS 変数', () => {
	const baseCss  = readFileSync(join(stylesDir, 'base.css'), 'utf8');
	const shellCss = readFileSync(join(stylesDir, 'shell.css'), 'utf8');

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
		const blocks = [
			baseCss.slice(baseCss.indexOf(':root {'), baseCss.indexOf('body.tms-mde-theme-dark')),
			baseCss.slice(baseCss.indexOf('body.tms-mde-theme-dark'), baseCss.indexOf('body.tms-mde-theme-light')),
			baseCss.slice(baseCss.indexOf('body.tms-mde-theme-light')),
		];

		blocks.forEach((block) => {
			const caretAt = block.indexOf('--tms-mde-color-caret:');
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

	it('行番号ガターを CM ライト既定色ではなくテーマ変数で塗る', () => {
		expect(shellCss).toContain('.cm-editor .cm-gutters');
		expect(shellCss).toContain('background-color: var(--tms-mde-color-surface) !important');
		expect(shellCss).toContain('.cm-editor .cm-gutterElement');
		expect(shellCss).toContain('color: var(--tms-mde-color-text-muted) !important');
		expect(shellCss).toContain('.cm-editor .cm-activeLineGutter');
		expect(shellCss).toContain('background-color: var(--tms-mde-color-active-line) !important');
	});
});
