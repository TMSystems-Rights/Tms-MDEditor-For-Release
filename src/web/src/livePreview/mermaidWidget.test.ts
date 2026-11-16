/**
 * Mermaid フェンスの抽出、プレビューの置換、Pele による書き出し用の SVG 化を検証する
 * SVG 化は本物の Pele を Node 上で動かす。ウィジェットの描画は DOM が要るので、比較と高さの見積もりだけを見る
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectBlockDecorationEntries } from './blockWidgets';
import { MermaidWidget, buildMermaidRenderOptions, extractFencedCodeInfo, extractFencedCodeText, isMermaidCodeInfo, isMermaidFencedCode, renderMermaidSource } from './mermaidWidget';

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
		 * 指定名の最初のノードを見つけたら探索を止める
		 * @param ref - 走査中のノード
		 * @returns 見つけたとき false。それ以外は未指定で探索を続ける
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
	it('isMermaidCodeInfo は mermaid のみ真', () => {
		expect(isMermaidCodeInfo('mermaid')).toBe(true);
		expect(isMermaidCodeInfo('MERMAID')).toBe(true);
		expect(isMermaidCodeInfo('js')).toBe(false);
		expect(isMermaidCodeInfo('')).toBe(false);
	});

	it('isMermaidCodeInfo は言語名の後ろに title: があっても先頭の言語名で判定する', () => {
		expect(isMermaidCodeInfo('mermaid title:"フローチャート"')).toBe(true);
		expect(isMermaidCodeInfo('  Mermaid  title:図')).toBe(true);
		expect(isMermaidCodeInfo('mermaidjs')).toBe(false);
		expect(isMermaidCodeInfo('title:"mermaid"')).toBe(false);
	});

	it('title: 付きの Mermaid フェンスも図に置き換え、タイトルをウィジェットへ渡す', () => {
		// タイトル付きの mermaid。Obsidian の書き方
		const doc     = 'before\n```mermaid title:"フローチャートのサンプル"\nflowchart TB\n  A-->B\n```\nafter';
		// カーソルは文書先頭。フェンスはプレビューになる
		const state   = createState(doc, 0);
		// MermaidWidget の装飾。無ければ未生成
		const mermaid = collectBlockDecorationEntries(state).find((entry) => entry.decoration.spec.widget instanceof MermaidWidget);
		expect(mermaid).toBeDefined();
		// 置き換えたウィジェット
		const widget = mermaid!.decoration.spec.widget as MermaidWidget;
		expect(widget.title).toBe('フローチャートのサンプル');
		expect(widget.source).toBe('flowchart TB\n  A-->B');
		expect(widget.eq(new MermaidWidget(widget.source, '別のタイトル'))).toBe(false);
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
		expect((mermaid!.decoration.spec.widget as MermaidWidget).source).toContain('A-->B');
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

	it('MermaidWidget は同じソースのときだけ再利用され、高さを行数から見積もる', () => {
		// 3 行の図
		const widget = new MermaidWidget('graph TD\n  A-->B\n  B-->C');

		expect(widget.eq(new MermaidWidget('graph TD\n  A-->B\n  B-->C'))).toBe(true);
		expect(widget.eq(new MermaidWidget('graph TD\n  A-->C'))).toBe(false);
		expect(widget.estimatedHeight).toBe(160);
		expect(new MermaidWidget('x\n'.repeat(100)).estimatedHeight).toBe(640);
	});

	it('描画オプションは図のリンクを http(s) だけに絞る', () => {
		expect(buildMermaidRenderOptions().linkSchemes).toEqual(['http', 'https']);
	});
});

describe('renderMermaidSource', () => {
	it('Pele で SVG にし、ラベルの改行と太字を図の中へ残す', async () => {
		// <br> と <b> を含むラベル。Mermaid と同じ書き方
		const result = await renderMermaidSource('flowchart LR\n  A[開始<br>2行目] --> B[<b>太字</b>]');

		expect(result.ok).toBe(true);
		// 成功したときの SVG。失敗なら空文字
		const svg = result.ok ? result.svg : '';
		expect(svg).toMatch(/^<svg [^>]*class="pele pele-flowchart"/);
		expect(svg).toContain('<tspan x="0" y="-4.9">開始</tspan>');
		expect(svg).toContain('2行目');
		expect(svg).toContain('太字');
	});

	it('呼び出しごとに SVG 内の id 接頭辞を変え、同じ図を並べても id が重ならない', async () => {
		// 読み上げ用タイトルを持つ図。タイトルの id に接頭辞が付く
		const source = 'flowchart LR\n  accTitle: 図\n  A --> B';
		// 同じソースを 2 回描いた結果
		const first  = await renderMermaidSource(source);
		// 2 回目。接頭辞の通し番号が進む
		const second = await renderMermaidSource(source);

		// それぞれのタイトルの id。描けなければ undefined
		const firstId  = first.ok ? /id="(tms-mde-mermaid-\d+)-title"/.exec(first.svg)?.[1] : undefined;
		// 2 回目のタイトルの id
		const secondId = second.ok ? /id="(tms-mde-mermaid-\d+)-title"/.exec(second.svg)?.[1] : undefined;
		expect(firstId).toBeDefined();
		expect(secondId).toBeDefined();
		expect(firstId).not.toBe(secondId);
	});

	it('渡したフォントと大きさで測り、SVG の font 指定にも使う', async () => {
		// 本文フォントを指定した描画
		const result = await renderMermaidSource('flowchart LR\n  A --> B', { fontFamily: 'Consolas, monospace', fontSize: 20 });

		// 成功したときの SVG
		const svg = result.ok ? result.svg : '';
		expect(svg).toContain('font:20px ');
		expect(svg).toContain('font-family:var(--pele-font,Consolas, monospace)');
	});

	it('http(s) 以外のリンクは図に残さない', async () => {
		// ftp と https のリンクを 1 つずつ持つ図
		const result = await renderMermaidSource('flowchart LR\n  A --> B\n  click A "ftp://example.com"\n  click B "https://example.com"');

		// 成功したときの SVG
		const svg = result.ok ? result.svg : '';
		expect(svg).toContain('<a href="https://example.com/"');
		expect(svg).not.toContain('ftp://');
	});

	it('構文エラーは例外にせず、位置付きの理由を返す', async () => {
		// 矢印の先が無い図
		const result = await renderMermaidSource('flowchart LR\n  A -->');

		expect(result.ok).toBe(false);
		expect(result.ok ? '' : result.error).toContain('Parse error on line 2');
	});

	it('空のブロックは描かずに理由を返す', async () => {
		expect(await renderMermaidSource('  \n')).toEqual({ ok: false, error: '空の Mermaid ブロックです' });
	});
});
