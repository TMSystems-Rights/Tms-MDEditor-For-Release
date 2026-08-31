/* eslint-disable-next-line spaced-comment */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
});
