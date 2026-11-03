/**
 * 番号付きリストの番号を、階層ごとの採番ルールで表示用のラベルへ変える
 * 状態は持たず、ルールは呼び出し側が設定から渡す。エディタへは Facet で載せる
 * @file
 */
import { Facet, type EditorState, type Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { ListNumberEnclosure, ListNumberingSettings, ListNumberKind, ListNumberLevelSettings } from '../types/app';

// ==============================================
// 採番ルールの定義
// ==============================================

/** 採番ルールを持つ階層の数。これより深い階層はソースの番号をそのまま出す */
export const LIST_NUMBERING_LEVEL_COUNT = 8;

/** 階層ごとの設定キー。並びが第 1 階層からの順。実行中は変えない */
export const LIST_NUMBERING_LEVEL_KEYS = ['level1', 'level2', 'level3', 'level4', 'level5', 'level6', 'level7', 'level8'] as const satisfies ReadonlyArray<keyof ListNumberingSettings>;

/**
 * 1 つの階層の採番ルールを、変更できない値として作る
 * @param kind - 番号の文字種
 * @param enclosure - 番号の囲み
 * @returns 凍結したルール
 */
function createFrozenLevel(kind: ListNumberKind, enclosure: ListNumberEnclosure): ListNumberLevelSettings {
	return Object.freeze({
		// 番号の文字種
		kind,
		// 番号の囲み
		enclosure
	});
}

/** 既定の採番ルール。設定が無い階層と、未知の値を読んだ階層はこの値へ戻す。実行中は変えない */
export const DEFAULT_LIST_NUMBERING: Readonly<ListNumberingSettings> = Object.freeze({
	// 第 1 階層。`1.`
	level1: createFrozenLevel('decimal', 'period'),
	// 第 2 階層。`(1)`
	level2: createFrozenLevel('decimal', 'paren'),
	// 第 3 階層。`①`。51 以上はソースの番号
	level3: createFrozenLevel('circled', 'none'),
	// 第 4 階層。`(ア)`
	level4: createFrozenLevel('katakana', 'paren'),
	// 第 5 階層。`(あ)`
	level5: createFrozenLevel('hiragana', 'paren'),
	// 第 6 階層。`(A)`
	level6: createFrozenLevel('upper-alpha', 'paren'),
	// 第 7 階層。`(a)`
	level7: createFrozenLevel('lower-alpha', 'paren'),
	// 第 8 階層。`(i)`
	level8: createFrozenLevel('lower-roman', 'paren')
});

/** 設定画面で選べる文字種と表示名。並びが選択肢の順 */
export const LIST_NUMBER_KIND_OPTIONS: ReadonlyArray<readonly [ListNumberKind, string]> = [
	['decimal', '半角数字（1 2 3）'],
	['fullwidth-decimal', '全角数字（１ ２ ３）'],
	['circled', '丸数字（① ② ③ ～ ㊿）'],
	['katakana', 'カタカナ（ア イ ウ）'],
	['hiragana', '平仮名（あ い う）'],
	['upper-alpha', '英大文字（A B C）'],
	['lower-alpha', '英小文字（a b c）'],
	['upper-roman', 'ローマ数字大文字（I II III）'],
	['lower-roman', 'ローマ数字小文字（i ii iii）']
];

/** 設定画面で選べる囲みと表示名。並びが選択肢の順 */
export const LIST_NUMBER_ENCLOSURE_OPTIONS: ReadonlyArray<readonly [ListNumberEnclosure, string]> = [
	['period', 'ピリオド（1.）'],
	['paren', '半角括弧（(1)）'],
	['right-paren', '閉じ括弧のみ（1)）'],
	['fullwidth-paren', '全角括弧（（1））'],
	['none', 'なし（1）']
];

/** 文字種の値の集合。保存値の検査に使う */
const LIST_NUMBER_KINDS: ReadonlySet<string> = new Set(LIST_NUMBER_KIND_OPTIONS.map(([kind]) => kind));

/** 囲みの値の集合。保存値の検査に使う */
const LIST_NUMBER_ENCLOSURES: ReadonlySet<string> = new Set(LIST_NUMBER_ENCLOSURE_OPTIONS.map(([enclosure]) => enclosure));

/** カタカナの番号に使う 41 字。ヰとヱは使わない。並びが 1 からの順 */
const KATAKANA_DIGITS: readonly string[] = Array.from('アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨワヲン');

/** 平仮名の番号に使う 41 字。カタカナと同じ並び */
const HIRAGANA_DIGITS: readonly string[] = Array.from('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよわをん');

/** 英大文字の番号に使う 26 字 */
const UPPER_ALPHA_DIGITS: readonly string[] = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ');

/** 英小文字の番号に使う 26 字 */
const LOWER_ALPHA_DIGITS: readonly string[] = Array.from('abcdefghijklmnopqrstuvwxyz');

/** ローマ数字で表せる最大値。4000 以上は標準の記法が無い */
const ROMAN_MAX = 3999;

/** ローマ数字の位取り。大きい値から順に引いていく */
const ROMAN_PARTS: ReadonlyArray<readonly [number, string]> = [
	[1000, 'M'],
	[900, 'CM'],
	[500, 'D'],
	[400, 'CD'],
	[100, 'C'],
	[90, 'XC'],
	[50, 'L'],
	[40, 'XL'],
	[10, 'X'],
	[9, 'IX'],
	[5, 'V'],
	[4, 'IV'],
	[1, 'I']
];

/** 丸数字で表せる最大値。51 以上は Unicode に丸数字が無い */
const CIRCLED_MAX = 50;

/** 番号付きリストの記号。数字と区切りの `.` か `)` */
const ORDERED_MARK_PATTERN = /^(\d+)[.)]$/;

// ==============================================
// 番号の文字列化
// ==============================================

/**
 * 1 始まりの番号を、指定した字の並びで繰り上がる表記にする
 * 0 を持たない位取りで、字が 3 種なら 1→あ、3→う、4→ああ のように進む
 * @param value - 1 以上の番号
 * @param digits - 1 桁に使う字。並びが 1 からの順
 * @returns 番号の表記
 */
function formatBijective(value: number, digits: readonly string[]): string {
	// 下の桁から積む表記の字
	const letters: string[] = [];
	// まだ表記していない残りの番号。0 になったら終わる
	let rest                = value;
	while (rest > 0) {
		// 0 始まりにした残り。字の添字を取るために 1 を引く
		const zeroBased = rest - 1;
		letters.unshift(digits[zeroBased % digits.length]);
		rest = Math.floor(zeroBased / digits.length);
	}

	return letters.join('');
}

/**
 * 番号をローマ数字にする
 * @param value - 1〜3999 の番号
 * @returns 大文字のローマ数字
 */
function formatRoman(value: number): string {
	// 組み立て中のローマ数字
	let text = '';
	// まだ表記していない残りの番号
	let rest = value;
	for (const [unit, symbol] of ROMAN_PARTS) {
		while (rest >= unit) {
			text += symbol;
			rest -= unit;
		}
	}

	return text;
}

/**
 * 番号を丸数字にする
 * ①〜⑳、㉑〜㉟、㊱〜㊿ は Unicode 上で離れた 3 区間にある
 * @param value - 1〜50 の番号
 * @returns 丸数字 1 文字
 */
function formatCircled(value: number): string {
	// 1〜20。U+2460 から並ぶ
	if (value <= 20) {
		return String.fromCodePoint(0x2460 + value - 1);
	}

	// 21〜35。U+3251 から並ぶ
	if (value <= 35) {
		return String.fromCodePoint(0x3251 + value - 21);
	}

	return String.fromCodePoint(0x32b1 + value - 36);
}

/**
 * 半角数字の各桁を全角数字へ置き換える
 * @param value - 0 以上の番号
 * @returns 全角数字の並び
 */
function formatFullwidthDecimal(value: number): string {
	return Array.from(String(value), (digit) => String.fromCodePoint(0xff10 + Number(digit))).join('');
}

/**
 * 番号を文字種の表記にする。囲みは付けない
 * @param kind - 文字種
 * @param value - ソースに書かれた番号。0 以上の整数
 * @returns 番号の表記。文字種で表せない番号（0 やローマ数字の 4000 以上など）は null
 */
export function formatListNumberText(kind: ListNumberKind, value: number): string | null {
	// 整数でない、または負の番号は、どの文字種でも表さない
	if (!Number.isSafeInteger(value) || value < 0) {
		return null;
	}

	switch (kind) {
		// 半角数字。0 も表せる
		case 'decimal':
			return String(value);
		// 全角数字。0 も表せる
		case 'fullwidth-decimal':
			return formatFullwidthDecimal(value);
		// 丸数字。1〜50 だけ
		case 'circled':
			return value >= 1 && value <= CIRCLED_MAX ? formatCircled(value) : null;
		// カタカナ。0 は表せない
		case 'katakana':
			return value >= 1 ? formatBijective(value, KATAKANA_DIGITS) : null;
		// 平仮名。0 は表せない
		case 'hiragana':
			return value >= 1 ? formatBijective(value, HIRAGANA_DIGITS) : null;
		// 英大文字。0 は表せない
		case 'upper-alpha':
			return value >= 1 ? formatBijective(value, UPPER_ALPHA_DIGITS) : null;
		// 英小文字。0 は表せない
		case 'lower-alpha':
			return value >= 1 ? formatBijective(value, LOWER_ALPHA_DIGITS) : null;
		// ローマ数字大文字。1〜3999 だけ
		case 'upper-roman':
			return value >= 1 && value <= ROMAN_MAX ? formatRoman(value) : null;
		// ローマ数字小文字。1〜3999 だけ
		case 'lower-roman':
			return value >= 1 && value <= ROMAN_MAX ? formatRoman(value).toLowerCase() : null;
		default:
			return null;
	}
}

/**
 * 番号の表記へ囲みを付ける
 * @param text - 文字種の表記
 * @param enclosure - 付ける囲み
 * @returns 囲みを付けたラベル
 */
export function encloseListNumber(text: string, enclosure: ListNumberEnclosure): string {
	switch (enclosure) {
		// 後ろにピリオド
		case 'period':
			return `${text}.`;
		// 半角の丸括弧で囲む
		case 'paren':
			return `(${text})`;
		// 後ろに半角の閉じ括弧だけ
		case 'right-paren':
			return `${text})`;
		// 全角の丸括弧で囲む
		case 'fullwidth-paren':
			return `（${text}）`;
		default:
			return text;
	}
}

/**
 * 1 つの階層のルールで、番号をラベルにする
 * @param level - その階層の採番ルール
 * @param value - ソースに書かれた番号
 * @returns 表示ラベル。文字種で表せない番号は null
 */
export function formatListNumberLabel(level: ListNumberLevelSettings, value: number): string | null {
	// 囲みを付ける前の表記。表せなければ null
	const text = formatListNumberText(level.kind, value);
	return text === null ? null : encloseListNumber(text, level.enclosure);
}

/**
 * 番号付きリストの記号を、階層のルールで表示ラベルにする
 * 第 9 階層以降と、文字種で表せない番号は、記号をそのまま返す
 * @param markText - ソースの記号。`12.` や `3)` のように数字と区切り
 * @param depth - リストの入れ子の深さ。1 始まりで、箇条書きも数える
 * @param numbering - 階層ごとの採番ルール
 * @returns 表示ラベル。ルールで表せないときは markText
 */
export function formatOrderedListMarker(markText: string, depth: number, numbering: ListNumberingSettings): string {
	// 数字と区切りに分けた記号。番号付きの記号でなければ null
	const match = ORDERED_MARK_PATTERN.exec(markText);
	// 番号付きの記号でない、または採番ルールの無い深さなら、記号のまま出す。どちらか一方でも記号のまま
	if (!match || depth < 1 || depth > LIST_NUMBERING_LEVEL_COUNT) {
		return markText;
	}

	// その深さの採番ルール
	const level = numbering[LIST_NUMBERING_LEVEL_KEYS[depth - 1]];
	return formatListNumberLabel(level, Number(match[1])) ?? markText;
}

// ==============================================
// 設定値の補完
// ==============================================

/**
 * 1 つの階層の保存値を、未知の値を既定へ戻した形にする
 * @param source - 保存値。欠けていてもよい
 * @param fallback - その階層の既定
 * @returns 文字種と囲みが既知の値だけの新しいルール
 */
function resolveListNumberLevel(source: Partial<ListNumberLevelSettings> | null | undefined, fallback: ListNumberLevelSettings): ListNumberLevelSettings {
	// 保存された文字種。未知の値なら既定
	const kind      = typeof source?.kind === 'string' && LIST_NUMBER_KINDS.has(source.kind) ? source.kind : fallback.kind;
	// 保存された囲み。未知の値なら既定
	const enclosure = typeof source?.enclosure === 'string' && LIST_NUMBER_ENCLOSURES.has(source.enclosure) ? source.enclosure : fallback.enclosure;
	// 補完したルール
	return {
		// 番号の文字種
		kind,
		// 番号の囲み
		enclosure
	};
}

/**
 * 保存値の採番ルールを、欠けた階層と未知の値を既定で埋めた形にする
 * @param source - 保存値。null や一部の階層だけでもよい
 * @returns 8 階層すべてを持つ新しいルール。引数は変えない
 */
export function resolveListNumbering(source: Partial<Record<keyof ListNumberingSettings, Partial<ListNumberLevelSettings>>> | null | undefined): ListNumberingSettings {
	// 階層ごとに補完したルール。キーの並びは第 1 階層から
	const entries = LIST_NUMBERING_LEVEL_KEYS.map((key) => [key, resolveListNumberLevel(source?.[key], DEFAULT_LIST_NUMBERING[key])] as const);
	return Object.fromEntries(entries) as ListNumberingSettings;
}

/**
 * 2 つの採番ルールが、すべての階層で同じか判定する
 * @param left - 比べる一方
 * @param right - 比べるもう一方
 * @returns 全階層の文字種と囲みが一致すれば true
 */
export function sameListNumbering(left: ListNumberingSettings, right: ListNumberingSettings): boolean {
	return LIST_NUMBERING_LEVEL_KEYS.every((key) => left[key].kind === right[key].kind && left[key].enclosure === right[key].enclosure);
}

// ==============================================
// エディタと構文木からの参照
// ==============================================

/**
 * エディタへ載せる採番ルール
 * 最後に提供された値を使い、提供が無ければ既定。内容が同じなら再構成の前後で同じ値を返す
 */
export const listNumberingFacet = Facet.define<ListNumberingSettings, ListNumberingSettings>({
	/**
	 * 提供されたルールのうち最後のものを現在値にする
	 * @param values - この Facet へ提供されたルール。空なら提供が無い
	 * @returns 最後のルール。提供が無ければ既定
	 */
	combine(values) {
		return values.at(-1) ?? DEFAULT_LIST_NUMBERING;
	},
	/**
	 * 内容で比べ、設定の再構成で値が変わったとみなすのを中身が変わったときだけにする
	 * @param left - 以前の値
	 * @param right - 新しい値
	 * @returns 全階層が同じなら true
	 */
	compare: sameListNumbering
});

/**
 * エディタ状態から採番ルールを読む
 * @param state - Facet を持つエディタ状態
 * @returns 載っているルール。提供が無ければ既定
 */
export function readListNumbering(state: EditorState): ListNumberingSettings {
	return state.facet(listNumberingFacet);
}

/**
 * リスト項目の入れ子の深さを数える
 * 箇条書きと番号付きを区別せず、引用やコールアウトの中でも項目の祖先だけを数える
 * @param item - ListItem ノード
 * @returns 1 始まりの深さ。最上位の項目は 1
 */
export function countListItemDepth(item: SyntaxNode): number {
	// 自身を含めた深さ
	let depth = 1;
	for (let parent = item.parent; parent; parent = parent.parent) {
		// 祖先のリスト項目ごとに 1 段深くする
		if (parent.name === 'ListItem') {
			depth += 1;
		}
	}

	return depth;
}

// ==============================================
// 兄弟の項目とラベルの幅をそろえる
// ==============================================

/** 全角の幅で描く文字の範囲。丸数字は東アジアの幅が曖昧だが、日本語フォントでは全角で描くので含める */
const WIDE_CHARACTER_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f],
	[0x2460, 0x24ff],
	[0x2e80, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6]
];

/**
 * ラベルの見た目の幅を、半角を 1、全角を 2 として見積もる
 * 兄弟の中で最も広いラベルを選ぶためだけに使い、描画の幅そのものは DOM に任せる
 * @param label - 表示ラベル
 * @returns 見積もった幅。単位は半角 1 文字
 */
export function estimateListLabelWidth(label: string): number {
	return Array.from(label).reduce((width, character) => {
		// 文字のコードポイント。Array.from で分けたので 1 文字ずつ
		const code = character.codePointAt(0) ?? 0;
		return width + (WIDE_CHARACTER_RANGES.some(([from, to]) => code >= from && code <= to) ? 2 : 1);
	}, 0);
}

/**
 * 番号付きリストの 1 項目について、表示ラベルを作る
 * @param doc - 項目がある文書
 * @param item - 番号付きリストの ListItem
 * @param numbering - 階層ごとの採番ルール
 * @returns 表示ラベル。ルールで表せないときはソースの記号。記号の無い項目は null
 */
export function formatOrderedListItemLabel(doc: Text, item: SyntaxNode, numbering: ListNumberingSettings): string | null {
	// 項目直下のリスト記号。無ければ null
	const mark = item.getChild('ListMark');
	// 記号の無い項目は番号を決められない
	if (!mark) {
		return null;
	}

	return formatOrderedListMarker(doc.sliceString(mark.from, mark.to), countListItemDepth(item), numbering);
}

/**
 * 番号付きリストの兄弟の項目のうち、最も広く描くラベルを選ぶ
 * 各項目のラベルをこの幅にそろえると、本文の開始位置が兄弟のあいだでそろう
 * @param doc - リストがある文書
 * @param list - OrderedList ノード
 * @param numbering - 階層ごとの採番ルール
 * @returns 最も広いラベル。見積もりが同じなら文字数の多い方、さらに同じなら先の項目。項目が無ければ空文字
 */
export function findWidestOrderedListLabel(doc: Text, list: SyntaxNode, numbering: ListNumberingSettings): string {
	// これまでで最も広いラベル。項目が無ければ空文字のまま
	let widest      = '';
	// widest の見積もり幅。半角 1 文字が 1
	let widestWidth = -1;
	for (let child = list.firstChild; child; child = child.nextSibling) {
		// リスト項目以外の子は数えない
		if (child.name !== 'ListItem') {
			continue;
		}

		// この項目のラベル。記号が無ければ null
		const label = formatOrderedListItemLabel(doc, child, numbering);
		// 記号の無い項目は幅の比較に入れない
		if (label === null) {
			continue;
		}

		// この項目のラベルの見積もり幅
		const width = estimateListLabelWidth(label);
		// 見積もりが広い、または同じ幅で文字数が多いときだけ入れ替える。どちらでもなければ先の項目を残す
		if (width > widestWidth || (width === widestWidth && label.length > widest.length)) {
			widest      = label;
			widestWidth = width;
		}
	}

	return widest;
}
