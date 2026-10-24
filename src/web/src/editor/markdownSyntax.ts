/**
 * Obsidian 相当の独自記法を、Lezer の Markdown パーサへ追加する
 * 描画と遷移は持たず、ノード名とコールアウト種別の正規化だけを公開する
 * @file
 */
import { tags } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';

/** ハイライト記法の前後で区切りとみなす記号。空白とは別に判定する */
const Punctuation              = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1\u2010-\u2027]/;
/** YAML フロントマターの開始と終了行。`---` のあとは空白だけを許す */
const YAML_FRONT_MATTER_MARKER = /^---[ \t]*$/;

/** `==` のインライン区切り。開閉は前後の空白と記号で決める */
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

/**
 * `==ハイライト==` 記法（Obsidian 相当）の Markdown 拡張
 * 3 つ続く `=` は区切りにしない
 */
export const Highlight: MarkdownConfig = {
	defineNodes: [
		{
			name : 'Highlight',
			style: { 'Highlight/...': tags.special(tags.content) },
		},
		{
			name : 'HighlightMark',
			style: tags.processingInstruction,
		},
	],
	parseInline: [
		{
			name: 'Highlight',
			/**
			 * `==` デリミタを登録する
			 * 3 つ続く `=` は対象にしない
			 * @param cx - インライン解析の文脈
			 * @param next - 現在位置の文字コード。`=` でなければ登録しない
			 * @param pos - 現在位置の文書オフセット
			 * @returns 区切りを登録したあとの終端。対象外は -1
			 */
			parse(cx, next, pos) {
				if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) {
					return -1;
				}

				const before  = cx.slice(pos - 1, pos);
				const after   = cx.slice(pos + 2, pos + 3);
				const sBefore = /\s|^$/.test(before);
				const sAfter  = /\s|^$/.test(after);
				const pBefore = Punctuation.test(before);
				const pAfter  = Punctuation.test(after);

				return cx.addDelimiter(
					HighlightDelim,
					pos,
					pos + 2,
					!sAfter && (!pAfter || sBefore || pBefore),
					!sBefore && (!pBefore || sAfter || pAfter),
				);
			},
			after: 'Emphasis',
		},
	],
};

/**
 * 文書先頭の YAML フロントマター
 * `---` を水平線または Setext 見出しの下線として解釈させない
 */
export const YamlFrontMatter: MarkdownConfig = {
	defineNodes: [
		{ name: 'YamlFrontMatter', block: true, style: tags.meta },
		{ name: 'YamlFrontMatterMark', style: tags.processingInstruction },
		{ name: 'YamlFrontMatterContent', style: tags.content },
	],
	parseBlock: [
		{
			name: 'YamlFrontMatter',
			/**
			 * 文書先頭の `---` から、対応する終了マーカーまでを 1 ブロックとして取り込む
			 * 終了マーカーが無いときは、読んだ行までをフロントマターにする
			 * @param cx - ブロック解析の文脈。行頭以外では取り込まない
			 * @param line - 現在行。インデントがあると対象外
			 * @returns フロントマターとして取り込んだとき true
			 */
			parse(cx, line) {
				if (
					cx.lineStart !== 0
					|| line.baseIndent !== 0
					|| line.pos !== 0
					|| !YAML_FRONT_MATTER_MARKER.test(line.text)
				) {
					return false;
				}

				const from     = cx.lineStart + line.pos;
				const children = [cx.elt('YamlFrontMatterMark', from, from + 3)];

				while (cx.nextLine()) {
					const lineFrom = cx.lineStart + line.basePos;
					const lineTo   = cx.lineStart + line.text.length;

					if (
						line.baseIndent === 0
						&& line.pos === 0
						&& YAML_FRONT_MATTER_MARKER.test(line.text)
					) {
						children.push(cx.elt('YamlFrontMatterMark', lineFrom, lineFrom + 3));
						cx.nextLine();
						break;
					}

					if (lineFrom < lineTo) {
						children.push(cx.elt('YamlFrontMatterContent', lineFrom, lineTo));
					}
				}

				cx.addElement(cx.elt('YamlFrontMatter', from, cx.prevLineEnd(), children));
				return true;
			},
			before: 'HorizontalRule',
		},
	],
};

/**
 * `![[埋め込み]]` 記法（Obsidian の埋め込み）の Markdown 拡張
 * 空の `![[]]` はノードにしない
 */
export const WikiEmbed: MarkdownConfig = {
	defineNodes: [
		{ name: 'WikiEmbed', style: tags.link },
		{ name: 'WikiEmbedMark', style: tags.processingInstruction },
		{ name: 'WikiEmbedPath', style: tags.link },
	],
	parseInline: [
		{
			name: 'WikiEmbed',
			/**
			 * `![[...]]` を WikiEmbed ノードとして取り込む
			 * 改行を含むものと、中身の無い `![[]]` は対象外
			 * @param cx - インライン解析の文脈
			 * @param next - 現在位置の文字コード。`!` でなければ対象外
			 * @param pos - 現在位置の文書オフセット
			 * @returns ノード終端。対象外は -1
			 */
			parse(cx, next, pos) {
				if (
					next !== 33 /* '!' */
					|| cx.char(pos + 1) !== 91 /* '[' */
					|| cx.char(pos + 2) !== 91 /* '[' */
				) {
					return -1;
				}

				let end = -1;
				for (let index = pos + 3; index < cx.end - 1; index += 1) {
					const code = cx.char(index);
					if (code === 10 /* '\n' */) {
						break;
					}

					if (code === 93 /* ']' */ && cx.char(index + 1) === 93) {
						end = index + 2;
						break;
					}
				}

				// 空の ![[]] は対象外
				if (end < 0 || end - pos <= 5) {
					return -1;
				}

				return cx.addElement(cx.elt('WikiEmbed', pos, end, [
					cx.elt('WikiEmbedMark', pos, pos + 3),
					cx.elt('WikiEmbedPath', pos + 3, end - 2),
					cx.elt('WikiEmbedMark', end - 2, end),
				]));
			},
			before: 'Image',
		},
	],
};

/**
 * `[[内部リンク]]` 記法の Markdown 拡張
 * 見た目のノードだけを作り、遷移は持たない。空の `[[]]` はノードにしない
 */
export const WikiLink: MarkdownConfig = {
	defineNodes: [
		{ name: 'WikiLink', style: tags.link },
		{ name: 'WikiLinkMark', style: tags.processingInstruction },
		{ name: 'WikiLinkPage', style: tags.link },
	],
	parseInline: [
		{
			name: 'WikiLink',
			/**
			 * `[[...]]` を WikiLink ノードとして取り込む
			 * 改行を含むものと、中身の無い `[[]]` は対象外
			 * @param cx - インライン解析の文脈
			 * @param next - 現在位置の文字コード。`[` が続かなければ対象外
			 * @param pos - 現在位置の文書オフセット
			 * @returns ノード終端。対象外は -1
			 */
			parse(cx, next, pos) {
				if (next !== 91 /* '[' */ || cx.char(pos + 1) !== 91) {
					return -1;
				}

				let end = -1;
				for (let index = pos + 2; index < cx.end - 1; index += 1) {
					const code = cx.char(index);
					if (code === 10 /* '\n' */) {
						break;
					}

					if (code === 93 /* ']' */ && cx.char(index + 1) === 93) {
						end = index + 2;
						break;
					}
				}

				// 空の [[]] は対象外
				if (end < 0 || end - pos <= 4) {
					return -1;
				}

				return cx.addElement(cx.elt('WikiLink', pos, end, [
					cx.elt('WikiLinkMark', pos, pos + 2),
					cx.elt('WikiLinkPage', pos + 2, end - 2),
					cx.elt('WikiLinkMark', end - 2, end),
				]));
			},
			before: 'Link',
		},
	],
};

/**
 * コールアウト先頭の `[!type]`、`[!type]-`、`[!type]+` マーカー
 * 折りたたみ記号が無いときは CalloutFoldMark を作らない
 */
export const CalloutMark: MarkdownConfig = {
	defineNodes: [
		{ name: 'CalloutMark', style: tags.processingInstruction },
		{ name: 'CalloutType', style: tags.labelName },
		{ name: 'CalloutFoldMark', style: tags.processingInstruction },
	],
	parseInline: [
		{
			name: 'CalloutMark',
			/**
			 * `[!type]` および折りたたみ記号 `+` / `-` を取り込む
			 * @param cx - インライン解析の文脈。種別は先頭 48 文字までを見る
			 * @param next - 現在位置の文字コード。`[` でなければ対象外
			 * @param pos - 現在位置の文書オフセット
			 * @returns ノード終端。パターンに合わなければ -1
			 */
			parse(cx, next, pos) {
				if (next !== 91 /* '[' */ || cx.char(pos + 1) !== 33 /* '!' */) {
					return -1;
				}

				const slice = cx.slice(pos, Math.min(cx.end, pos + 48));
				const match = /^\[!([A-Za-z][\w-]*)\]([+-])?/.exec(slice);
				if (!match) {
					return -1;
				}

				const end      = pos + match[0].length;
				const typeFrom = pos + 2;
				const typeTo   = typeFrom + match[1].length;
				const children = [
					cx.elt('CalloutType', typeFrom, typeTo),
				];

				if (match[2]) {
					const foldPos = typeTo + 1; // `]` の次
					children.push(cx.elt('CalloutFoldMark', foldPos, foldPos + 1));
				}

				return cx.addElement(cx.elt('CalloutMark', pos, end, children));
			},
			before: 'Link',
		},
	],
};

/**
 * TMS-MDEditor 向けの Obsidian 独自記法拡張
 * この並びでパーサへ渡す。フロントマターをハイライトより先に解釈する
 */
export const tmsMarkdownExtensions: MarkdownConfig[] = [
	YamlFrontMatter,
	Highlight,
	WikiEmbed,
	WikiLink,
	CalloutMark,
];

/** Obsidian 標準のコールアウト種別。正規化後の値だけを並べ、別名は含まない */
export const CALLOUT_TYPES = [
	'note',
	'abstract',
	'info',
	'todo',
	'tip',
	'success',
	'question',
	'warning',
	'failure',
	'danger',
	'bug',
	'example',
	'quote',
] as const;

/**
 * 正規化後のコールアウト種別
 * 別名は CALLOUT_ALIASES を通したあと、このいずれかになる。未知は note
 */
export type CalloutType = typeof CALLOUT_TYPES[number];

/** 別名から正規化種別への対応。Obsidian Help に合わせ、`fnq` も question として残す */
const CALLOUT_ALIASES: Record<string, CalloutType> = {
	note     : 'note',
	abstract : 'abstract',
	summary  : 'abstract',
	tldr     : 'abstract',
	info     : 'info',
	todo     : 'todo',
	tip      : 'tip',
	hint     : 'tip',
	important: 'tip',
	success  : 'success',
	check    : 'success',
	done     : 'success',
	question : 'question',
	help     : 'question',
	faq      : 'question',
	fnq      : 'question', // テスト文書の typo も question 扱い
	warning  : 'warning',
	caution  : 'warning',
	attention: 'warning',
	failure  : 'failure',
	fail     : 'failure',
	missing  : 'failure',
	danger   : 'danger',
	error    : 'danger',
	bug      : 'bug',
	example  : 'example',
	quote    : 'quote',
	cite     : 'quote',
};

/**
 * コールアウトの初期折りたたみ
 * `none` は記号なし、`collapsed` は `-`、`expanded` は `+`
 */
export type CalloutFoldDefault = 'none' | 'collapsed' | 'expanded';

/**
 * 本文中のコールアウト見出しから取り出した情報
 * ブロックの終わりは呼び出し側が決める
 */
export type CalloutInfo = {
	/** 正規化後の種別。未知の生文字列は note */
	type: CalloutType;
	/** `[!type]` マーカー先頭の文書オフセット（含む） */
	markFrom: number;
	/** マーカー末尾の文書オフセット（含まない）。折りたたみ記号があれば含む */
	markTo: number;
	/** `+` / `-` から決めた初期状態。記号が無ければ none */
	foldDefault: CalloutFoldDefault;
	/** コールアウトブロック先頭の文書オフセット */
	calloutFrom: number;
};

/**
 * コールアウト種別を正規化する。未知の文字列は note にする
 * @param raw - マーカーから取り出した生の種別。大文字小文字は区別しない
 * @returns 正規化後の種別。別名も未知も、CALLOUT_TYPES のいずれか
 */
export function normalizeCalloutType(raw: string): CalloutType {
	const lower = raw.toLowerCase();
	return CALLOUT_ALIASES[lower] ?? 'note';
}

/**
 * 折りたたみ記号から、コールアウトの初期状態を返す
 * @param foldMark - `+`、`-`、または記号なし。未指定と空以外の文字は none
 * @returns `-` は collapsed、`+` は expanded、それ以外は none
 */
export function foldDefaultFromMark(foldMark: string | undefined): CalloutFoldDefault {
	if (foldMark === '-') {
		return 'collapsed';
	}

	if (foldMark === '+') {
		return 'expanded';
	}

	return 'none';
}
