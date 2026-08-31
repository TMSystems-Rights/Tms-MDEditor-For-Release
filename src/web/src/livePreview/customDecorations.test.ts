import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import {
	collectCustomDecorationEntries,
	collectCustomDecorationRangesFromText,
	compileCustomDecorationRules,
	createCustomDecorationsExtensions,
	isSafeCssClassName,
} from './customDecorations';
import { collectSourceLineNumbers } from './cursorLine';
import { viewModeField } from './livePreviewPlugin';

/**
 * @param {string} doc ドキュメント
 * @param {object} [options] オプション
 * @returns {EditorState}
 */
function createState(
	doc: string,
	options: {
		cursor?: number;
		rules?: ReturnType<typeof compileCustomDecorationRules>['rules'];
	} = {},
): EditorState {
	return EditorState.create({
		doc,
		selection  : EditorSelection.cursor(options.cursor ?? 0),
		extensions : [
			createTmsMarkdownSupport(),
			viewModeField.init(() => 'live-preview'),
			...createCustomDecorationsExtensions(options.rules ?? []),
		],
	});
}

describe('customDecorations', () => {
	it('isSafeCssClassName は安全なクラス名のみ許可する', () => {
		expect(isSafeCssClassName('tms-underline')).toBe(true);
		expect(isSafeCssClassName('_foo')).toBe(true);
		expect(isSafeCssClassName('a1')).toBe(true);
		expect(isSafeCssClassName('1bad')).toBe(false);
		expect(isSafeCssClassName('has space')).toBe(false);
		expect(isSafeCssClassName('a;alert(1)')).toBe(false);
	});

	it('不正な正規表現・cssClass は invalidNames に入りルールから除外する', () => {
		const result = compileCustomDecorationRules([
			{
				name     : 'ok',
				enabled  : true,
				pattern  : '_v(.+?)_v',
				cssClass : 'tms-underline',
			},
			{
				name     : 'bad-regex',
				pattern  : '(',
				cssClass : 'tms-underline',
			},
			{
				name     : 'bad-class',
				pattern  : 'x(y)z',
				cssClass : 'bad class',
			},
			{
				name     : 'disabled',
				enabled  : false,
				pattern  : 'a(b)c',
				cssClass : 'ok-class',
			},
		]);

		expect(result.rules.map((rule) => rule.name)).toEqual(['ok']);
		expect(result.invalidNames).toEqual(['bad-regex', 'bad-class']);
	});

	it('テキスト座標でキャプチャと区切りを返す', () => {
		const { rules } = compileCustomDecorationRules([
			{
				name           : '下線',
				pattern        : '_v(.+?)_v',
				hideDelimiters : true,
				cssClass       : 'tms-underline',
			},
		]);
		const ranges    = collectCustomDecorationRangesFromText('前 _v中_v 後', rules, 10);
		expect(ranges).toHaveLength(1);
		expect(ranges[0]).toMatchObject({
			fullFrom      : 12,
			from          : 14,
			to            : 15,
			fullTo        : 17,
			cssClass      : 'tms-underline',
			hideDelimiters: true,
		});
	});

	it('下線ルールでキャプチャ部分へ mark、デリミタを hide する', () => {
		const { rules } = compileCustomDecorationRules([
			{
				name           : '下線',
				pattern        : '_v(.+?)_v',
				hideDelimiters : true,
				cssClass       : 'tms-underline',
			},
		]);
		// カーソルは 1 行目。対象は 2 行目（プレビュー行）
		const state   = createState('cursor here\nhello _v装飾サンプル文字列_v end', { cursor: 0, rules });
		const entries = collectCustomDecorationEntries(state, collectSourceLineNumbers(state), rules);

		const marks = entries.filter((entry) => entry.decoration.spec.class === 'tms-underline');
		expect(marks).toHaveLength(1);
		expect(state.doc.sliceString(marks[0]!.from, marks[0]!.to)).toBe('装飾サンプル文字列');

		const hidden = entries.filter((entry) => entry.decoration.spec.class === undefined
			&& entry.to > entry.from);
		expect(hidden.length).toBeGreaterThanOrEqual(2);
		expect(hidden.filter((entry) => state.doc.sliceString(entry.from, entry.to) === '_v')).toHaveLength(2);
	});

	it('_v 区切りの対象が同一行に複数あっても個別に装飾する', () => {
		const { rules } = compileCustomDecorationRules([
			{
				name           : '下線',
				pattern        : '_v(.+?)_v',
				hideDelimiters : true,
				cssClass       : 'tms-underline',
			},
		]);
		const state     = createState('cursor here\n_v下線aa_v と _v下線bb_v', { cursor: 0, rules });
		const entries   = collectCustomDecorationEntries(state, collectSourceLineNumbers(state), rules);

		const marks = entries.filter((entry) => entry.decoration.spec.class === 'tms-underline');
		expect(marks.map((entry) => state.doc.sliceString(entry.from, entry.to))).toEqual([
			'下線aa',
			'下線bb',
		]);

		const hidden = entries.filter((entry) => entry.decoration.spec.class === undefined
			&& entry.to > entry.from);
		expect(hidden.filter((entry) => state.doc.sliceString(entry.from, entry.to) === '_v')).toHaveLength(4);
	});

	it('カーソル行ではカスタム装飾を適用しない', () => {
		const { rules } = compileCustomDecorationRules([
			{
				name           : '下線',
				pattern        : '_v(.+?)_v',
				hideDelimiters : true,
				cssClass       : 'tms-underline',
			},
		]);
		const doc       = 'hello _v下線aa_v end';
		const cursor    = doc.indexOf('下線aa');
		const state     = createState(doc, { cursor, rules });
		const entries   = collectCustomDecorationEntries(state, collectSourceLineNumbers(state), rules);
		expect(entries).toHaveLength(0);
	});

	it('Lezer ツリーが存在する状態でもコンパイル済みルールを読める', () => {
		const { rules } = compileCustomDecorationRules([
			{
				name     : 'mark-foo',
				pattern  : '\\b(foo)\\b',
				cssClass : 'tms-underline',
			},
		]);
		const state     = createState('cursor\nfoo bar foo', { cursor: 0, rules });
		expect(syntaxTree(state).type.name).toBeTruthy();
		const entries = collectCustomDecorationEntries(state);
		const marks   = entries.filter((entry) => entry.decoration.spec.class === 'tms-underline');
		expect(marks).toHaveLength(2);
	});
});
