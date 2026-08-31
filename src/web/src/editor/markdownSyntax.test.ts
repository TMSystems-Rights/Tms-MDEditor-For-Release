import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from './createTmsMarkdown';
import { foldDefaultFromMark, normalizeCalloutType } from './markdownSyntax';

/**
 * TMS Markdown 拡張付き EditorState を生成する
 * @param {string} doc ドキュメント
 * @returns {EditorState}
 */
function createState(doc: string): EditorState {
	return EditorState.create({
		doc,
		extensions: [createTmsMarkdownSupport()],
	});
}

/**
 * 構文木に含まれるノード名一覧を返す
 * @param {EditorState} state 状態
 * @returns {string[]}
 */
function collectNodeNames(state: EditorState): string[] {
	const names: string[] = [];
	syntaxTree(state).iterate({
		/**
		 * @param {{ name: string }} node ノード
		 * @returns {void}
		 */
		enter(node) {
			names.push(node.name);
		},
	});
	return names;
}

describe('markdownSyntax', () => {
	it('normalizeCalloutType は別名を正規化し未知は note にする', () => {
		expect(normalizeCalloutType('warning')).toBe('warning');
		expect(normalizeCalloutType('TIP')).toBe('tip');
		expect(normalizeCalloutType('done')).toBe('success');
		expect(normalizeCalloutType('check')).toBe('success');
		expect(normalizeCalloutType('summary')).toBe('abstract');
		expect(normalizeCalloutType('unknown')).toBe('note');
	});

	it('==ハイライト== を Highlight ノードとしてパースする', () => {
		const names = collectNodeNames(createState('see ==marked== text'));
		expect(names).toContain('Highlight');
		expect(names).toContain('HighlightMark');
	});

	it('文書先頭の YAML フロントマターを専用ブロックとしてパースする', () => {
		const names = collectNodeNames(createState([
			'---',
			'fileClass: 問題点一覧管理票FileClass',
			'プロジェクト名: TMS-MDEditor',
			'---',
			'',
			'# 本文',
		].join('\n')));

		expect(names).toContain('YamlFrontMatter');
		expect(names).toContain('YamlFrontMatterMark');
		expect(names).toContain('YamlFrontMatterContent');
		expect(names).not.toContain('HorizontalRule');
		expect(names).not.toContain('SetextHeading1');
		expect(names).not.toContain('SetextHeading2');
	});

	it('[[内部リンク]] を WikiLink ノードとしてパースする', () => {
		const state = createState('go [[Page Name]] now');
		const names = collectNodeNames(state);
		expect(names).toContain('WikiLink');
		expect(names).toContain('WikiLinkPage');
		expect(names).toContain('WikiLinkMark');
	});

	it('![[embed.png]] を WikiEmbed ノードとしてパースする', () => {
		const names = collectNodeNames(createState('see ![[embed.png]] here'));
		expect(names).toContain('WikiEmbed');
		expect(names).toContain('WikiEmbedPath');
		expect(names).toContain('WikiEmbedMark');
		expect(names).not.toContain('Image');
	});

	it('コールアウトの [!type] を CalloutMark としてパースする', () => {
		const state = createState('> [!warning] Be careful');
		const names = collectNodeNames(state);
		expect(names).toContain('CalloutMark');
		expect(names).toContain('CalloutType');
		expect(names).toContain('Blockquote');
	});

	it('[!info]- は折りたたみ記号を含めてパースする', () => {
		const state = createState('> [!info]- title');
		const names = collectNodeNames(state);
		expect(names).toContain('CalloutFoldMark');
		expect(foldDefaultFromMark('-')).toBe('collapsed');
		expect(foldDefaultFromMark('+')).toBe('expanded');
		expect(foldDefaultFromMark(undefined)).toBe('none');

		let foldText = '';
		syntaxTree(state).iterate({
			/**
			 * @param {{ name: string; from: number; to: number }} node ノード
			 * @returns {void}
			 */
			enter(node) {
				if (node.name === 'CalloutMark') {
					foldText = state.doc.sliceString(node.from, node.to);
				}
			},
		});
		expect(foldText).toBe('[!info]-');
	});

	it('コールアウト内のフェンスコードを FencedCode としてパースする', () => {
		const fence = String.fromCharCode(96, 96, 96);
		const state = createState([
			'> [!info]- info',
			`> ${fence}`,
			'> hello',
			`> ${fence}`,
		].join('\n'));
		const names = collectNodeNames(state);
		expect(names).toContain('FencedCode');
		expect(names).toContain('CodeText');
	});
});
