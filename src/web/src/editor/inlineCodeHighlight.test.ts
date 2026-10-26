/**
 * インラインコードとフェンスのトークン色が、言語ロード後に付くことを検証する
 * 画面は持たず、構文木と Decoration の範囲だけを見る
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { collectCodeHighlightRanges } from './codeHighlight';
import { resolveCodeLanguage } from './codeLanguage';
import { createTmsMarkdownSupport } from './createTmsMarkdown';
import { collectInlineCodeHighlightEntries } from './inlineCodeHighlight';
import { tmsHighlightStyle } from './markdownHighlightStyle';

/**
 * TMS の Markdown サポートを有効にした EditorState を作る
 * @param doc - 構文木を作る Markdown 本文
 * @returns 言語サポートだけを付けた状態。選択は先頭
 */
function createState(doc: string): EditorState {
	return EditorState.create({
		// 構文木を作る本文。選択は先頭のまま
		doc,
		// トークン色を付ける Markdown サポート
		extensions: [createTmsMarkdownSupport()]
	});
}

describe('inlineCodeHighlight', () => {
	it('フェンス javascript は言語ロード後にトークン色が付く', async () => {
		// javascript の言語定義。未ロードだとトークン色は付かない
		const description = resolveCodeLanguage('javascript');
		expect(description).not.toBeNull();
		await description!.load();

		// const を含むフェンス。ロード後にトークンへ分かれる
		const doc                   = '```javascript\nconst x = 1;\n```';
		// その構文木。選択は先頭
		const state                 = createState(doc);
		// ハイライトが塗った断片。空のままなら色が付いていない
		const highlighted: string[] = [];
		highlightTree(syntaxTree(state), tmsHighlightStyle, (from, to) => {
			highlighted.push(state.doc.sliceString(from, to));
		});

		expect(highlighted.join(' ')).toContain('const');
	});

	it('インライン `{java}` はスペースなしでもトークン装飾を付ける', async () => {
		// java の言語定義。接頭辞の直後から本文になる
		const description = resolveCodeLanguage('java');
		expect(description).not.toBeNull();
		await description!.load();

		// 接頭辞と本文の間に空白が無いインラインコード
		const doc     = '`{java}String a = b;`';
		// その構文木
		const state   = createState(doc);
		// 文書全体のトークン装飾。接頭辞は範囲に入らない
		const entries = collectInlineCodeHighlightEntries(state, 0, state.doc.length);

		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.decoration.spec.class)).toBe(true);
		// 装飾範囲をつないだ本文。型名が見え、接頭辞は見えない
		const highlighted = entries.map((entry) => state.doc.sliceString(entry.from, entry.to)).join('');
		expect(highlighted).toContain('String');
		expect(state.doc.sliceString(entries[0]!.from, entries[0]!.to)).not.toContain('{java}');
	});

	it('インライン `{java}` 直後の空白はトークン装飾に含めない', async () => {
		// java の言語定義。接頭辞の後ろの空白を装飾に混ぜない
		const description = resolveCodeLanguage('java');
		expect(description).not.toBeNull();
		await description!.load();

		// 接頭辞の直後に空白が 3 つあるインラインコード
		const doc     = '`{java}   String a = b;`';
		// その構文木
		const state   = createState(doc);
		// 文書全体のトークン装飾
		const entries = collectInlineCodeHighlightEntries(state, 0, state.doc.length);
		// 各装飾の文字列。空白で始まるものがあれば失敗
		const texts   = entries.map((entry) => state.doc.sliceString(entry.from, entry.to));

		expect(entries.length).toBeGreaterThan(0);
		expect(texts.join('')).toContain('String');
		expect(texts.some((text) => text.startsWith(' '))).toBe(false);
	});

	it('未知言語のインライン接頭辞はハイライトしない', () => {
		// カタログに無い言語名。トークン装飾は空になる
		const state   = createState('`{notalang}String a = b;`');
		// 文書全体のトークン装飾。1 件も無いことを見る
		const entries = collectInlineCodeHighlightEntries(state, 0, state.doc.length);
		expect(entries).toEqual([]);
	});

	it('javascript パーサは const をトークン化する', async () => {
		// javascript の言語定義。パーサ単体で const が分かれる
		const description = resolveCodeLanguage('javascript');
		await description!.load();
		// ロード後の Lezer 言語。未設定なら範囲は取れない
		const language = description!.support?.language;
		expect(language).toBeDefined();
		// const を含む 1 文のトークン範囲。空ならパーサが分かっていない
		const ranges = collectCodeHighlightRanges('const x = 1;', language!);
		expect(ranges.length).toBeGreaterThan(0);
	});
});
