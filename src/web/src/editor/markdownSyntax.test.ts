/**
 * 独自記法のノード名と、コールアウト種別の正規化を検証する
 * 描画は持たず、構文木のノード名と関数の戻り値だけを見る
 * @file
 */
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from './createTmsMarkdown';
import { foldDefaultFromMark, normalizeCalloutType } from './markdownSyntax';

/**
 * TMS の Markdown サポートを有効にした EditorState を作る
 * @param doc - 構文木を作る Markdown 本文
 * @returns 言語サポートだけを付けた状態
 */
function createState(doc: string): EditorState {
	return EditorState.create({
		// 構文木を作る本文。選択は先頭
		doc,
		// 独自記法のノードを得る Markdown サポート
		extensions: [createTmsMarkdownSupport()]
	});
}

/**
 * 構文木に含まれるノード名を、出現順に返す
 * @param state - 走査する状態
 * @returns ノード名の配列。同じ名前が複数回出ることがある
 */
function collectNodeNames(state: EditorState): string[] {
	// 出現順のノード名。同じ名前が複数回入ることがある
	const names: string[] = [];
	syntaxTree(state).iterate({
		/**
		 * ノード名を出現順に集める。子も続ける
		 * @param node - 走査中のノード
		 * @param node.name - Lezer のノード名
		 */
		enter(node) {
			// 子も含めて、見たノード名を順に積む
			names.push(node.name);
		}
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
		// == で囲んだ断片を含む構文木のノード名
		const names = collectNodeNames(createState('see ==marked== text'));
		expect(names).toContain('Highlight');
		expect(names).toContain('HighlightMark');
	});

	it('文書先頭の YAML フロントマターを専用ブロックとしてパースする', () => {
		// 先頭の --- が水平線や Setext にならない文書のノード名
		const names = collectNodeNames(createState(['---', 'fileClass: 問題点一覧管理票FileClass', 'プロジェクト名: TMS-MDEditor', '---', '', '# 本文'].join('\n')));

		expect(names).toContain('YamlFrontMatter');
		expect(names).toContain('YamlFrontMatterMark');
		expect(names).toContain('YamlFrontMatterContent');
		expect(names).not.toContain('HorizontalRule');
		expect(names).not.toContain('SetextHeading1');
		expect(names).not.toContain('SetextHeading2');
	});

	it('[[内部リンク]] を WikiLink ノードとしてパースする', () => {
		// 内部リンクを 1 つ含む文書
		const state = createState('go [[Page Name]] now');
		// その構文木のノード名。ページ名と括弧が別ノードになる
		const names = collectNodeNames(state);
		expect(names).toContain('WikiLink');
		expect(names).toContain('WikiLinkPage');
		expect(names).toContain('WikiLinkMark');
	});

	it('![[embed.png]] を WikiEmbed ノードとしてパースする', () => {
		// 埋め込み記法のノード名。通常の画像ノードにはしない
		const names = collectNodeNames(createState('see ![[embed.png]] here'));
		expect(names).toContain('WikiEmbed');
		expect(names).toContain('WikiEmbedPath');
		expect(names).toContain('WikiEmbedMark');
		expect(names).not.toContain('Image');
	});

	it('コールアウトの [!type] を CalloutMark としてパースする', () => {
		// 引用の中にコールアウト種別がある文書
		const state = createState('> [!warning] Be careful');
		// そのノード名。種別と引用が両方出る
		const names = collectNodeNames(state);
		expect(names).toContain('CalloutMark');
		expect(names).toContain('CalloutType');
		expect(names).toContain('Blockquote');
	});

	it('[!info]- は折りたたみ記号を含めてパースする', () => {
		// 折りたたみ記号 - 付きのコールアウト
		const state = createState('> [!info]- title');
		// そのノード名。折りたたみ記号が別ノードになる
		const names = collectNodeNames(state);
		expect(names).toContain('CalloutFoldMark');
		expect(foldDefaultFromMark('-')).toBe('collapsed');
		expect(foldDefaultFromMark('+')).toBe('expanded');
		expect(foldDefaultFromMark(undefined)).toBe('none');

		// CalloutMark の文字列。見つからなければ空のまま
		let foldText = '';
		syntaxTree(state).iterate({
			/**
			 * CalloutMark の本文を控える
			 * @param node - 走査中のノード
			 * @param node.name - Lezer のノード名。CalloutMark のときだけ本文を控える
			 * @param node.from - ノード先頭の文書オフセット（含む）
			 * @param node.to - ノード末尾の文書オフセット（含まない）
			 */
			enter(node) {
				// コールアウト印のノードだけ本文を控える。種別ノードは含めない
				if (node.name === 'CalloutMark') {
					// 印全体。折りたたみ記号 - まで含む
					foldText = state.doc.sliceString(node.from, node.to);
				}
			}
		});
		expect(foldText).toBe('[!info]-');
	});

	it('コールアウト内のフェンスコードを FencedCode としてパースする', () => {
		// バッククォート 3 つ。ソース上のフェンスとテンプレートが衝突しないように作る
		const fence = String.fromCharCode(96, 96, 96);
		// コールアウトの中にフェンスがある文書
		const state = createState(['> [!info]- info', `> ${fence}`, '> hello', `> ${fence}`].join('\n'));
		// そのノード名。引用の中でもフェンスとして残る
		const names = collectNodeNames(state);
		expect(names).toContain('FencedCode');
		expect(names).toContain('CodeText');
	});
});
