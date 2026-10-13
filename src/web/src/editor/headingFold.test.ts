import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from './createTmsMarkdown';
import {
	collectHeadingFoldRanges,
	getCollapsedHeadingFroms,
	revealHeadingInCollapsedHeadings,
	revealSelectionInCollapsedHeadings,
	restoreCollapsedHeadings,
} from './headingFold';
import { codeFolding, foldEffect } from '@codemirror/language';

/** テスト用Markdown EditorStateを作る。 */
function state(doc: string): EditorState {
	return EditorState.create({ doc, extensions: [createTmsMarkdownSupport(), codeFolding()] });
}

describe('headingFold', () => {
	it('ATX見出しを同じレベルまたは上位レベルの直前まで折りたたむ', () => {
		const editorState = state('# H1\n本文\n## H2\n子本文\n# H1b\n末尾');
		const ranges      = collectHeadingFoldRanges(editorState);

		expect(ranges.map((range) => ({
			level: range.level,
			text : editorState.sliceDoc(range.from, range.to),
		}))).toEqual([
			{ level: 1, text: '\n本文\n## H2\n子本文' },
			{ level: 2, text: '\n子本文' },
			{ level: 1, text: '\n末尾' },
		]);
	});

	it('Setext見出しを対象にし、本文のない見出しは除外する', () => {
		const editorState = state('タイトル\n=====\n本文\n\n# 空\n# 次\n本文2');
		const ranges      = collectHeadingFoldRanges(editorState);

		expect(ranges).toHaveLength(2);
		expect(ranges[0].level).toBe(1);
		expect(editorState.sliceDoc(ranges[0].from, ranges[0].to)).toContain('本文');
		expect(editorState.sliceDoc(ranges[1].from, ranges[1].to)).toBe('\n本文2');
	});

	it('コードブロック内の#を見出しとして扱わない', () => {
		const editorState = state('~~~md\n# code\n~~~\n\n## real\nbody');
		const ranges      = collectHeadingFoldRanges(editorState);

		expect(ranges).toHaveLength(1);
		expect(ranges[0].level).toBe(2);
	});

	it('保存位置が現在の見出しと一致する場合だけ復元する', () => {
		let editorState = state('# A\nbody\n## B\nchild');
		const ranges    = collectHeadingFoldRanges(editorState);
		editorState     = restoreCollapsedHeadings(editorState, [ranges[1].headingFrom, 9999]);

		expect(getCollapsedHeadingFroms(editorState)).toEqual([ranges[1].headingFrom]);
	});

	it('折りたたみ範囲内にキャレットがある場合は復元しない', () => {
		let editorState = state('# A\nbody');
		const range     = collectHeadingFoldRanges(editorState)[0];
		editorState     = EditorState.create({
			doc       : editorState.doc,
			selection : { anchor: range.from + 1 },
			extensions: [createTmsMarkdownSupport(), codeFolding()],
		});

		expect(getCollapsedHeadingFroms(restoreCollapsedHeadings(editorState, [range.headingFrom]))).toEqual([]);
	});

	it('折りたたみ中の見出し位置を列挙する', () => {
		let editorState = state('# A\nbody\n## B\nchild');
		const ranges    = collectHeadingFoldRanges(editorState);
		editorState     = editorState.update({
			effects: ranges.map((range) => foldEffect.of({ from: range.from, to: range.to })),
		}).state;

		expect(getCollapsedHeadingFroms(editorState)).toEqual(ranges.map((range) => range.headingFrom));
	});

	it('移動先を隠している親見出しを自動展開する', () => {
		let editorState = state('# A\nbody\n## B\nchild');
		const ranges    = collectHeadingFoldRanges(editorState);
		editorState     = editorState.update({
			effects: ranges.map((range) => foldEffect.of({ from: range.from, to: range.to })),
		}).state;
		editorState     = editorState.update({ selection: { anchor: editorState.doc.length } }).state;

		expect(getCollapsedHeadingFroms(revealSelectionInCollapsedHeadings(editorState))).toEqual([]);
	});

	it('アウトライン移動では対象見出し自身と親見出しを展開する', () => {
		let editorState = state('# A\nbody\n## B\nchild\n### C\nleaf');
		const ranges    = collectHeadingFoldRanges(editorState);
		editorState     = editorState.update({
			effects: ranges.map((range) => foldEffect.of({ from: range.from, to: range.to })),
		}).state;

		const revealed = revealHeadingInCollapsedHeadings(editorState, ranges[1].headingFrom);

		expect(getCollapsedHeadingFroms(revealed)).toEqual([ranges[2].headingFrom]);
	});

	it('表示範囲外を含む長い文書でも全見出しを列挙する', () => {
		const markdown    = Array.from({ length: 600 }, (_, index) => `## H${index}\n本文${index}`).join('\n');
		const editorState = state(markdown);
		const ranges      = collectHeadingFoldRanges(editorState);

		expect(ranges).toHaveLength(600);
		expect(ranges.at(-1)?.headingFrom).toBe(markdown.lastIndexOf('## H599'));
	});
});
