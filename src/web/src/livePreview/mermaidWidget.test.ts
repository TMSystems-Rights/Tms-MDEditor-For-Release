import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectBlockDecorationEntries } from './blockWidgets';
import {
	MermaidWidget,
	clearMermaidCache,
	extractFencedCodeInfo,
	extractFencedCodeText,
	isCollapsedMermaidSvg,
	isMermaidCodeInfo,
	isMermaidFencedCode,
	lockMermaidSvgDisplaySize,
	preprocessMermaidSource,
	renderMermaidSource,
	setMermaidModuleForTest,
} from './mermaidWidget';

/**
 * @param {string} doc ドキュメント
 * @param {number} [cursor] カーソル
 * @returns {EditorState}
 */
function createState(doc: string, cursor: number = 0): EditorState {
	return EditorState.create({
		doc,
		selection  : EditorSelection.cursor(cursor),
		extensions : [createTmsMarkdownSupport()],
	});
}

/**
 * @param {EditorState} state 状態
 * @param {string} name ノード名
 * @returns {import('@lezer/common').SyntaxNode | null}
 */
function findNode(state: EditorState, name: string) {
	let found: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 *
		 */
		enter(ref) {
			if (ref.name === name) {
				found = ref.node;
				return false;
			}
		},
	});
	return found;
}

describe('mermaidWidget', () => {
	afterEach(() => {
		setMermaidModuleForTest(null);
		clearMermaidCache();
		vi.unstubAllGlobals();
	});

	it('isMermaidCodeInfo は mermaid のみ真', () => {
		expect(isMermaidCodeInfo('mermaid')).toBe(true);
		expect(isMermaidCodeInfo('MERMAID')).toBe(true);
		expect(isMermaidCodeInfo('js')).toBe(false);
		expect(isMermaidCodeInfo('')).toBe(false);
	});

	it('preprocessMermaidSource は br を改行し装飾タグを除去する', () => {
		const input = 'A["<b>x</b><br/>y <font color=\'orange\'>z</font>"]';
		expect(preprocessMermaidSource(input)).toBe('A["x\ny z"]');
	});

	it('isCollapsedMermaidSvg は極小 viewBox / height=0 を検出し FO 単独では潰れたとしない', () => {
		expect(isCollapsedMermaidSvg('<svg height="0"></svg>')).toBe(true);
		expect(isCollapsedMermaidSvg('<svg viewBox="-8 -8 16 16"></svg>')).toBe(true);
		expect(isCollapsedMermaidSvg(
			'<svg viewBox="0 0 1014 652"><foreignObject width="0"></foreignObject></svg>',
		)).toBe(false);
		expect(isCollapsedMermaidSvg('<svg width="100%" height="200"></svg>')).toBe(false);
	});

	it('lockMermaidSvgDisplaySize はコンテナ幅へ収めた表示サイズを固定する', () => {
		vi.stubGlobal('getComputedStyle', () => ({
			paddingLeft  : '20px',
			paddingRight : '20px',
		}));

		const attrs = new Map<string, string>([
			['viewBox', '0 0 1200 600'],
		]);
		const style = {
			width   : '',
			height  : '',
			maxWidth: '',
		};
		const svg   = {
			getAttribute : vi.fn((name: string) => attrs.get(name) ?? null),
			setAttribute : vi.fn((name: string, value: string) => attrs.set(name, value)),
			style,
		} as unknown as SVGSVGElement;
		const wrap  = {
			clientWidth            : 900,
			getBoundingClientRect  : vi.fn(() => ({ width: 900 })),
		} as unknown as HTMLElement;

		expect(lockMermaidSvgDisplaySize(svg, wrap)).toBe(true);
		expect(attrs.get('width')).toBe('860');
		expect(attrs.get('height')).toBe('430');
		expect(style.width).toBe('860px');
		expect(style.height).toBe('auto');
		expect(style.maxWidth).toBe('none');
	});

	it('lockMermaidSvgDisplaySize は自然幅が収まる場合は拡大しない', () => {
		vi.stubGlobal('getComputedStyle', () => ({
			paddingLeft  : '0px',
			paddingRight : '0px',
		}));

		const attrs = new Map<string, string>([
			['viewBox', '0 0 480 240'],
		]);
		const style = {
			width   : '',
			height  : '',
			maxWidth: '',
		};
		const svg   = {
			getAttribute : vi.fn((name: string) => attrs.get(name) ?? null),
			setAttribute : vi.fn((name: string, value: string) => attrs.set(name, value)),
			style,
		} as unknown as SVGSVGElement;
		const wrap  = {
			clientWidth            : 900,
			getBoundingClientRect  : vi.fn(() => ({ width: 900 })),
		} as unknown as HTMLElement;

		expect(lockMermaidSvgDisplaySize(svg, wrap)).toBe(true);
		expect(attrs.get('width')).toBe('480');
		expect(attrs.get('height')).toBe('240');
		expect(style.width).toBe('480px');
		expect(style.maxWidth).toBe('none');
	});

	it('FencedCode から info / text を抽出する', () => {
		const doc   = '```mermaid\ngraph TD\n  A-->B\n```\n';
		const state = createState(doc);
		const node  = findNode(state, 'FencedCode');
		expect(node).not.toBeNull();
		expect(extractFencedCodeInfo(state, node!)).toBe('mermaid');
		expect(extractFencedCodeText(state, node!)).toContain('A-->B');
		expect(isMermaidFencedCode(state, node!)).toBe(true);
	});

	it('プレビュー時に Mermaid replace を生成する', () => {
		const doc     = 'before\n```mermaid\ngraph TD\n  A-->B\n```\nafter';
		const state   = createState(doc, 0);
		const entries = collectBlockDecorationEntries(state);
		const mermaid = entries.find((entry) => entry.decoration.spec.widget instanceof MermaidWidget);
		expect(mermaid).toBeDefined();
		expect(mermaid!.decoration.spec.widget).toBeInstanceOf(MermaidWidget);
	});

	it('カーソルが Mermaid 内にあるときは replace しない', () => {
		const doc     = 'before\n```mermaid\ngraph TD\n  A-->B\n```\nafter';
		const state   = createState(doc, doc.indexOf('graph'));
		const entries = collectBlockDecorationEntries(state);
		const mermaid = entries.find((entry) => entry.decoration.spec.widget instanceof MermaidWidget);
		expect(mermaid).toBeUndefined();
	});

	it('通常のコードブロックは Mermaid 置換しない', () => {
		const doc     = '```js\nconsole.log(1)\n```\n';
		const state   = createState(doc, 0);
		const entries = collectBlockDecorationEntries(state);
		expect(entries.some((entry) => entry.decoration.spec.widget instanceof MermaidWidget)).toBe(false);
	});

	it('renderMermaidSource は成功結果をキャッシュする', async () => {
		const initialize = vi.fn();
		const render     = vi.fn(async () => ({ svg: '<svg width="100%" height="200" data-test="ok"></svg>' }));
		setMermaidModuleForTest({
			initialize,
			render,
			run: vi.fn(),
		});
		clearMermaidCache();

		const source = 'graph TD\n  A-->B';
		const first  = await renderMermaidSource(source, 'default');
		const second = await renderMermaidSource(source, 'default');
		expect(first).toEqual({
			ok   : true,
			svg  : '<svg width="100%" height="200" data-test="ok"></svg>',
			mode : 'html',
		});
		expect(second).toBe(first);
		expect(render).toHaveBeenCalledTimes(1);
		expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
			securityLevel : 'loose',
			htmlLabels    : true,
			flowchart     : expect.objectContaining({
				useMaxWidth : false,
				padding     : 15,
			}),
		}));
	});

	it('HTML ラベル入り図は HTML モードを維持する', async () => {
		const initialize = vi.fn();
		const render     = vi.fn(async () => ({ svg: '<svg width="480" height="240" viewBox="0 0 480 240"></svg>' }));
		setMermaidModuleForTest({
			initialize,
			render,
			run: vi.fn(),
		});
		clearMermaidCache();

		const result = await renderMermaidSource('graph LR\nA["<b>x</b><br/>y"]', 'default');
		expect(result).toEqual({
			ok   : true,
			svg  : '<svg width="480" height="240" viewBox="0 0 480 240"></svg>',
			mode : 'html',
		});
		expect(render).toHaveBeenCalledTimes(1);
		expect(render).toHaveBeenCalledWith(
			expect.any(String),
			'graph LR\nA["<b>x</b><br/>y"]',
		);
		expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
			htmlLabels: true,
		}));
	});

	it('HTML ラベル入り図が潰れた場合のみ平文へフォールバックする', async () => {
		const render = vi.fn()
			.mockResolvedValueOnce({ svg: '<svg width="16" height="16"></svg>' })
			.mockResolvedValueOnce({ svg: '<svg width="100%" height="200"></svg>' });
		setMermaidModuleForTest({
			initialize: vi.fn(),
			render,
			run: vi.fn(),
		});
		clearMermaidCache();

		const result = await renderMermaidSource('graph LR\nA["<b>x</b><br/>y"]', 'default');
		expect(result).toEqual({
			ok   : true,
			svg  : '<svg width="100%" height="200"></svg>',
			mode : 'plain',
		});
		expect(render).toHaveBeenCalledTimes(2);
		expect(render).toHaveBeenNthCalledWith(
			1,
			expect.any(String),
			'graph LR\nA["<b>x</b><br/>y"]',
		);
		expect(render).toHaveBeenNthCalledWith(
			2,
			expect.any(String),
			'graph LR\nA["x\ny"]',
		);
	});

	it('HTML ラベル以外の潰れた描画は平文へフォールバックする', async () => {
		const render = vi.fn()
			.mockResolvedValueOnce({ svg: '<svg width="16" height="16"></svg>' })
			.mockResolvedValueOnce({ svg: '<svg width="100%" height="200"></svg>' });
		setMermaidModuleForTest({
			initialize: vi.fn(),
			render,
			run: vi.fn(),
		});
		clearMermaidCache();

		const result = await renderMermaidSource('graph LR\nA-->B', 'default');
		expect(result).toEqual({
			ok   : true,
			svg  : '<svg width="100%" height="200"></svg>',
			mode : 'plain',
		});
		expect(render).toHaveBeenCalledTimes(2);
	});

	it('構文エラー時は error を返す', async () => {
		setMermaidModuleForTest({
			initialize: vi.fn(),
			render    : vi.fn(async () => {
				throw new Error('Parse error on line 1');
			}),
			run: vi.fn(),
		});
		clearMermaidCache();

		const result = await renderMermaidSource('not mermaid', 'default');
		expect(result).toEqual({ ok: false, error: 'Parse error on line 1' });
	});

	it('空 SVG はエラーとして扱う', async () => {
		setMermaidModuleForTest({
			initialize: vi.fn(),
			render    : vi.fn(async () => ({ svg: '' })),
			run       : vi.fn(),
		});
		clearMermaidCache();

		const result = await renderMermaidSource('graph TD; A-->B', 'default');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('空');
		}
	});
});
