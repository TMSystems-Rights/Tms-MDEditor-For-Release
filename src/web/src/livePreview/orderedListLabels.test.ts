/**
 * 番号付きリストの採番ルールで作るラベルと、キャレット位置による記号の出し分けを検証する
 * 描画 DOM は作らず、装飾エントリと純粋関数の結果だけを見る
 * @file
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import type { DecorationEntry } from './inlineDecorations';
import { collectLineDecorationEntries } from './lineDecorations';
import { DEFAULT_LIST_NUMBERING, estimateListLabelWidth, formatListNumberText, formatOrderedListMarker, listNumberingFacet, resolveListNumbering } from './orderedListLabels';

/**
 * 番号ラベルのウィジェットが持つ表示文字列を取り出すための形
 * 本番のウィジェットは非公開フィールドに label と widest を持つため、テストだけ型を緩めて読む
 */
type LabelWidgetLike = {
	/** 表示ラベル。番号ラベル以外のウィジェットでは undefined */
	label?: string;
	/** 兄弟で最も広いラベル。番号ラベル以外のウィジェットでは undefined */
	widest?: string;
};

/**
 * TMS Markdown と採番ルール付きの EditorState を作る
 * @param doc - 本文
 * @param head - キャレット位置。文書先頭からの文字数
 * @returns 構文木と採番ルールを持つ状態
 */
function createListState(doc: string, head: number): EditorState {
	return EditorState.create({
		// 装飾を取る本文
		doc,
		// 空の選択。キャレットだけ置く
		selection: EditorSelection.cursor(head),
		// リストのノードを得る Markdown サポートと、既定の採番ルール
		extensions: [createTmsMarkdownSupport(), listNumberingFacet.of(resolveListNumbering(null))]
	});
}

/**
 * 装飾エントリから、番号ラベルのウィジェットの表示文字列を順に取り出す
 * @param entries - 行装飾のエントリ
 * @returns ラベルの並び。文書位置の昇順
 */
function collectLabels(entries: DecorationEntry[]): string[] {
	return entries
		.filter((entry) => typeof (entry.decoration.spec.widget as LabelWidgetLike | undefined)?.label === 'string') // 番号ラベルのウィジェットだけ
		.sort((left, right) => left.from - right.from) // 文書の上から順に並べる
		.map((entry) => (entry.decoration.spec.widget as LabelWidgetLike).label as string);
}

describe('formatListNumberText', () => {
	it('カタカナは 41 字で繰り上がり、ン の次は アア になる', () => {
		expect(formatListNumberText('katakana', 1)).toBe('ア');
		expect(formatListNumberText('katakana', 38)).toBe('ヨ');
		expect(formatListNumberText('katakana', 41)).toBe('ン');
		expect(formatListNumberText('katakana', 42)).toBe('アア');
		expect(formatListNumberText('katakana', 82)).toBe('アン');
		expect(formatListNumberText('katakana', 83)).toBe('イア');
	});

	it('平仮名もカタカナと同じ並びで繰り上がる', () => {
		expect(formatListNumberText('hiragana', 6)).toBe('か');
		expect(formatListNumberText('hiragana', 40)).toBe('を');
		expect(formatListNumberText('hiragana', 42)).toBe('ああ');
	});

	it('英字は 26 字で繰り上がる', () => {
		expect(formatListNumberText('upper-alpha', 26)).toBe('Z');
		expect(formatListNumberText('upper-alpha', 27)).toBe('AA');
		expect(formatListNumberText('lower-alpha', 28)).toBe('ab');
	});

	it('丸数字は 3 区間をまたいで ㊿ まで表し、51 以上と 0 は表せない', () => {
		expect(formatListNumberText('circled', 1)).toBe('①');
		expect(formatListNumberText('circled', 20)).toBe('⑳');
		expect(formatListNumberText('circled', 21)).toBe('㉑');
		expect(formatListNumberText('circled', 35)).toBe('㉟');
		expect(formatListNumberText('circled', 36)).toBe('㊱');
		expect(formatListNumberText('circled', 50)).toBe('㊿');
		expect(formatListNumberText('circled', 51)).toBeNull();
		expect(formatListNumberText('circled', 0)).toBeNull();
	});

	it('ローマ数字は 1〜3999 だけを表す', () => {
		expect(formatListNumberText('lower-roman', 4)).toBe('iv');
		expect(formatListNumberText('lower-roman', 9)).toBe('ix');
		expect(formatListNumberText('upper-roman', 1994)).toBe('MCMXCIV');
		expect(formatListNumberText('upper-roman', 3999)).toBe('MMMCMXCIX');
		expect(formatListNumberText('upper-roman', 4000)).toBeNull();
		expect(formatListNumberText('lower-roman', 0)).toBeNull();
	});

	it('全角数字は各桁を全角にし、0 も表す', () => {
		expect(formatListNumberText('fullwidth-decimal', 10)).toBe('１０');
		expect(formatListNumberText('fullwidth-decimal', 0)).toBe('０');
	});

	it('カナと英字は 0 を表せない', () => {
		expect(formatListNumberText('katakana', 0)).toBeNull();
		expect(formatListNumberText('upper-alpha', 0)).toBeNull();
	});
});

describe('formatOrderedListMarker', () => {
	it('既定のルールで、第 1 から第 8 階層の番号 2 をラベルにする', () => {
		// 各階層での番号 2 のラベル
		const labels = [1, 2, 3, 4, 5, 6, 7, 8].map((depth) => formatOrderedListMarker('2.', depth, DEFAULT_LIST_NUMBERING));
		expect(labels).toEqual(['2.', '(2)', '②', '(イ)', '(い)', '(B)', '(b)', '(ii)']);
	});

	it('区切りが ) の記号も同じルールのラベルにする', () => {
		expect(formatOrderedListMarker('3)', 4, DEFAULT_LIST_NUMBERING)).toBe('(ウ)');
	});

	it('第 9 階層以降はソースの記号のまま返す', () => {
		expect(formatOrderedListMarker('2.', 9, DEFAULT_LIST_NUMBERING)).toBe('2.');
		expect(formatOrderedListMarker('2)', 12, DEFAULT_LIST_NUMBERING)).toBe('2)');
	});

	it('文字種で表せない番号はソースの記号のまま返す', () => {
		expect(formatOrderedListMarker('51.', 3, DEFAULT_LIST_NUMBERING)).toBe('51.');
		expect(formatOrderedListMarker('0.', 4, DEFAULT_LIST_NUMBERING)).toBe('0.');
	});

	it('全角括弧と全角数字を組み合わせられる', () => {
		// 第 1 階層だけ全角数字と全角括弧にしたルール
		const numbering = resolveListNumbering({
			// 第 1 階層。（１）の形
			level1: {
				// 全角数字
				kind: 'fullwidth-decimal',
				// 全角括弧
				enclosure: 'fullwidth-paren'
			}
		});
		expect(formatOrderedListMarker('1.', 1, numbering)).toBe('（１）');
	});
});

describe('resolveListNumbering', () => {
	it('欠けた階層と未知の値を、その階層の既定で埋める', () => {
		// 未知の文字種を持つ第 2 階層だけの保存値
		const resolved = resolveListNumbering({
			// 第 2 階層。文字種は未知、囲みは既知
			level2: {
				// 未知の文字種。既定の decimal へ戻る
				kind: 'greek' as never,
				// 既知の囲み。そのまま残る
				enclosure: 'none'
			}
		});
		expect(resolved.level2).toEqual({ kind: 'decimal', enclosure: 'none' });
		expect(resolved.level8).toEqual({ kind: 'lower-roman', enclosure: 'paren' });
	});
});

describe('リスト記号の装飾', () => {
	// 第 1〜第 4 階層の番号付きリスト。第 1 階層の `1.` もソースと同じ表記のウィジェットにする
	const nestedDoc = ['1. a', '2. b', '    1. c', '    2. d', '        1. e', '            1. f', '            2. g', '', 'end'].join('\n');
	// 4 行目 `    2. d` の行頭位置
	const line4     = nestedDoc.split('\n').slice(0, 3).join('\n').length + 1;

	it('階層ごとの採番ルールでラベルを出す', () => {
		// キャレットはリストの外。すべての記号をラベルにする
		const state = createListState(nestedDoc, nestedDoc.length);
		expect(collectLabels(collectLineDecorationEntries(state))).toEqual(['1.', '2.', '(1)', '(2)', '①', '(ア)', '(イ)']);
	});

	it('ラベルの幅は全角を 2、半角を 1 として見積もる', () => {
		expect(estimateListLabelWidth('(iii)')).toBe(5);
		expect(estimateListLabelWidth('(ア)')).toBe(4);
		expect(estimateListLabelWidth('（１）')).toBe(6);
		expect(estimateListLabelWidth('①')).toBe(2);
	});

	it('キャレットが行頭から記号の直後までにある項目だけ、ソースの数字のまま残す', () => {
		// 記号の直後（ピリオドの後ろ）のキャレット
		const atMark  = createListState(nestedDoc, line4 + 6);
		expect(collectLabels(collectLineDecorationEntries(atMark))).toEqual(['1.', '2.', '(1)', '①', '(ア)', '(イ)']);

		// 行頭のキャレット。インデントの前でも数字のまま
		const atStart = createListState(nestedDoc, line4);
		expect(collectLabels(collectLineDecorationEntries(atStart))).toEqual(['1.', '2.', '(1)', '①', '(ア)', '(イ)']);
	});

	it('キャレットが同じ行の本文にあるときは、ラベルを出したままにする', () => {
		// 本文の先頭（記号の後ろの空白の次）のキャレット
		const atBodyStart = createListState(nestedDoc, line4 + 7);
		expect(collectLabels(collectLineDecorationEntries(atBodyStart))).toEqual(['1.', '2.', '(1)', '(2)', '①', '(ア)', '(イ)']);

		// 本文の末尾のキャレット
		const atBodyEnd   = createListState(nestedDoc, line4 + 8);
		expect(collectLabels(collectLineDecorationEntries(atBodyEnd))).toEqual(['1.', '2.', '(1)', '(2)', '①', '(ア)', '(イ)']);
	});

	it('前の行を行末の改行まで選んだだけでは、次の行の記号をソースに戻さない', () => {
		// 3 行目の先頭から 4 行目の行頭までの範囲選択
		const state = EditorState.create({
			// 装飾を取る本文
			doc: nestedDoc,
			// 4 行目の行頭で終わる範囲選択
			selection: EditorSelection.range(line4 - 9, line4),
			// リストのノードを得る Markdown サポートと、既定の採番ルール
			extensions: [createTmsMarkdownSupport(), listNumberingFacet.of(resolveListNumbering(null))]
		});
		expect(collectLabels(collectLineDecorationEntries(state))).toEqual(['1.', '2.', '(2)', '①', '(ア)', '(イ)']);
	});

	it('キャレット行の箇条書きでも、本文にキャレットがあれば • に置き換える', () => {
		// 箇条書き 1 行。キャレットは本文の末尾
		const state   = createListState('- item', 6);
		// 記号 `-` の位置への replace
		const bullets = collectLineDecorationEntries(state).filter((entry) => entry.from === 0 && entry.to === 1 && entry.decoration.spec.widget);
		expect(bullets.length).toBe(1);
	});

	it('箇条書きの入れ子も階層に数える', () => {
		// 箇条書きの中の番号付き。番号付きは第 2 階層
		const doc   = ['- a', '    1. b', '', 'end'].join('\n');
		// キャレットはリストの外
		const state = createListState(doc, doc.length);
		expect(collectLabels(collectLineDecorationEntries(state))).toEqual(['(1)']);
	});

	it('引用とコールアウトの中のリストもラベルにする', () => {
		// 通常の引用と、コールアウト本文の入れ子の番号付きリスト
		const doc   = ['> 1. a', '>     1. b', '', '> [!note] title', '> 1. c', '>     2. d', '', 'end'].join('\n');
		// キャレットは引用の外
		const state = createListState(doc, doc.length);
		expect(collectLabels(collectLineDecorationEntries(state))).toEqual(['1.', '(1)', '1.', '(2)']);
	});

	it('兄弟で最も広いラベルを各項目のウィジェットに持たせ、幅をそろえる', () => {
		// 第 8 階層の 4 項目。(iii) が最も広い
		const doc     = ['1. a', '    1. b', '        1. c', '            1. d', '                1. e', '                    1. f', '                        1. g', '                            1. h', '                            2. i', '                            3. j', '                            4. k', '', 'end'].join('\n');
		// キャレットはリストの外
		const state   = createListState(doc, doc.length);
		// 第 8 階層の項目のウィジェット。文書の上から順
		const widgets = collectLineDecorationEntries(state)
			.map((entry) => entry.decoration.spec.widget as LabelWidgetLike | undefined) // 番号ラベルのウィジェットを取り出す
			.filter((widget): widget is LabelWidgetLike => typeof widget?.label === 'string' && /^\([ivx]+\)$/.test(widget.label)); // 第 8 階層のローマ数字だけ
		expect(widgets.map((widget) => widget.label)).toEqual(['(i)', '(ii)', '(iii)', '(iv)']);
		expect(widgets.map((widget) => widget.widest)).toEqual(['(iii)', '(iii)', '(iii)', '(iii)']);
	});
});
