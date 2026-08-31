import { describe, expect, it } from 'vitest';
import { buildExportCss, decorateText, renderExportHtml, type ExportMermaidResult } from './renderExportHtml';
import { compileCustomDecorationRules } from '../livePreview/customDecorations';

/**
 * 成功した Mermaid 結果を返す
 * @returns {Promise<ExportMermaidResult>}
 */
async function mermaidOk(): Promise<ExportMermaidResult> {
	return { ok: true, svg: '<svg><g>ok</g></svg>' };
}

/**
 * 失敗した Mermaid 結果を返す
 * @returns {Promise<ExportMermaidResult>}
 */
async function mermaidError(): Promise<ExportMermaidResult> {
	return { ok: false, error: '構文エラー' };
}

/**
 * 画像解決失敗を返す
 * @returns {Promise<null>}
 */
async function unresolvedImage(): Promise<null> {
	return null;
}

/**
 * 固定 Data URL を返す
 * @returns {Promise<string>}
 */
async function resolvedPng(): Promise<string> {
	return 'data:image/png;base64,abc';
}

const underlineRule = {
	name           : '下線',
	enabled        : true,
	pattern        : '_v(.+?)_v',
	hideDelimiters : true,
	cssClass       : 'tms-underline',
};

/**
 * @param {string} markdown Markdown
 * @param {Partial<import('./renderExportHtml').RenderExportHtmlOptions>} [extra] 追加オプション
 * @returns {Promise<string>}
 */
async function render(
	markdown: string,
	extra: Partial<import('./renderExportHtml').RenderExportHtmlOptions> = {},
): Promise<string> {
	return renderExportHtml({
		markdown,
		title : 'テスト',
		theme : 'light',
		...extra,
	});
}

describe('renderExportHtml', () => {
	it('見出し・強調・リストをセマンティック HTML にする', async () => {
		const html = await render('# 見出し1\n\nこれは **太字** と *斜体* です。\n\n- 一つ\n- 二つ\n');
		expect(html).toContain('<h1 class="cm-line cm-md-h1" id="tms-mde-h-0">見出し1</h1>');
		expect(html).toContain('tms-mde-export-outline');
		expect(html).toContain('href="#tms-mde-h-0"');
		expect(html).toContain('class="tms-mde-export-shell"');
		expect(html).toContain('id="tms-mde-export-outline-side-left"');
		expect(html).toMatch(/id="tms-mde-export-outline-side-right"[^>]*checked/);
		expect(html).toContain('<strong class="cm-md-strong">太字</strong>');
		expect(html).toContain('<em class="cm-md-em">斜体</em>');
		expect(html).toContain('<ul>');
		expect(html).toContain('<li>一つ</li>');
		expect(html).toContain('data-outline-expand');
		expect(html).toContain('すべて展開');
		expect(html).toContain('すべて折りたたむ');
		expect(html).not.toContain('alert');
	});

	it('テーブルを table にする', async () => {
		const html = await render('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
		expect(html).toContain('<table class="cm-md-table">');
		expect(html).toContain('<th>');
		expect(html).toContain('A');
		expect(html).toContain('<td>');
		expect(html).toContain('1');
	});

	it('コールアウトを展開して出す', async () => {
		const html = await render('> [!warning] 注意\n> 本体です\n');
		expect(html).toContain('cm-md-callout-warning');
		expect(html).toContain('cm-md-callout-title');
		expect(html).toMatch(/cm-md-callout-title">注意<\/p>/);
		expect(html).toContain('cm-md-callout-body');
		expect(html).toContain('本体です');
		expect(html).not.toMatch(/cm-md-callout-title">[^<]*本体です/);
	});

	it('ハイライトと Wiki リンクを出す', async () => {
		const html = await render('==重要== と [[内部]] です。\n');
		expect(html).toContain('<mark class="cm-md-highlight">重要</mark>');
		expect(html).toContain('<span class="cm-md-wikilink">内部</span>');
	});

	it('許可インライン HTML を残し script は出さない', async () => {
		const html = await render('ここは <mark>印</mark> です。\n\n<script>alert(1)</script>\n');
		expect(html).toContain('<mark');
		expect(html).toContain('印');
		expect(html).not.toContain('alert(1)');
		expect(html).not.toMatch(/<script>[\s\S]*alert/);
	});

	it('カスタム装飾の区切りを隠しクラスを付ける', async () => {
		const html = await render('これは _v下線_v です。\n', { customDecorations: [underlineRule] });
		expect(html).toContain('<span class="tms-underline">下線</span>');
		expect(html).not.toContain('_v下線_v');
	});

	it('YAML フロントマターを出力しない', async () => {
		const html = await render('---\ntitle: secret\n---\n\n# 本文見出し\n');
		expect(html).toContain('<h1 class="cm-line cm-md-h1" id="tms-mde-h-0">本文見出し</h1>');
		expect(html).not.toContain('secret');
		expect(html).not.toContain('title:');
	});

	it('チェックボックスは disabled で出す', async () => {
		const html = await render('- [x] 完了\n- [ ] 未完了\n');
		expect(html).toContain('type="checkbox"');
		expect(html).toContain('disabled');
		expect(html).toContain('checked');
		expect(html).toContain('完了');
		expect(html).toContain('未完了');
	});

	it('Mermaid 成功時は SVG をインライン化する', async () => {
		const html = await render('```mermaid\ngraph TD; A-->B\n```\n', {
			renderMermaid: mermaidOk,
		});
		expect(html).toContain('<figure class="cm-md-mermaid"><svg><g>ok</g></svg></figure>');
	});

	it('Mermaid 失敗時はエラーとソースを出す', async () => {
		const html = await render('```mermaid\nbroken\n```\n', {
			renderMermaid: mermaidError,
		});
		expect(html).toContain('cm-md-mermaid-error');
		expect(html).toContain('構文エラー');
		expect(html).toContain('broken');
	});

	it('画像解決に失敗したらプレースホルダを出す', async () => {
		const html = await render('![図](missing.png)\n', {
			filePath    : 'C:\\docs\\note.md',
			resolveImage: unresolvedImage,
		});
		expect(html).toContain('cm-md-image-fallback');
		expect(html).toContain('missing.png');
	});

	it('画像 Data URL を埋め込む', async () => {
		const html = await render('![図](a.png)\n', {
			filePath    : 'C:\\docs\\note.md',
			resolveImage: resolvedPng,
		});
		expect(html).toContain('src="data:image/png;base64,abc"');
		expect(html).toContain('alt="図"');
	});

	it('段落内のソース改行を br にする', async () => {
		const html = await render('太字：**太字**\n斜体：*斜体*\n打ち消し：~~打消し~~\n');
		expect(html).toContain('<br>');
		expect(html).toMatch(/太字<\/strong><br>/);
		expect(html).toMatch(/斜体<\/em><br>/);
		expect(html).toContain('打消し');
	});

	it('長い文書の末尾まで出力する', async () => {
		const filler = Array.from({ length: 80 }, (_, index) => (
			`## 見出し${index}\n\n本文${index} ${'あ'.repeat(40)}\n\n`
		)).join('');
		const html   = await render(`${filler}\n\n## 終端見出しUNIQUE-EXPORT-TAIL\n\n最後の段落UNIQUE-EXPORT-END\n`);
		expect(html).toContain('終端見出しUNIQUE-EXPORT-TAIL');
		expect(html).toContain('最後の段落UNIQUE-EXPORT-END');
		expect(html).toMatch(/tms-mde-export-outline-item[^>]*>終端見出しUNIQUE-EXPORT-TAIL/);
	});

	it('大きなフェンスコードの後の見出しもアウトラインに入れる', async () => {
		const fence = ['```text', ...Array.from({ length: 80 }, (_, index) => `line-${index} ${'x'.repeat(40)}`), '```'].join('\n');
		const html  = await render(`# 先頭見出し\n\n${fence}\n\n## フェンス後UNIQUE-OUTLINE-AFTER\n`);
		expect(html).toContain('id="tms-mde-h-0"');
		expect(html).toContain('id="tms-mde-h-1"');
		expect(html).toMatch(/tms-mde-export-outline-item[^>]*>フェンス後UNIQUE-OUTLINE-AFTER/);
		expect(html).toContain('href="#tms-mde-h-1"');
	});

	it('有効スニペットとテーマを埋め込む', async () => {
		const snippet = '.tms-custom-1-underline-nomal { text-decoration: underline; }';
		const html    = await render('# A\n', {
			snippetsCss : [snippet],
			theme       : 'dark',
		});
		expect(html).toContain(snippet);
		expect(html).toContain('tms-mde-editor-host');
		expect(html).toContain('tms-mde-theme-dark');
		expect(html).toContain('tms-mde-export');
		expect(html).toContain('tms-mde-body');
		expect(html).toContain('data-os-theme="dark"');
		expect(html).toContain('cm-editor tms-mde-cm-live-preview');
	});

	it('見出しにライブプレビューと同じ cm-line クラスを付ける', async () => {
		const html = await render('### 小見出し\n');
		expect(html).toContain('<h3 class="cm-line cm-md-h3" id="tms-mde-h-0">小見出し</h3>');
		expect(html).toContain('tms-mde-body tms-mde-theme-light');
		expect(html).not.toContain('data-os-theme');
	});

	it('Markdown 強調の内側でもカスタム装飾を付ける', async () => {
		const html = await render('_v**太字**_v\n', { customDecorations: [underlineRule] });
		expect(html).toContain('tms-underline');
		expect(html).toContain('太字');
		expect(html).not.toContain('_v');
	});

	it('HTML出力アウトラインの左右を閲覧者が切り替えられる', async () => {
		const html = await render('# 見出し1\n\n## 見出し2\n', {
			outline: { enabled: true },
		});
		expect(html).toContain('name="tms-mde-export-outline-side"');
		expect(html).toContain('id="tms-mde-export-outline-side-left"');
		expect(html).toMatch(/id="tms-mde-export-outline-side-right"[^>]*checked/);
		expect(html).toContain(':has(#tms-mde-export-outline-side-left:checked)');
		expect(html).toContain('href="#tms-mde-h-0"');
		expect(html).toContain('href="#tms-mde-h-1"');
		expect(html).toContain('id="tms-mde-h-1"');
		expect(html).toContain('見出し2');
		expect(html).toContain('.tms-mde-export-outline { display: none !important; }');
		expect(html).toContain('data-outline-expand');
		expect(html).toContain('data-outline-collapse');
		expect(html).toContain('tms-mde-export-outline-fold');
		expect(html).toMatch(/class="tms-mde-export-outline-fold"[^>]*checked/);
		expect(html).toContain('tms-mde-export-outline-twist');
		expect(html).toContain('tms-mde-export-outline-children');
		expect(html).toContain('tms-mde-export-outline-guide');
		expect(html).toContain('content: "▼"');
		expect(html).toContain('content: "▶"');
		expect(html).not.toContain('<ol class="tms-mde-export-outline-list"');
		expect(html).toMatch(/<script>[\s\S]*data-outline-expand/);
		expect(html).not.toContain('alert(1)');
	});

	it('HTML出力アウトラインをオフにできる', async () => {
		const html = await render('# 見出し1\n', {
			outline: { enabled: false },
		});
		expect(html).toContain('<h1 class="cm-line cm-md-h1">見出し1</h1>');
		expect(html).not.toContain('<nav class="tms-mde-export-outline"');
		expect(html).not.toContain('class="tms-mde-export-shell');
		expect(html).not.toContain('id="tms-mde-h-0"');
		expect(html).not.toContain('data-outline-expand');
		expect(html).not.toContain('<script>');
	});

	it('ユーザ定義の下線・波下線ルールをクラス付きで出す', async () => {
		const html = await render(
			'_vあいうえお123abcノーマル下線_v\n_vvあいうえお123abc_v赤い波下線_vaa_vv\n',
			{
				customDecorations: [
					{
						name           : 'ノーマル下線',
						enabled        : true,
						pattern        : '_v([^v].+?)_v',
						hideDelimiters : true,
						cssClass       : 'tms-custom-1-underline-nomal',
					},
					{
						name           : '赤い波下線',
						enabled        : true,
						pattern        : '_vv(.+?)_vv',
						hideDelimiters : true,
						cssClass       : 'tms-custom-2-underline-wave-red',
					},
				],
				snippetsCss: [
					'.tms-custom-1-underline-nomal { text-decoration: underline; }',
					'.tms-custom-2-underline-wave-red { text-decoration: underline 2px wavy red; }',
				],
			},
		);
		expect(html).toContain('tms-custom-1-underline-nomal');
		expect(html).toContain('あいうえお123abcノーマル下線');
		expect(html).toContain('tms-custom-2-underline-wave-red');
		expect(html).toContain('赤い波下線');
		expect(html).toContain('tms-custom-1-underline-nomal { text-decoration: underline; }');
		expect(html).not.toMatch(/_vあいうえお/);
	});
});

describe('buildExportCss', () => {
	it('テーマ変数とスニペットを返す', () => {
		const css = buildExportCss({ theme: 'dark', snippetsCss: ['.x{}'] });
		expect(css).toContain('.x{}');
		expect(css).toContain('--tms-mde-color-heading');
		expect(css).toContain('tms-mde-theme-dark');
		expect(css).toContain('print-color-adjust: exact');
		expect(css).toContain('max-height: none !important');
		expect(css).toContain('overflow: visible !important');
		expect(css).not.toContain('background: #ffffff !important');
		expect(css).toContain('.tms-mde-export-outline');
		expect(css).toContain(':has(#tms-mde-export-outline-side-left:checked)');
		expect(css).toContain('.tms-mde-export-outline { display: none !important; }');
		expect(css).toContain('.tms-mde-export-outline-fold');
		expect(css).toContain('.tms-mde-export-outline-twist');
		expect(css).toContain('.tms-mde-export-outline-children');
		expect(css).toContain('.tms-mde-export-outline-guide');
		expect(css).not.toContain('.tms-mde-export-outline-row::before');
		expect(css).toContain('content: "▼"');
		expect(css).toContain('content: "▶"');
	});
});

describe('decorateText', () => {
	it('キャプチャグループだけを装飾する', () => {
		const { rules } = compileCustomDecorationRules([underlineRule]);
		expect(decorateText('前 _v中_v 後', rules)).toBe('前 <span class="tms-underline">中</span> 後');
	});

	it('ソース改行を br にする', () => {
		expect(decorateText('1行目\n2行目', [])).toBe('1行目<br>2行目');
	});
});
