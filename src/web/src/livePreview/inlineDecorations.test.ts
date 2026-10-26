/**
 * 強調、コード、リンクのインライン装飾が、選択中はソースのまま残ることを検証する
 * 構文木は TMS Markdown 拡張で作り、装飾文字列だけを比較する
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectSourceLineNumbers } from './cursorLine';
import { buildDecorationSet, buildInlineDecorationsForTest, collectInlineDecorationEntries, collectLinkLabelRanges, extractLinkUrl } from './inlineDecorations';

/**
 * TMS Markdown 付き EditorState を生成する
 * @param doc - ドキュメント
 * @returns TMS Markdown 付き EditorState
 */
function createMarkdownState(doc: string): EditorState {
	return EditorState.create({
		// 装飾範囲を取る本文。選択は先頭
		doc,
		// リンクと強調のノードを得る Markdown サポート
		extensions: [createTmsMarkdownSupport()]
	});
}

/**
 * 最初の Link ノードを取得する
 * @param state - エディタ状態
 * @returns 最初の Link ノード。無ければ null
 */
function findFirstLinkNode(state: EditorState) {
	// 最初の Link。無ければ null のまま
	let linkNode: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * Link ノードを探索する
		 * @param ref - ノード参照
		 * @returns 子の走査を止めるとき false。続けるときは値を返さない
		 */
		enter(ref) {
			// 最初の Link だけを採用し、探索を止める
			if (ref.name === 'Link') {
				// 採用するリンク。2 件目は見ない
				linkNode = ref.node;
				return false;
			}
		}
	});
	return linkNode;
}

describe('inlineDecorations', () => {
	it('extractLinkUrl は URL を取得する', () => {
		// URL 付きの標準リンク
		const state    = createMarkdownState('[label](https://example.com/path)');
		// 最初の Link。無ければ URL は取れない
		const linkNode = findFirstLinkNode(state);
		expect(linkNode).not.toBeNull();
		expect(extractLinkUrl(state, linkNode!)).toBe('https://example.com/path');
	});

	it('extractLinkUrl は URL なし Link で空文字を返す', () => {
		// URL の無いリンク。戻りは空文字
		const state    = createMarkdownState('[label]');
		// 最初の Link。URL ノードは無い
		const linkNode = findFirstLinkNode(state);
		expect(linkNode).not.toBeNull();
		expect(extractLinkUrl(state, linkNode!)).toBe('');
	});

	it('collectLinkLabelRanges は標準リンクの表示文字範囲を返す', () => {
		// 表示文字と URL が分かれる標準リンク
		const state    = createMarkdownState('[label](https://example.com/path)');
		// 最初の Link
		const linkNode = findFirstLinkNode(state);
		// 表示文字の範囲。URL は含まない
		const ranges   = collectLinkLabelRanges(linkNode!);

		expect(ranges.map((range) => state.doc.sliceString(range.from, range.to))).toEqual(['label']);
	});

	it('複数行 Markdown でも DecorationSet を構築できる', () => {
		// 強調、ハイライト、内部リンクが複数行にある文書
		const state = createMarkdownState('**line1**\n*line2*\n~~line3~~\n==hi==\n[[page]]');
		expect(() => buildInlineDecorationsForTest(state)).not.toThrow();
	});

	it('プレビュー行のインラインコードは CodeMark を隠し内容を装飾する', () => {
		// 1 行目はカーソル、2 行目に空白付きの java 接頭辞
		const doc           = ['line1', 'prefix `{java} private String fileId1 = "Hoge";` suffix'].join('\n');
		// カーソルは先頭。2 行目がプレビュー
		const state         = EditorState.create({
			// 接頭辞の後ろに空白があるインラインコード
			doc,
			// 空のキャレット。文書先頭
			selection: { anchor: 0 },
			// コードノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines   = collectSourceLineNumbers(state);
		// プレビュー行の装飾
		const entries       = collectInlineDecorationEntries(state, sourceLines);
		// 隠すバッククォート。開始と終了の 2 つ
		const hiddenMarks   = entries.filter((entry) => state.doc.sliceString(entry.from, entry.to) === '`');
		// 隠す言語接頭辞。後ろの空白まで含む
		const hiddenLang    = entries.find((entry) => state.doc.sliceString(entry.from, entry.to) === '{java} ');
		// コード装飾。接頭辞を含み、バッククォートは含まない
		const styledContent = entries.find((entry) => entry.decoration.spec.class === 'cm-md-code' && state.doc.sliceString(entry.from, entry.to) === '{java} private String fileId1 = "Hoge";');

		expect(sourceLines).toEqual(new Set([1]));
		expect(hiddenMarks.length).toBe(2);
		expect(hiddenLang).toBeDefined();
		expect(styledContent).toBeDefined();
	});

	it('プレビュー行の `{java}` は直後スペースなしでも言語接頭辞を隠す', () => {
		// 接頭辞の直後に空白が無い java
		const doc        = ['line1', 'x `{java}String a = b;` y'].join('\n');
		// カーソルは先頭。2 行目がプレビュー
		const state      = EditorState.create({
			// 接頭辞と本文が接しているインラインコード
			doc,
			// 空のキャレット。文書先頭
			selection: { anchor: 0 },
			// コードノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// 文書全体のインライン装飾
		const entries    = collectInlineDecorationEntries(state);
		// 隠す接頭辞。空白は含まない
		const hiddenLang = entries.find((entry) => state.doc.sliceString(entry.from, entry.to) === '{java}');
		// コード装飾。接頭辞を含む
		const styled     = entries.find((entry) => entry.decoration.spec.class === 'cm-md-code' && state.doc.sliceString(entry.from, entry.to) === '{java}String a = b;');

		expect(hiddenLang).toBeDefined();
		expect(styled).toBeDefined();
	});

	it('プレビュー行は `{lang}` 直後の空白だけを隠し、接頭辞なしの先頭空白は残す', () => {
		// 接頭辞の後ろに空白が 3 つあるコード
		const withLang    = EditorState.create({
			// 言語接頭辞と、その直後の空白
			doc: 'x\n`{javascript}   const a = b;`',
			// 空のキャレット。1 行目がソース
			selection: { anchor: 0 },
			// コードノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// 接頭辞が無く、先頭が空白のコード
		const withoutLang = EditorState.create({
			// 先頭空白は本文の一部
			doc: 'x\n`   const a = b;`',
			// 空のキャレット。1 行目がソース
			selection: { anchor: 0 },
			// コードノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// 接頭辞と直後の空白。隠す対象
		const hiddenLang  = collectInlineDecorationEntries(withLang).find((entry) => withLang.doc.sliceString(entry.from, entry.to) === '{javascript}   ');
		// 接頭辞の無い先頭空白。隠れていたら失敗
		const hiddenLead  = collectInlineDecorationEntries(withoutLang).find((entry) => withoutLang.doc.sliceString(entry.from, entry.to) === '   ');
		// 先頭空白を含むコード装飾
		const styledLead  = collectInlineDecorationEntries(withoutLang).find((entry) => entry.decoration.spec.class === 'cm-md-code' && withoutLang.doc.sliceString(entry.from, entry.to) === '   const a = b;');

		expect(hiddenLang).toBeDefined();
		expect(hiddenLead).toBeUndefined();
		expect(styledLead).toBeDefined();
	});

	it('未知言語の `{notalang}` は接頭辞を隠さない', () => {
		// カタログに無い言語名。接頭辞は隠さない
		const doc     = ['line1', 'x `{notalang}String a;` y'].join('\n');
		// カーソルは先頭。2 行目がプレビュー
		const state   = EditorState.create({
			// 未知言語の接頭辞
			doc,
			// 空のキャレット。文書先頭
			selection: { anchor: 0 },
			// コードノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// 文書全体のインライン装飾
		const entries = collectInlineDecorationEntries(state);
		// 接頭辞を隠す装飾。見つからなければ undefined
		const hidden  = entries.find((entry) => state.doc.sliceString(entry.from, entry.to) === '{notalang}');

		expect(hidden).toBeUndefined();
	});

	it('プレビュー行の標準リンクは記号を隠し表示文字をリンク装飾する', () => {
		// 2 行目の標準リンク。記号は隠し、表示文字だけを装飾する
		const state       = EditorState.create({
			// リンクは 2 行目
			doc: 'x\nリンク：[りんく](https://tm-systems.jp/)',
			// 空のキャレット。1 行目がソース
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// リンクノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// プレビュー行の装飾
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		// 表示文字のリンク装飾。URL は含まない
		const linkText    = entries.find((entry) => entry.decoration.spec.class === 'cm-md-link' && state.doc.sliceString(entry.from, entry.to) === 'りんく');

		expect(linkText?.decoration.spec.attributes).toEqual({ 'data-href': 'https://tm-systems.jp/' });
	});

	it('プレビュー行のリンク表示文字列内インラインコードは両方を装飾する', () => {
		// リンクの表示文字がインラインコード。両方を装飾する
		const state       = EditorState.create({
			// コードを表示文字にしたリンクは 2 行目
			doc: 'x\n* [`3c78a7b`](https://github.com/eslint/eslint/commit/3c78a7bff6044fd196ae3b737983e6744c6eb7c8) Chore',
			// 空のキャレット。1 行目がソース
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// リンクとコードのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// プレビュー行の装飾
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		// 隠すバッククォート。開始と終了
		const hiddenMarks = entries.filter((entry) => entry.decoration.spec.class === undefined && state.doc.sliceString(entry.from, entry.to) === '`');
		// コード装飾。バッククォートは含まない
		const code        = entries.find((entry) => entry.decoration.spec.class === 'cm-md-code' && state.doc.sliceString(entry.from, entry.to) === '3c78a7b');
		// リンク装飾。バッククォートを含めた表示文字
		const link        = entries.find((entry) => entry.decoration.spec.class === 'cm-md-link' && state.doc.sliceString(entry.from, entry.to) === '`3c78a7b`');

		expect(hiddenMarks.length).toBe(2);
		expect(code).toBeDefined();
		expect(link?.decoration.spec.attributes).toEqual({
			'data-href': 'https://github.com/eslint/eslint/commit/3c78a7bff6044fd196ae3b737983e6744c6eb7c8'
		});
		expect(() => buildDecorationSet(entries)).not.toThrow();
	});

	it('カーソルがインラインコード内にあるときは記法を表示しコード装飾は全体を囲む', () => {
		// カーソルを接頭辞の中へ置く 1 行。記法は隠さない
		const doc     = 'prefix `{java} private String fileId1 = "Hoge";` suffix';
		// バッククォートを含むコード全体。装飾範囲の期待
		const inline  = '`{java} private String fileId1 = "Hoge";`';
		// キャレットは { の位置。この行はソース表示
		const state   = EditorState.create({
			// カーソルが中にあるインラインコード
			doc,
			// { の位置。空のキャレット
			selection: { anchor: doc.indexOf('{') },
			// コードノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// その行の装飾。記法は隠さない
		const entries = collectInlineDecorationEntries(state);
		// バッククォートか接頭辞を隠す範囲。0 件
		const hidden  = entries.filter((entry) => state.doc.sliceString(entry.from, entry.to) === '`' || state.doc.sliceString(entry.from, entry.to) === '{java}');
		// 記法全体を囲むコード装飾
		const styled  = entries.find((entry) => entry.decoration.spec.class === 'cm-md-code' && state.doc.sliceString(entry.from, entry.to) === inline);

		expect(hidden.length).toBe(0);
		expect(styled).toBeDefined();
	});

	it('同じ行でもカーソル外のインライン構文はプレビューを維持する', () => {
		// 太字、コード、リンクが同じ行。キャレットは先頭
		const doc     = '先頭 **太字** 中間 `code` 末尾 [リンク](https://example.com/long/path)';
		// キャレットは文書先頭。どの要素の中でもない
		const state   = EditorState.create({
			// 3 種類のインライン
			doc,
			// 空のキャレット。文書先頭
			selection: { anchor: 0 },
			// 強調とリンクのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// その行の装飾。3 種類ともプレビュー
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strong')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-code')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-link')).toBe(true);
	});

	it('カーソルがインラインコード内でも同じ行の他要素はプレビューを維持する', () => {
		// キャレットは code の中。太字とリンクはプレビューのまま
		const doc     = '先頭 **太字** 中間 `code` 末尾 [リンク](https://example.com/long/path)';
		// キャレットは code の 2 文字目
		const state   = EditorState.create({
			// 3 種類のインライン
			doc,
			// code の中。空のキャレット
			selection: { anchor: doc.indexOf('code') + 1 },
			// 強調とリンクのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// その行の装飾。コードは記法付き
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strong')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-code' && state.doc.sliceString(entry.from, entry.to) === '`code`')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-link')).toBe(true);
	});

	it('カーソルと交差する要素だけソース表示し、同じ行の別要素はプレビューを維持する', () => {
		// キャレットは太字の中。コードとリンクはプレビュー
		const doc     = '先頭 **太字** 中間 `code` 末尾 [リンク](https://example.com/long/path)';
		// キャレットは太字の 2 文字目
		const state   = EditorState.create({
			// 3 種類のインライン
			doc,
			// 太字の中。空のキャレット
			selection: { anchor: doc.indexOf('太字') + 1 },
			// 強調とリンクのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// その行の装飾。太字はソースのまま
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strong')).toBe(false);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-code')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-link')).toBe(true);
	});

	it('複数行選択と交差する複数要素だけソース表示する', () => {
		// 選択が太字から斜体まで。取消は範囲の外
		const doc     = '**太字**\n通常\n*斜体* と ~~取消~~';
		// 太字の先頭から斜体の途中まで
		const state   = EditorState.create({
			// 3 行。取消は 3 行目の後半
			doc,
			// 複数行の選択。空のキャレットではない
			selection: {
				// 選択の起点。太字の先頭
				anchor: doc.indexOf('太字'),
				// 選択の終点。斜体の途中
				head: doc.indexOf('斜体') + 1
			},
			// 強調のノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// 範囲と交差した要素はソース、取消はプレビュー
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strong')).toBe(false);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-em')).toBe(false);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strike')).toBe(true);
	});

	it('リンク内コードのカーソルでは親リンクはソース表示し内側コードは記法付きで装飾する', () => {
		// リンク内コードにキャレット。別コードはプレビュー
		const doc     = '[`3c78a7b`](https://example.com/very/long/url) と `別コード`';
		// キャレットはリンク内コードの途中
		const state   = EditorState.create({
			// 親リンクと、その外のコード
			doc,
			// ハッシュの途中。空のキャレット
			selection: { anchor: doc.indexOf('3c78a7b') + 1 },
			// リンクとコードのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// 親リンクはソース、内側コードは記法付き、別コードは中身だけ
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-link')).toBe(false);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-code' && state.doc.sliceString(entry.from, entry.to) === '`3c78a7b`')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-code' && state.doc.sliceString(entry.from, entry.to) === '別コード')).toBe(true);
	});

	it('プレビュー行の ==ハイライト== は記号を隠し内容を装飾する', () => {
		// 2 行目のハイライト。記号は隠し、中身を装飾する
		const state       = EditorState.create({
			// ハイライトは 2 行目
			doc: 'x\nsee ==marked== here',
			// 空のキャレット。1 行目がソース
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// ハイライトノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// プレビュー行の装飾
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		// 隠す == 。開始と終了
		const marks       = entries.filter((entry) => state.doc.sliceString(entry.from, entry.to) === '==');
		// 中身のハイライト装飾
		const content     = entries.find((entry) => entry.decoration.spec.class === 'cm-md-highlight' && state.doc.sliceString(entry.from, entry.to) === 'marked');

		expect(marks.length).toBe(2);
		expect(content).toBeDefined();
	});

	it('プレビュー行の [[内部リンク]] は括弧を隠しリンク風に装飾する', () => {
		// 2 行目の内部リンク。括弧は隠し、ページ名を装飾する
		const state       = EditorState.create({
			// 内部リンクは 2 行目
			doc: 'x\ngo [[Page Name]] now',
			// 空のキャレット。1 行目がソース
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 内部リンクのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// プレビュー行の装飾
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		// 隠す括弧。開始 [[ と終了 ]]
		const brackets    = entries.filter((entry) => {
			// その装飾が隠している文字列
			const text = state.doc.sliceString(entry.from, entry.to);
			return text === '[[' || text === ']]';
		});
		// ページ名のリンク装飾
		const page = entries.find((entry) => entry.decoration.spec.class === 'cm-md-wikilink' && state.doc.sliceString(entry.from, entry.to) === 'Page Name');

		expect(brackets.length).toBe(2);
		expect(page).toBeDefined();
	});

	it('本文の [[path|label]] はラベルだけを表示する', () => {
		// パスとラベル。見えるのはラベルだけ
		const state       = EditorState.create({
			// ラベル付き内部リンクは 2 行目
			doc: 'x\nsee [[docs/要望_009|要望_009]] now',
			// 空のキャレット。1 行目がソース
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 内部リンクのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// プレビュー行の装飾
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		// 見えるリンク装飾。ラベルだけ
		const visible     = entries.find((entry) => entry.decoration.spec.class === 'cm-md-wikilink');
		// 隠すパスと区切り。ラベルは含まない
		const hiddenPath  = entries.find((entry) => state.doc.sliceString(entry.from, entry.to) === 'docs/要望_009|');

		expect(visible).toBeDefined();
		expect(state.doc.sliceString(visible!.from, visible!.to)).toBe('要望_009');
		expect(hiddenPath).toBeDefined();
	});

	it('本文の [[path\\|label]] もラベルだけを表示する', () => {
		// エスケープした区切り。見えるのはラベルだけ
		const state       = EditorState.create({
			// エスケープした区切りの内部リンクは 2 行目
			doc: 'x\nsee [[docs/要望_009\\|要望_009]] now',
			// 空のキャレット。1 行目がソース
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 内部リンクのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// プレビュー行の装飾
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		// 見えるリンク装飾。ラベルだけ
		const visible     = entries.find((entry) => entry.decoration.spec.class === 'cm-md-wikilink');

		expect(visible).toBeDefined();
		expect(state.doc.sliceString(visible!.from, visible!.to)).toBe('要望_009');
		expect(entries.some((entry) => state.doc.sliceString(entry.from, entry.to) === 'docs/要望_009\\|')).toBe(true);
	});
});
