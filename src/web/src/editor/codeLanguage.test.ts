import { describe, expect, it } from 'vitest';
import {
	collectInlineCodeContentRanges,
	extractCodeLanguageName,
	parseInlineCodeLanguagePrefix,
	resolveCodeLanguage,
	resolveFencedCodeLanguage,
} from './codeLanguage';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { createTmsMarkdownSupport } from './createTmsMarkdown';

/**
 * @param {string} doc ドキュメント
 * @returns {import('@lezer/common').SyntaxNode | null}
 */
function findInlineCode(doc: string) {
	const state                                          = EditorState.create({
		doc,
		extensions: [createTmsMarkdownSupport()],
	});
	let found: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * @param {{ name: string; node: import('@lezer/common').SyntaxNode }} ref ノード
		 * @returns {boolean | void}
		 */
		enter(ref) {
			if (ref.name === 'InlineCode') {
				found = ref.node;
				return false;
			}
		},
	});
	return { state, node: found };
}

describe('codeLanguage', () => {
	it('フェンス情報から先頭の言語名を取り出す', () => {
		expect(extractCodeLanguageName('javascript')).toBe('javascript');
		expect(extractCodeLanguageName('js title="app.js"')).toBe('js');
		expect(extractCodeLanguageName('  C#  ')).toBe('C#');
		expect(extractCodeLanguageName('')).toBe('');
	});

	it('インライン `{java}` は直後スペースなしでも解釈し、空白は prefixLength に含める', () => {
		expect(parseInlineCodeLanguagePrefix('{java}String a = b;')).toEqual({
			language    : 'java',
			prefixLength: 6,
		});
		expect(parseInlineCodeLanguagePrefix('{java} String a = b;')).toEqual({
			language    : 'java',
			prefixLength: 7,
		});
		expect(parseInlineCodeLanguagePrefix('{javascript}   const a = b;')).toEqual({
			language    : 'javascript',
			prefixLength: '{javascript}   '.length,
		});
		expect(parseInlineCodeLanguagePrefix('{java}\tcode')?.prefixLength).toBe(7);
		expect(parseInlineCodeLanguagePrefix('   const a = b;')).toBeNull();
		expect(parseInlineCodeLanguagePrefix('{c++}int x;')?.language).toBe('c++');
		expect(parseInlineCodeLanguagePrefix('{c#}var x;')?.language).toBe('c#');
		expect(parseInlineCodeLanguagePrefix('{ not}code')).toBeNull();
		expect(parseInlineCodeLanguagePrefix('java code')).toBeNull();
	});

	it('Java / JavaScript / C# / PowerShell をカタログから解決する', () => {
		expect(resolveCodeLanguage('java')?.name).toBe('Java');
		expect(resolveCodeLanguage('js')?.name).toBe('JavaScript');
		expect(resolveCodeLanguage('csharp')?.name).toBe('C#');
		expect(resolveCodeLanguage('cs')?.name).toBe('C#');
		expect(resolveCodeLanguage('c#')?.name).toBe('C#');
		expect(resolveCodeLanguage('powershell')?.name).toBe('PowerShell');
		expect(resolveCodeLanguage('mermaid')).toBeNull();
		expect(resolveCodeLanguage('not-a-lang-xyz')).toBeNull();
	});

	it('mermaid フェンスは入れ子言語にしない', () => {
		expect(resolveFencedCodeLanguage('mermaid')).toBeNull();
		expect(resolveFencedCodeLanguage('javascript')?.name).toBe('JavaScript');
	});

	it('InlineCode の本文範囲を返す', () => {
		const { state, node } = findInlineCode('x `{java}String a;` y');
		expect(node).not.toBeNull();
		const ranges = collectInlineCodeContentRanges(node!);
		expect(ranges).toHaveLength(1);
		expect(state.doc.sliceString(ranges[0]!.from, ranges[0]!.to)).toBe('{java}String a;');
	});
});
