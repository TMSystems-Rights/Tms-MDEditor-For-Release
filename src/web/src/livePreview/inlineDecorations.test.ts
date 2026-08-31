import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectSourceLineNumbers } from './cursorLine';
import { buildDecorationSet, buildInlineDecorationsForTest, collectInlineDecorationEntries, collectLinkLabelRanges, extractLinkUrl } from './inlineDecorations';

/**
 * TMS Markdown 付き EditorState を生成する
 * @param {string} doc ドキュメント
 * @returns {EditorState}
 */
function createMarkdownState(doc: string): EditorState {
	return EditorState.create({
		doc,
		extensions: [createTmsMarkdownSupport()],
	});
}

/**
 * 最初の Link ノードを取得する
 * @param {EditorState} state エディタ状態
 * @returns {import('@lezer/common').SyntaxNode | null}
 */
function findFirstLinkNode(state: EditorState) {
	let linkNode: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * Link ノードを探索する
		 * @param {{ name: string; node: import('@lezer/common').SyntaxNode }} ref ノード参照
		 * @returns {boolean | void}
		 */
		enter(ref) {
			if (ref.name === 'Link') {
				linkNode = ref.node;
				return false;
			}
		},
	});
	return linkNode;
}

describe('inlineDecorations', () => {
	it('extractLinkUrl は URL を取得する', () => {
		const state    = createMarkdownState('[label](https://example.com/path)');
		const linkNode = findFirstLinkNode(state);
		expect(linkNode).not.toBeNull();
		expect(extractLinkUrl(state, linkNode!)).toBe('https://example.com/path');
	});

	it('extractLinkUrl は URL なし Link で空文字を返す', () => {
		const state    = createMarkdownState('[label]');
		const linkNode = findFirstLinkNode(state);
		expect(linkNode).not.toBeNull();
		expect(extractLinkUrl(state, linkNode!)).toBe('');
	});

	it('collectLinkLabelRanges は標準リンクの表示文字範囲を返す', () => {
		const state    = createMarkdownState('[label](https://example.com/path)');
		const linkNode = findFirstLinkNode(state);
		const ranges   = collectLinkLabelRanges(linkNode!);

		expect(ranges.map((range) => state.doc.sliceString(range.from, range.to))).toEqual(['label']);
	});

	it('複数行 Markdown でも DecorationSet を構築できる', () => {
		const state = createMarkdownState('**line1**\n*line2*\n~~line3~~\n==hi==\n[[page]]');
		expect(() => buildInlineDecorationsForTest(state)).not.toThrow();
	});

	it('プレビュー行のインラインコードは CodeMark を隠し内容を装飾する', () => {
		const doc           = ['line1', 'prefix `{java} private String fileId1 = "Hoge";` suffix'].join('\n');
		const state         = EditorState.create({
			doc,
			selection : { anchor: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines   = collectSourceLineNumbers(state);
		const entries       = collectInlineDecorationEntries(state, sourceLines);
		const hiddenMarks   = entries.filter((entry) => (
			state.doc.sliceString(entry.from, entry.to) === '`'
		));
		const hiddenLang    = entries.find((entry) => (
			state.doc.sliceString(entry.from, entry.to) === '{java} '
		));
		const styledContent = entries.find((entry) => (
			entry.decoration.spec.class === 'cm-md-code'
			&& state.doc.sliceString(entry.from, entry.to) === '{java} private String fileId1 = "Hoge";'
		));

		expect(sourceLines).toEqual(new Set([1]));
		expect(hiddenMarks.length).toBe(2);
		expect(hiddenLang).toBeDefined();
		expect(styledContent).toBeDefined();
	});

	it('プレビュー行の `{java}` は直後スペースなしでも言語接頭辞を隠す', () => {
		const doc        = ['line1', 'x `{java}String a = b;` y'].join('\n');
		const state      = EditorState.create({
			doc,
			selection : { anchor: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries    = collectInlineDecorationEntries(state);
		const hiddenLang = entries.find((entry) => (
			state.doc.sliceString(entry.from, entry.to) === '{java}'
		));
		const styled     = entries.find((entry) => (
			entry.decoration.spec.class === 'cm-md-code'
			&& state.doc.sliceString(entry.from, entry.to) === '{java}String a = b;'
		));

		expect(hiddenLang).toBeDefined();
		expect(styled).toBeDefined();
	});

	it('プレビュー行は `{lang}` 直後の空白だけを隠し、接頭辞なしの先頭空白は残す', () => {
		const withLang    = EditorState.create({
			doc       : 'x\n`{javascript}   const a = b;`',
			selection : { anchor: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const withoutLang = EditorState.create({
			doc       : 'x\n`   const a = b;`',
			selection : { anchor: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const hiddenLang  = collectInlineDecorationEntries(withLang).find((entry) => (
			withLang.doc.sliceString(entry.from, entry.to) === '{javascript}   '
		));
		const hiddenLead  = collectInlineDecorationEntries(withoutLang).find((entry) => (
			withoutLang.doc.sliceString(entry.from, entry.to) === '   '
		));
		const styledLead  = collectInlineDecorationEntries(withoutLang).find((entry) => (
			entry.decoration.spec.class === 'cm-md-code'
			&& withoutLang.doc.sliceString(entry.from, entry.to) === '   const a = b;'
		));

		expect(hiddenLang).toBeDefined();
		expect(hiddenLead).toBeUndefined();
		expect(styledLead).toBeDefined();
	});

	it('未知言語の `{notalang}` は接頭辞を隠さない', () => {
		const doc     = ['line1', 'x `{notalang}String a;` y'].join('\n');
		const state   = EditorState.create({
			doc,
			selection : { anchor: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries = collectInlineDecorationEntries(state);
		const hidden  = entries.find((entry) => (
			state.doc.sliceString(entry.from, entry.to) === '{notalang}'
		));

		expect(hidden).toBeUndefined();
	});

	it('プレビュー行の標準リンクは記号を隠し表示文字をリンク装飾する', () => {
		const state       = EditorState.create({
			doc       : 'x\nリンク：[りんく](https://tm-systems.jp/)',
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		const linkText    = entries.find((entry) => (
			entry.decoration.spec.class === 'cm-md-link'
			&& state.doc.sliceString(entry.from, entry.to) === 'りんく'
		));

		expect(linkText?.decoration.spec.attributes).toEqual({ 'data-href': 'https://tm-systems.jp/' });
	});

	it('プレビュー行のリンク表示文字列内インラインコードは両方を装飾する', () => {
		const state       = EditorState.create({
			doc       : 'x\n* [`3c78a7b`](https://github.com/eslint/eslint/commit/3c78a7bff6044fd196ae3b737983e6744c6eb7c8) Chore',
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		const hiddenMarks = entries.filter((entry) => (
			entry.decoration.spec.class === undefined
			&& state.doc.sliceString(entry.from, entry.to) === '`'
		));
		const code        = entries.find((entry) => (
			entry.decoration.spec.class === 'cm-md-code'
			&& state.doc.sliceString(entry.from, entry.to) === '3c78a7b'
		));
		const link        = entries.find((entry) => (
			entry.decoration.spec.class === 'cm-md-link'
			&& state.doc.sliceString(entry.from, entry.to) === '`3c78a7b`'
		));

		expect(hiddenMarks.length).toBe(2);
		expect(code).toBeDefined();
		expect(link?.decoration.spec.attributes).toEqual({
			'data-href': 'https://github.com/eslint/eslint/commit/3c78a7bff6044fd196ae3b737983e6744c6eb7c8',
		});
		expect(() => buildDecorationSet(entries)).not.toThrow();
	});

	it('カーソルがインラインコード内にあるときは記法を表示しコード装飾は全体を囲む', () => {
		const doc     = 'prefix `{java} private String fileId1 = "Hoge";` suffix';
		const inline  = '`{java} private String fileId1 = "Hoge";`';
		const state   = EditorState.create({
			doc,
			selection : { anchor: doc.indexOf('{') },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries = collectInlineDecorationEntries(state);
		const hidden  = entries.filter((entry) => (
			state.doc.sliceString(entry.from, entry.to) === '`'
			|| state.doc.sliceString(entry.from, entry.to) === '{java}'
		));
		const styled  = entries.find((entry) => (
			entry.decoration.spec.class === 'cm-md-code'
			&& state.doc.sliceString(entry.from, entry.to) === inline
		));

		expect(hidden.length).toBe(0);
		expect(styled).toBeDefined();
	});

	it('同じ行でもカーソル外のインライン構文はプレビューを維持する', () => {
		const doc     = '先頭 **太字** 中間 `code` 末尾 [リンク](https://example.com/long/path)';
		const state   = EditorState.create({
			doc,
			selection : { anchor: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strong')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-code')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-link')).toBe(true);
	});

	it('カーソルがインラインコード内でも同じ行の他要素はプレビューを維持する', () => {
		const doc     = '先頭 **太字** 中間 `code` 末尾 [リンク](https://example.com/long/path)';
		const state   = EditorState.create({
			doc,
			selection : { anchor: doc.indexOf('code') + 1 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strong')).toBe(true);
		expect(entries.some((entry) => (
			entry.decoration.spec.class === 'cm-md-code'
			&& state.doc.sliceString(entry.from, entry.to) === '`code`'
		))).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-link')).toBe(true);
	});

	it('カーソルと交差する要素だけソース表示し、同じ行の別要素はプレビューを維持する', () => {
		const doc     = '先頭 **太字** 中間 `code` 末尾 [リンク](https://example.com/long/path)';
		const state   = EditorState.create({
			doc,
			selection : { anchor: doc.indexOf('太字') + 1 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strong')).toBe(false);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-code')).toBe(true);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-link')).toBe(true);
	});

	it('複数行選択と交差する複数要素だけソース表示する', () => {
		const doc     = '**太字**\n通常\n*斜体* と ~~取消~~';
		const state   = EditorState.create({
			doc,
			selection : { anchor: doc.indexOf('太字'), head: doc.indexOf('斜体') + 1 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strong')).toBe(false);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-em')).toBe(false);
		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-strike')).toBe(true);
	});

	it('リンク内コードのカーソルでは親リンクはソース表示し内側コードは記法付きで装飾する', () => {
		const doc     = '[`3c78a7b`](https://example.com/very/long/url) と `別コード`';
		const state   = EditorState.create({
			doc,
			selection : { anchor: doc.indexOf('3c78a7b') + 1 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries = collectInlineDecorationEntries(state);

		expect(entries.some((entry) => entry.decoration.spec.class === 'cm-md-link')).toBe(false);
		expect(entries.some((entry) => (
			entry.decoration.spec.class === 'cm-md-code'
			&& state.doc.sliceString(entry.from, entry.to) === '`3c78a7b`'
		))).toBe(true);
		expect(entries.some((entry) => (
			entry.decoration.spec.class === 'cm-md-code'
			&& state.doc.sliceString(entry.from, entry.to) === '別コード'
		))).toBe(true);
	});

	it('プレビュー行の ==ハイライト== は記号を隠し内容を装飾する', () => {
		const state       = EditorState.create({
			doc       : 'x\nsee ==marked== here',
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		const marks       = entries.filter((entry) => (
			state.doc.sliceString(entry.from, entry.to) === '=='
		));
		const content     = entries.find((entry) => (
			entry.decoration.spec.class === 'cm-md-highlight'
			&& state.doc.sliceString(entry.from, entry.to) === 'marked'
		));

		expect(marks.length).toBe(2);
		expect(content).toBeDefined();
	});

	it('プレビュー行の [[内部リンク]] は括弧を隠しリンク風に装飾する', () => {
		const state       = EditorState.create({
			doc       : 'x\ngo [[Page Name]] now',
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectInlineDecorationEntries(state, sourceLines);
		const brackets    = entries.filter((entry) => {
			const text = state.doc.sliceString(entry.from, entry.to);
			return text === '[[' || text === ']]';
		});
		const page = entries.find((entry) => (
			entry.decoration.spec.class === 'cm-md-wikilink'
			&& state.doc.sliceString(entry.from, entry.to) === 'Page Name'
		));

		expect(brackets.length).toBe(2);
		expect(page).toBeDefined();
	});
});
