import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectHtmlDecorationEntries } from './htmlInline';
import {
	isAllowedHtmlTagName,
	parseHtmlTag,
	sanitizeClassValue,
	sanitizeHtmlAttributes,
	sanitizeStyleValue,
} from './htmlSanitizer';

/**
 * @param {string} doc ドキュメント
 * @param {number} [cursor] カーソル位置
 * @returns {EditorState}
 */
function createState(doc: string, cursor: number = 0): EditorState {
	return EditorState.create({
		doc,
		selection  : EditorSelection.cursor(cursor),
		extensions : [createTmsMarkdownSupport()],
	});
}

describe('htmlSanitizer', () => {
	it('許可タグのみ allowed になる', () => {
		expect(isAllowedHtmlTagName('u')).toBe(true);
		expect(isAllowedHtmlTagName('SPAN')).toBe(true);
		expect(isAllowedHtmlTagName('script')).toBe(false);
		expect(isAllowedHtmlTagName('tms-mark-error')).toBe(false);

		expect(parseHtmlTag('<u>')?.allowed).toBe(true);
		expect(parseHtmlTag('<script>')?.allowed).toBe(false);
		expect(parseHtmlTag('<br/>')?.kind).toBe('selfClosing');
		expect(parseHtmlTag('</span>')?.kind).toBe('close');
	});

	it('許可属性以外と javascript: を除去する', () => {
		const parsed = parseHtmlTag(
			'<span style="color:red; expression(alert(1))" class="ok bad!" onclick="x" href="javascript:alert(1)">',
		);
		expect(parsed).not.toBeNull();
		const sanitized = sanitizeHtmlAttributes(parsed!.attributes);
		expect(sanitized.style).toBe('color:red');
		expect(sanitized.className).toBe('ok');
		expect(Object.keys(parsed!.attributes)).toEqual(
			expect.arrayContaining(['style', 'class', 'onclick', 'href']),
		);
	});

	it('sanitizeStyleValue は危険な記述を落とす', () => {
		expect(sanitizeStyleValue('color: red; background: url(javascript:alert(1))')).toBe('color: red');
		expect(sanitizeStyleValue('behavior: url(x); font-weight: bold')).toBe('font-weight: bold');
		expect(sanitizeStyleValue('color: expression(alert(1))')).toBe('');
	});

	it('sanitizeClassValue は安全なトークンのみ残す', () => {
		expect(sanitizeClassValue('foo bar')).toBe('foo bar');
		expect(sanitizeClassValue('foo"onclick=x')).toBe('');
		expect(sanitizeClassValue('a-b_c')).toBe('a-b_c');
	});
});

describe('htmlInline', () => {
	it('許可タグのマークアップを隠し、内容に mark を付ける', () => {
		const doc     = 'hello <u>world</u> end\n\ncursor';
		const state   = createState(doc, doc.length - 1);
		const entries = collectHtmlDecorationEntries(state);

		expect(entries.some((entry) => state.doc.sliceString(entry.from, entry.to) === '<u>')).toBe(true);
		expect(entries.some((entry) => state.doc.sliceString(entry.from, entry.to) === '</u>')).toBe(true);

		const marks = entries.filter((entry) => entry.decoration.spec.tagName === 'u');
		expect(marks).toHaveLength(1);
		expect(state.doc.sliceString(marks[0]!.from, marks[0]!.to)).toBe('world');
	});

	it('br は改行 widget にする', () => {
		const doc     = 'a<br>b\n\ncursor';
		const state   = createState(doc, doc.length - 1);
		const entries = collectHtmlDecorationEntries(state);
		expect(entries).toHaveLength(1);
		expect(state.doc.sliceString(entries[0]!.from, entries[0]!.to)).toBe('<br>');
		expect(entries[0]!.decoration.spec.widget).toBeDefined();
	});

	it('非許可タグは装飾しない（ソースのまま）', () => {
		const doc     = 'a <script>x</script> b\n\ncursor';
		const state   = createState(doc, doc.length - 1);
		const entries = collectHtmlDecorationEntries(state);
		expect(entries).toHaveLength(0);
	});

	it('onclick 等は落とし、style/class のみ mark に載せる', () => {
		const doc     = 'a <span style="color:red" class="note" onclick="evil()">x</span> b\n\ncursor';
		const state   = createState(doc, doc.length - 1);
		const entries = collectHtmlDecorationEntries(state);
		const mark    = entries.find((entry) => entry.decoration.spec.tagName === 'span');
		expect(mark).toBeDefined();
		expect(mark!.decoration.spec.attributes?.style).toBe('color:red');
		expect(mark!.decoration.spec.class).toContain('note');
		expect(mark!.decoration.spec.attributes?.onclick).toBeUndefined();
	});

	it('インラインコード内の br は対象外', () => {
		const doc     = 'hello<br>world and `code<br>here`\n\ncursor';
		const state   = createState(doc, doc.length - 1);
		const entries = collectHtmlDecorationEntries(state);
		expect(entries).toHaveLength(1);
		expect(state.doc.sliceString(entries[0]!.from, entries[0]!.to)).toBe('<br>');
	});

	it('ネストした許可タグを処理する', () => {
		const doc     = 'a <u>one <b>two</b> three</u> b\n\ncursor';
		const state   = createState(doc, doc.length - 1);
		const entries = collectHtmlDecorationEntries(state);
		const tags    = entries
			.filter((entry) => typeof entry.decoration.spec.tagName === 'string')
			.map((entry) => entry.decoration.spec.tagName);
		expect(tags).toContain('u');
		expect(tags).toContain('b');
	});
});
