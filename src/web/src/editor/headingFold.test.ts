/**
 * 見出しの折りたたみ範囲、復元、選択を隠す展開を検証する
 * 画面は持たず、EditorState の範囲と折りたたみ位置だけを見る
 * @file
 */
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from './createTmsMarkdown';
import { collectHeadingFoldRanges, getCollapsedHeadingFroms, revealHeadingInCollapsedHeadings, revealSelectionInCollapsedHeadings, restoreCollapsedHeadings } from './headingFold';
import { codeFolding, foldEffect } from '@codemirror/language';

/**
 * 見出し折りたたみを解釈できる EditorState を作る
 * @param doc - Markdown 本文
 * @returns TMS の Markdown サポートと codeFolding を付けた状態
 */
function state(doc: string): EditorState {
	return EditorState.create({
		// 折りたたみ範囲を取る本文
		doc,
		// 見出しの構文木と、折りたたみの状態フィールド
		extensions: [createTmsMarkdownSupport(), codeFolding()]
	});
}

describe('headingFold', () => {
	it('ATX見出しを同じレベルまたは上位レベルの直前まで折りたたむ', () => {
		// H1 の中に H2 があり、次の同レベル H1 で範囲が切れる文書
		const editorState = state('# H1\n本文\n## H2\n子本文\n# H1b\n末尾');
		// 見出しごとの折りたたみ範囲。見出し行自体は含まない
		const ranges      = collectHeadingFoldRanges(editorState);

		expect(
			// レベルと、折りたたみに入る本文だけを比べる
			ranges.map((range) => ({
				// 見出しレベル。1 が最上位で、同レベル以上の直前までが範囲
				level: range.level,
				// 見出し行を除いた折りたたみ本文
				text: editorState.sliceDoc(range.from, range.to)
			}))
		).toEqual([
			{
				// 最初の H1。中の H2 まで含む
				level: 1,
				// 次の H1 の直前まで
				text: '\n本文\n## H2\n子本文'
			},
			{
				// H2。親 H1 より手前で終わる
				level: 2,
				// H2 の本文だけ
				text: '\n子本文'
			},
			{
				// 2 つ目の H1。文書末尾まで
				level: 1,
				// 末尾の本文
				text: '\n末尾'
			}
		]);
	});

	it('Setext見出しを対象にし、本文のない見出しは除外する', () => {
		// Setext の直後に空見出しがある。本文の無い見出しは範囲に入らない
		const editorState = state('タイトル\n=====\n本文\n\n# 空\n# 次\n本文2');
		// 本文がある見出しだけ。空の `# 空` は欠ける
		const ranges      = collectHeadingFoldRanges(editorState);

		expect(ranges).toHaveLength(2);
		expect(ranges[0].level).toBe(1);
		expect(editorState.sliceDoc(ranges[0].from, ranges[0].to)).toContain('本文');
		expect(editorState.sliceDoc(ranges[1].from, ranges[1].to)).toBe('\n本文2');
	});

	it('コードブロック内の#を見出しとして扱わない', () => {
		// フェンス内の # は見出しにせず、外の ## だけを折りたたむ
		const editorState = state('~~~md\n# code\n~~~\n\n## real\nbody');
		// コード外の見出し。1 件だけになる
		const ranges      = collectHeadingFoldRanges(editorState);

		expect(ranges).toHaveLength(1);
		expect(ranges[0].level).toBe(2);
	});

	it('保存位置が現在の見出しと一致する場合だけ復元する', () => {
		// H1 と H2。保存位置が今の見出しと一致するかだけを見る
		let editorState = state('# A\nbody\n## B\nchild');
		// 復元候補にする見出し位置。2 件目が H2
		const ranges    = collectHeadingFoldRanges(editorState);
		// H2 の位置と、文書に無い 9999。一致した H2 だけが折りたたまれる
		editorState     = restoreCollapsedHeadings(editorState, [ranges[1].headingFrom, 9999]);

		expect(getCollapsedHeadingFroms(editorState)).toEqual([ranges[1].headingFrom]);
	});

	it('折りたたみ範囲内にキャレットがある場合は復元しない', () => {
		// 本文が折りたたみ範囲に入る 1 見出し
		let editorState = state('# A\nbody');
		// その折りたたみ範囲。キャレットを範囲内へ置く
		const range     = collectHeadingFoldRanges(editorState)[0];
		// 範囲の中にキャレットがある状態。復元しても折りたたまない
		editorState     = EditorState.create({
			// 本文は元のまま
			doc: editorState.doc,
			// 折りたたみ開始の 1 文字後ろ。範囲の内側
			selection: { anchor: range.from + 1 },
			// 見出し解釈と折りたたみフィールド
			extensions: [createTmsMarkdownSupport(), codeFolding()]
		});

		expect(getCollapsedHeadingFroms(restoreCollapsedHeadings(editorState, [range.headingFrom]))).toEqual([]);
	});

	it('折りたたみ中の見出し位置を列挙する', () => {
		// H1 と H2。両方を折りたたんだあとの位置を見る
		let editorState = state('# A\nbody\n## B\nchild');
		// 折りたたむ範囲。from と to を effect に渡す
		const ranges    = collectHeadingFoldRanges(editorState);
		// 全見出しを折りたたんだ状態
		editorState     = editorState.update({
			// 範囲ごとの折りたたみ。開始と終了が両方必要
			effects: ranges.map((range) =>
				foldEffect.of({
					// 折りたたみ開始。見出しの次
					from: range.from,
					// 折りたたみ終了。次の見出しの直前
					to: range.to
				})
			)
		}).state;

		expect(getCollapsedHeadingFroms(editorState)).toEqual(ranges.map((range) => range.headingFrom));
	});

	it('移動先を隠している親見出しを自動展開する', () => {
		// H1 の中に H2 がある。文書末尾は H2 の折りたたみの中
		let editorState = state('# A\nbody\n## B\nchild');
		// 両方を折りたたむ範囲
		const ranges    = collectHeadingFoldRanges(editorState);
		// 全見出しを折りたたんだ状態
		editorState     = editorState.update({
			// 範囲ごとの折りたたみ
			effects: ranges.map((range) =>
				foldEffect.of({
					// 折りたたみ開始。見出しの次
					from: range.from,
					// 折りたたみ終了。次の見出しの直前
					to: range.to
				})
			)
		}).state;
		// 文書末尾へキャレットを移す。隠している親を展開する対象
		editorState     = editorState.update({ selection: { anchor: editorState.doc.length } }).state;

		expect(getCollapsedHeadingFroms(revealSelectionInCollapsedHeadings(editorState))).toEqual([]);
	});

	it('アウトライン移動では対象見出し自身と親見出しを展開する', () => {
		// H1、H2、H3 の 3 段。H2 へ移動すると H2 と親だけ開く
		let editorState = state('# A\nbody\n## B\nchild\n### C\nleaf');
		// 3 段すべての折りたたみ範囲。1 件目が H2
		const ranges    = collectHeadingFoldRanges(editorState);
		// 全見出しを折りたたんだ状態
		editorState     = editorState.update({
			// 範囲ごとの折りたたみ
			effects: ranges.map((range) =>
				foldEffect.of({
					// 折りたたみ開始。見出しの次
					from: range.from,
					// 折りたたみ終了。次の見出しの直前
					to: range.to
				})
			)
		}).state;

		// H2 を移動先にしたあとの折りたたみ。H3 だけ残る
		const revealed = revealHeadingInCollapsedHeadings(editorState, ranges[1].headingFrom);

		expect(getCollapsedHeadingFroms(revealed)).toEqual([ranges[2].headingFrom]);
	});

	it('表示範囲外を含む長い文書でも全見出しを列挙する', () => {
		// 600 件の H2。画面外でも列挙が欠けると件数が合わない
		const markdown    = Array.from({ length: 600 }, (_, index) => `## H${index}\n本文${index}`).join('\n');
		// その全文。表示範囲の省略が起きても構文木は文書全体
		const editorState = state(markdown);
		// 列挙した折りたたみ範囲。件数が 600 であることを見る
		const ranges      = collectHeadingFoldRanges(editorState);

		expect(ranges).toHaveLength(600);
		expect(ranges.at(-1)?.headingFrom).toBe(markdown.lastIndexOf('## H599'));
	});
});
