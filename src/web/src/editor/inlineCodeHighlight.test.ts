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
 * @param {string} doc ドキュメント
 * @returns {EditorState}
 */
function createState(doc: string): EditorState {
	return EditorState.create({
		doc,
		extensions: [createTmsMarkdownSupport()],
	});
}

describe('inlineCodeHighlight', () => {
	it('フェンス javascript は言語ロード後にトークン色が付く', async () => {
		const description = resolveCodeLanguage('javascript');
		expect(description).not.toBeNull();
		await description!.load();

		const doc                   = '```javascript\nconst x = 1;\n```';
		const state                 = createState(doc);
		const highlighted: string[] = [];
		highlightTree(syntaxTree(state), tmsHighlightStyle, (from, to) => {
			highlighted.push(state.doc.sliceString(from, to));
		});

		expect(highlighted.join(' ')).toContain('const');
	});

	it('インライン `{java}` はスペースなしでもトークン装飾を付ける', async () => {
		const description = resolveCodeLanguage('java');
		expect(description).not.toBeNull();
		await description!.load();

		const doc     = '`{java}String a = b;`';
		const state   = createState(doc);
		const entries = collectInlineCodeHighlightEntries(state, 0, state.doc.length);

		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.decoration.spec.class)).toBe(true);
		const highlighted = entries
			.map((entry) => state.doc.sliceString(entry.from, entry.to))
			.join('');
		expect(highlighted).toContain('String');
		expect(state.doc.sliceString(entries[0]!.from, entries[0]!.to)).not.toContain('{java}');
	});

	it('インライン `{java}` 直後の空白はトークン装飾に含めない', async () => {
		const description = resolveCodeLanguage('java');
		expect(description).not.toBeNull();
		await description!.load();

		const doc     = '`{java}   String a = b;`';
		const state   = createState(doc);
		const entries = collectInlineCodeHighlightEntries(state, 0, state.doc.length);
		const texts   = entries.map((entry) => state.doc.sliceString(entry.from, entry.to));

		expect(entries.length).toBeGreaterThan(0);
		expect(texts.join('')).toContain('String');
		expect(texts.some((text) => text.startsWith(' '))).toBe(false);
	});

	it('未知言語のインライン接頭辞はハイライトしない', () => {
		const state   = createState('`{notalang}String a = b;`');
		const entries = collectInlineCodeHighlightEntries(state, 0, state.doc.length);
		expect(entries).toEqual([]);
	});

	it('javascript パーサは const をトークン化する', async () => {
		const description = resolveCodeLanguage('javascript');
		await description!.load();
		const language = description!.support?.language;
		expect(language).toBeDefined();
		const ranges = collectCodeHighlightRanges('const x = 1;', language!);
		expect(ranges.length).toBeGreaterThan(0);
	});
});
