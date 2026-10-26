/**
 * Mermaid フェンスの抽出と、描画結果のキャッシュを検証する
 * 描画モジュールはテスト用の差し替えを使い、本番の遅延ロードには依存しない
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectBlockDecorationEntries } from './blockWidgets';
import { MermaidWidget, clearMermaidCache, extractFencedCodeInfo, extractFencedCodeText, isCollapsedMermaidSvg, isMermaidCodeInfo, isMermaidFencedCode, lockMermaidSvgDisplaySize, preprocessMermaidSource, renderMermaidSource, setMermaidModuleForTest } from './mermaidWidget';

/**
 * Mermaid 判定用の Markdown 状態を作る
 * @param doc - ドキュメント全文
 * @param cursor - カーソル位置。省略時は文書先頭
 * @returns TMS Markdown だけを載せた状態
 */
function createState(doc: string, cursor: number = 0): EditorState {
	return EditorState.create({
		// Mermaid ブロックを含む本文
		doc,
		// 空のキャレット。省略時は文書先頭で、その行はソース表示
		selection: EditorSelection.cursor(cursor),
		// フェンスのノードを得る Markdown サポート
		extensions: [createTmsMarkdownSupport()]
	});
}

/**
 * 構文木から、指定名の最初のノードを探す
 * @param state - 構文木を読む状態
 * @param name - 探すノード名
 * @returns 最初のノード。無ければ null
 */
function findNode(state: EditorState, name: string) {
	// 最初に名前が一致したノード。無ければ null のまま
	let found: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 *
		 */
		enter(ref) {
			// 指定名の最初の 1 つだけを採用し、探索を止める
			if (ref.name === name) {
				// 採用するノード。2 件目は見ない
				found = ref.node;
				return false;
			}
		}
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
		// br と装飾タグを含むノードラベル。改行と平文だけ残す
		const input = 'A["<b>x</b><br/>y <font color=\'orange\'>z</font>"]';
		expect(preprocessMermaidSource(input)).toBe('A["x\ny z"]');
	});

	it('isCollapsedMermaidSvg は極小 viewBox / height=0 を検出し FO 単独では潰れたとしない', () => {
		expect(isCollapsedMermaidSvg('<svg height="0"></svg>')).toBe(true);
		expect(isCollapsedMermaidSvg('<svg viewBox="-8 -8 16 16"></svg>')).toBe(true);
		expect(isCollapsedMermaidSvg('<svg viewBox="0 0 1014 652"><foreignObject width="0"></foreignObject></svg>')).toBe(false);
		expect(isCollapsedMermaidSvg('<svg width="100%" height="200"></svg>')).toBe(false);
	});

	it('lockMermaidSvgDisplaySize はコンテナ幅へ収めた表示サイズを固定する', () => {
		// 左右 20px ずつ。コンテナ幅 900 から引くと表示幅 860
		vi.stubGlobal('getComputedStyle', () => ({
			// 左の内側余白
			paddingLeft: '20px',
			// 右の内側余白
			paddingRight: '20px'
		}));

		// viewBox は 1200×600。表示はコンテナへ収める
		const attrs = new Map<string, string>([['viewBox', '0 0 1200 600']]);
		// 固定前は空。幅と高さはあとから px で入る
		const style = {
			// 幅。空は未固定
			width: '',
			// 高さ。空は未固定
			height: '',
			// 最大幅。空は未固定
			maxWidth: ''
		};
		// viewBox と style を持つ SVG。幅はコンテナへ収める
		const svg   = {
			// 属性を読む。無い名前は null
			getAttribute: vi.fn((name: string) => attrs.get(name) ?? null),
			// 属性を書く。表示サイズの固定先
			setAttribute: vi.fn((name: string, value: string) => attrs.set(name, value)),
			// 固定する style
			style
		} as unknown as SVGSVGElement;
		// 幅 900 の枠。左右余白を引いた内側へ SVG を収める
		const wrap  = {
			// 枠の内側幅。px
			clientWidth: 900,
			// 枠の幅。clientWidth と同じ 900
			getBoundingClientRect: vi.fn(() => ({ width: 900 }))
		} as unknown as HTMLElement;

		expect(lockMermaidSvgDisplaySize(svg, wrap)).toBe(true);
		expect(attrs.get('width')).toBe('860');
		expect(attrs.get('height')).toBe('430');
		expect(style.width).toBe('860px');
		expect(style.height).toBe('auto');
		expect(style.maxWidth).toBe('none');
	});

	it('lockMermaidSvgDisplaySize は自然幅が収まる場合は拡大しない', () => {
		// 余白 0。自然幅 480 はコンテナ 900 に収まるので拡大しない
		vi.stubGlobal('getComputedStyle', () => ({
			// 左の内側余白。0 は引かない
			paddingLeft: '0px',
			// 右の内側余白。0 は引かない
			paddingRight: '0px'
		}));

		// viewBox は 480×240。自然幅のまま
		const attrs = new Map<string, string>([['viewBox', '0 0 480 240']]);
		// 固定前は空
		const style = {
			// 幅。空は未固定
			width: '',
			// 高さ。空は未固定
			height: '',
			// 最大幅。空は未固定
			maxWidth: ''
		};
		// 自然幅の SVG。枠より狭いので拡大しない
		const svg   = {
			// 属性を読む。無い名前は null
			getAttribute: vi.fn((name: string) => attrs.get(name) ?? null),
			// 属性を書く。自然幅のまま入る
			setAttribute: vi.fn((name: string, value: string) => attrs.set(name, value)),
			// 固定する style
			style
		} as unknown as SVGSVGElement;
		// 幅 900 の枠。自然幅 480 はこの中に収まる
		const wrap  = {
			// 枠の内側幅。px
			clientWidth: 900,
			// 枠の幅。clientWidth と同じ 900
			getBoundingClientRect: vi.fn(() => ({ width: 900 }))
		} as unknown as HTMLElement;

		expect(lockMermaidSvgDisplaySize(svg, wrap)).toBe(true);
		expect(attrs.get('width')).toBe('480');
		expect(attrs.get('height')).toBe('240');
		expect(style.width).toBe('480px');
		expect(style.maxWidth).toBe('none');
	});

	it('FencedCode から info / text を抽出する', () => {
		// mermaid のフェンス。info と本文を取り出す
		const doc   = '```mermaid\ngraph TD\n  A-->B\n```\n';
		// その構文木。選択は先頭
		const state = createState(doc);
		// 最初のフェンス。無ければ null
		const node  = findNode(state, 'FencedCode');
		expect(node).not.toBeNull();
		expect(extractFencedCodeInfo(state, node!)).toBe('mermaid');
		expect(extractFencedCodeText(state, node!)).toContain('A-->B');
		expect(isMermaidFencedCode(state, node!)).toBe(true);
	});

	it('プレビュー時に Mermaid replace を生成する', () => {
		// 前後に本文がある mermaid。カーソルは外
		const doc     = 'before\n```mermaid\ngraph TD\n  A-->B\n```\nafter';
		// カーソルは文書先頭。フェンスはプレビューになる
		const state   = createState(doc, 0);
		// ブロック装飾。mermaid の replace を含む
		const entries = collectBlockDecorationEntries(state);
		// MermaidWidget の装飾。無ければ未生成
		const mermaid = entries.find((entry) => entry.decoration.spec.widget instanceof MermaidWidget);
		expect(mermaid).toBeDefined();
		expect(mermaid!.decoration.spec.widget).toBeInstanceOf(MermaidWidget);
	});

	it('カーソルが Mermaid 内にあるときは replace しない', () => {
		// カーソルをフェンスの中へ置いた文書
		const doc     = 'before\n```mermaid\ngraph TD\n  A-->B\n```\nafter';
		// カーソルは graph の位置。このフェンスはソースのまま
		const state   = createState(doc, doc.indexOf('graph'));
		// ブロック装飾。mermaid の replace は無い
		const entries = collectBlockDecorationEntries(state);
		// MermaidWidget。見つからなければ undefined
		const mermaid = entries.find((entry) => entry.decoration.spec.widget instanceof MermaidWidget);
		expect(mermaid).toBeUndefined();
	});

	it('通常のコードブロックは Mermaid 置換しない', () => {
		// javascript のフェンス。mermaid にはしない
		const doc     = '```js\nconsole.log(1)\n```\n';
		// カーソルは外。コードブロック自体は装飾され得る
		const state   = createState(doc, 0);
		// ブロック装飾。MermaidWidget は含まない
		const entries = collectBlockDecorationEntries(state);
		expect(entries.some((entry) => entry.decoration.spec.widget instanceof MermaidWidget)).toBe(false);
	});

	it('renderMermaidSource は成功結果をキャッシュする', async () => {
		// 初期化の呼出回数。キャッシュが効けば 1 回
		const initialize = vi.fn();
		// 成功 SVG を返す描画。2 回目は呼ばれない
		const render     = vi.fn(async () => ({ svg: '<svg width="100%" height="200" data-test="ok"></svg>' }));
		// 成功する mermaid。run はこのケースでは使わない
		setMermaidModuleForTest({
			// 初期化
			initialize,
			// SVG を返す描画
			render,
			// このケースでは呼ばない
			run: vi.fn()
		});
		clearMermaidCache();

		// 同じソースを 2 回描く。2 回目はキャッシュ
		const source = 'graph TD\n  A-->B';
		// 1 回目。描画を実行する
		const first  = await renderMermaidSource(source, 'default');
		// 2 回目。first と同じオブジェクト
		const second = await renderMermaidSource(source, 'default');
		// 成功結果。HTML ラベルは無いので html モード
		expect(first).toEqual({
			// 描画できた
			ok: true,
			// 返した SVG
			svg: '<svg width="100%" height="200" data-test="ok"></svg>',
			// HTML ラベルを含まない成功
			mode: 'html'
		});
		expect(second).toBe(first);
		expect(render).toHaveBeenCalledTimes(1);
		// 初期化へ渡す設定。HTML ラベルとフローチャートの余白
		expect(initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				// ラベル内の HTML を許す
				securityLevel: 'loose',
				// HTML ラベルを使う
				htmlLabels: true,
				// フローチャートの幅と余白
				flowchart: expect.objectContaining({
					// 最大幅へ伸ばさない
					useMaxWidth: false,
					// 図の内側余白。px
					padding: 15
				})
			})
		);
	});

	it('HTML ラベル入り図は HTML モードを維持する', async () => {
		// HTML ラベルを維持する初期化
		const initialize = vi.fn();
		// 潰れていない SVG。平文へ落とさない
		const render     = vi.fn(async () => ({ svg: '<svg width="480" height="240" viewBox="0 0 480 240"></svg>' }));
		// HTML ラベルを描ける mermaid
		setMermaidModuleForTest({
			// 初期化
			initialize,
			// 十分な大きさの SVG
			render,
			// このケースでは呼ばない
			run: vi.fn()
		});
		clearMermaidCache();

		// b と br を含む図。html モードのまま
		const result = await renderMermaidSource('graph LR\nA["<b>x</b><br/>y"]', 'default');
		// 成功結果。平文へは落とさない
		expect(result).toEqual({
			// 描画できた
			ok: true,
			// 返した SVG。viewBox がある
			svg: '<svg width="480" height="240" viewBox="0 0 480 240"></svg>',
			// HTML ラベルを残す
			mode: 'html'
		});
		expect(render).toHaveBeenCalledTimes(1);
		expect(render).toHaveBeenCalledWith(expect.any(String), 'graph LR\nA["<b>x</b><br/>y"]');
		expect(initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				// HTML ラベルを有効にしたまま
				htmlLabels: true
			})
		);
	});

	it('HTML ラベル入り図が潰れた場合のみ平文へフォールバックする', async () => {
		// 1 回目は極小、2 回目は平文の十分な SVG
		const render = vi.fn().mockResolvedValueOnce({ svg: '<svg width="16" height="16"></svg>' }).mockResolvedValueOnce({ svg: '<svg width="100%" height="200"></svg>' });
		// HTML が潰れたときだけ平文で描き直す
		setMermaidModuleForTest({
			// 初期化。回数は見ない
			initialize: vi.fn(),
			// 極小の次に十分な SVG
			render,
			// このケースでは呼ばない
			run: vi.fn()
		});
		clearMermaidCache();

		// HTML ラベルが潰れる図。2 回目は平文
		const result = await renderMermaidSource('graph LR\nA["<b>x</b><br/>y"]', 'default');
		// 平文で描き直した成功
		expect(result).toEqual({
			// 2 回目は描画できた
			ok: true,
			// 平文で得た SVG
			svg: '<svg width="100%" height="200"></svg>',
			// HTML を捨てた
			mode: 'plain'
		});
		expect(render).toHaveBeenCalledTimes(2);
		expect(render).toHaveBeenNthCalledWith(1, expect.any(String), 'graph LR\nA["<b>x</b><br/>y"]');
		expect(render).toHaveBeenNthCalledWith(2, expect.any(String), 'graph LR\nA["x\ny"]');
	});

	it('HTML ラベル以外の潰れた描画は平文へフォールバックする', async () => {
		// HTML ラベルが無くても、極小なら平文で描き直す
		const render = vi.fn().mockResolvedValueOnce({ svg: '<svg width="16" height="16"></svg>' }).mockResolvedValueOnce({ svg: '<svg width="100%" height="200"></svg>' });
		// 1 回目が潰れた図を平文でやり直す
		setMermaidModuleForTest({
			// 初期化。回数は見ない
			initialize: vi.fn(),
			// 極小の次に十分な SVG
			render,
			// このケースでは呼ばない
			run: vi.fn()
		});
		clearMermaidCache();

		// HTML ラベルの無い図。それでも潰れたら平文
		const result = await renderMermaidSource('graph LR\nA-->B', 'default');
		// 平文で描き直した成功
		expect(result).toEqual({
			// 2 回目は描画できた
			ok: true,
			// 平文で得た SVG
			svg: '<svg width="100%" height="200"></svg>',
			// 平文へ落とした
			mode: 'plain'
		});
		expect(render).toHaveBeenCalledTimes(2);
	});

	it('構文エラー時は error を返す', async () => {
		// 描画が構文エラーを投げる mermaid
		setMermaidModuleForTest({
			// 初期化。エラー前に呼ばれ得る
			initialize: vi.fn(),
			// 1 行目の構文エラー
			render: vi.fn(async () => {
				throw new Error('Parse error on line 1');
			}),
			// このケースでは呼ばない
			run: vi.fn()
		});
		clearMermaidCache();

		// mermaid ではない文字列。エラー文言を返す
		const result = await renderMermaidSource('not mermaid', 'default');
		// 失敗。SVG は持たない
		expect(result).toEqual({
			// 描画できなかった
			ok: false,
			// 投げられたメッセージ
			error: 'Parse error on line 1'
		});
	});

	it('空 SVG はエラーとして扱う', async () => {
		// 空の SVG を返す mermaid。成功にはしない
		setMermaidModuleForTest({
			// 初期化
			initialize: vi.fn(),
			// SVG が空
			render: vi.fn(async () => ({ svg: '' })),
			// このケースでは呼ばない
			run: vi.fn()
		});
		clearMermaidCache();

		// 図としては正しいが、結果の SVG が空
		const result = await renderMermaidSource('graph TD; A-->B', 'default');
		expect(result.ok).toBe(false);
		// 失敗のときだけエラー文言を見る。成功ならこの分岐に入らない
		if (!result.ok) {
			expect(result.error).toContain('空');
		}
	});
});
