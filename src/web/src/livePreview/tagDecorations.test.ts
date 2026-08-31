import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectSourceLineNumbers } from './cursorLine';
import { collectTagDecorationEntries } from './tagDecorations';

/**
 * タグ装飾された文字列を返す。
 * @param {string} doc Markdown
 * @param {number} [anchor=0] カーソル位置
 * @returns {string[]}
 */
function collectDecoratedTags(doc: string, anchor = 0): string[] {
	const state       = EditorState.create({
		doc,
		selection : { anchor },
		extensions: [createTmsMarkdownSupport()],
	});
	const sourceLines = collectSourceLineNumbers(state);

	return collectTagDecorationEntries(state, sourceLines).map((entry) => (
		state.doc.sliceString(entry.from, entry.to)
	));
}

describe('tagDecorations', () => {
	it('日本語・Unicode句読点・末尾スラッシュを含む階層タグを装飾する', () => {
		const doc = [
			'active',
			'#一般/TODO と #システム開発/030_開発環境構築/020_サーバ構築',
			'#一般/スタディ/入門（初心者）',
			'#一般/金融/',
			'#一般/金融/クレジットカード/Amex/セゾンコバルト・ビジネス',
		].join('\n');

		expect(collectDecoratedTags(doc)).toEqual([
			'#一般/TODO',
			'#システム開発/030_開発環境構築/020_サーバ構築',
			'#一般/スタディ/入門（初心者）',
			'#一般/金融/',
			'#一般/金融/クレジットカード/Amex/セゾンコバルト・ビジネス',
		]);
	});

	it('英数字・区切り記号・Unicode記号を含むタグを装飾する', () => {
		const doc = 'active\n#camelCase #snake_case #kebab-case #inbox/to-read #todo✅';

		expect(collectDecoratedTags(doc)).toEqual([
			'#camelCase',
			'#snake_case',
			'#kebab-case',
			'#inbox/to-read',
			'#todo✅',
		]);
	});

	it('数字だけ・先頭スラッシュ・見出し・単語途中・エスケープ済み候補は装飾しない', () => {
		const doc = 'active\n#1984\n#/child\n# Heading\ntext#tag\n\\#escaped';

		expect(collectDecoratedTags(doc)).toEqual([]);
	});

	it('インラインコード・フェンスコード・リンク先・YAML内は装飾しない', () => {
		const doc    = [
			'---',
			'tags: #frontmatter',
			'---',
			'active',
			'`#code` [label](#destination) #visible',
			'```text',
			'#fenced',
			'```',
		].join('\n');
		const anchor = doc.indexOf('active');

		expect(collectDecoratedTags(doc, anchor)).toEqual(['#visible']);
	});

	it('カーソルのあるソース表示行は装飾しない', () => {
		const doc    = '#source\n#preview';
		const anchor = doc.indexOf('#source');

		expect(collectDecoratedTags(doc, anchor)).toEqual(['#preview']);
	});
});
