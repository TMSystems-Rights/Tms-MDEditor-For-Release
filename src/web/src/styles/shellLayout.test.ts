/**
 * ペインとアウトラインのグリッド配置を、シェルの CSS から検証する
 * @file
 */

/* eslint-disable-next-line spaced-comment */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** ペインとアウトラインの配置を読む CSS 本文 */
const shellCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'shell.css'), 'utf8');

describe('ペインエディタのスクロールレイアウト', () => {
	it('ホストと各ペインのEditorViewを高さ制約付きグリッドへ収める', () => {
		expect(shellCss).toMatch(/\.tms-mde-editor-host\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/s);
		expect(shellCss).toMatch(/\.tms-mde-pane-editor-surface\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/s);
		expect(shellCss).toMatch(/\.tms-mde-editor-host \.cm-scroller\s*\{[^}]*overflow:\s*auto;/s);
	});

	it('アウトラインを左右どちらにも配置できる', () => {
		expect(shellCss).toMatch(/\.tms-mde-workspace\s*\{[^}]*grid-template-areas:\s*"editor outline";/s);
		expect(shellCss).toMatch(/\.tms-mde-workspace\.is-outline-left\s*\{[^}]*grid-template-areas:\s*"outline editor";/s);
	});

	it('アウトライン一覧だけを縦スクロールさせる', () => {
		expect(shellCss).toMatch(/\.tms-mde-outline-panel\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s);
		expect(shellCss).toMatch(/\.tms-mde-outline-list\s*\{[^}]*overflow-y:\s*auto;/s);
	});

	it('アウトライン境界をドラッグできるリサイズハンドルを表示する', () => {
		expect(shellCss).toMatch(/\.tms-mde-outline-panel\s*\{[^}]*width:\s*var\(--tms-mde-outline-width, 300px\);/s);
		expect(shellCss).toMatch(/\.tms-mde-outline-resizer\s*\{[^}]*cursor:\s*col-resize;/s);
		expect(shellCss).toContain('.tms-mde-workspace.is-outline-left .tms-mde-outline-resizer');
	});

	it('アウトライン階層にインデント用の縦線を表示する', () => {
		expect(shellCss).toMatch(/\.tms-mde-outline-list\s*\{[^}]*--tms-mde-outline-indent:/s);
		expect(shellCss).toMatch(/\.tms-mde-outline-row::before\s*\{[^}]*repeating-linear-gradient/s);
		expect(shellCss).toContain('.tms-mde-outline-twist');
		expect(shellCss).toContain('.tms-mde-outline-fold-all');
	});

	it('タブバーを横スクロール可能にし、各タブは縮めない', () => {
		expect(shellCss).toMatch(/\.tms-mde-pane-tab-bar-wrap\s*\{[^}]*min-width:\s*0;/s);
		expect(shellCss).toMatch(/\.tms-mde-pane-tab-bar\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;/s);
		expect(shellCss).toMatch(/\.tms-mde-tab\s*\{[^}]*flex:\s*0 0 auto;/s);
	});

	it('タブの挿入位置を左右のマーカーで表示する', () => {
		expect(shellCss).toContain('.tms-mde-tab.is-tab-drop-before::before');
		expect(shellCss).toContain('.tms-mde-tab.is-tab-drop-after::after');
		expect(shellCss).toMatch(/\.tms-mde-tab\.is-tab-drop-before::before\s*\{[^}]*left:\s*-3px;/s);
		expect(shellCss).toMatch(/\.tms-mde-tab\.is-tab-drop-after::after\s*\{[^}]*right:\s*-3px;/s);
	});

	it('タブバー空白のダブルクリック用にテキスト選択を無効化する', () => {
		expect(shellCss).toMatch(/\.tms-mde-pane-tab-bar-wrap\s*\{[^}]*user-select:\s*none;/s);
	});

	it('空行の行末記号をBRの次行へ流さない', () => {
		// 空行の行末記号。BR だけの行と、その ::after の両方が対象
		const emptyEolLine = '.cm-eol-marker-line:has(> br:only-child)';
		expect(shellCss).toContain(`${emptyEolLine} {`);
		expect(shellCss).toContain(`${emptyEolLine}::after {`);
		expect(shellCss).toMatch(/\.cm-eol-marker-line:has\(> br:only-child\)::after\s*\{[^}]*position:\s*absolute;[^}]*top:\s*50%;/s);
	});
});
