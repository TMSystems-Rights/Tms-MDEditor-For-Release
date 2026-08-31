import { tags } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';

const Punctuation              = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1\u2010-\u2027]/;
const YAML_FRONT_MATTER_MARKER = /^---[ \t]*$/;

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

/**
 * `==ハイライト==` 記法（Obsidian 相当）
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
			 * @param {import('@lezer/markdown').InlineContext} cx インライン文脈
			 * @param {number} next 現在文字コード
			 * @param {number} pos 位置
			 * @returns {number}
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
 * `---` を水平線または Setext 見出しの下線として解釈させない。
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
			 * 文書先頭の `---` から対応する終了マーカーまでを 1 ブロックとして取り込む。
			 * @param {import('@lezer/markdown').BlockContext} cx ブロック文脈
			 * @param {import('@lezer/markdown').Line} line 現在行
			 * @returns {boolean}
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
 * `![[埋め込み画像]]` 記法（Obsidian 埋め込み）
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
			 * @param {import('@lezer/markdown').InlineContext} cx インライン文脈
			 * @param {number} next 現在文字コード
			 * @param {number} pos 位置
			 * @returns {number}
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
 * `[[内部リンク]]` 記法（見た目のみ。遷移は v1.0 対象外）
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
			 * @param {import('@lezer/markdown').InlineContext} cx インライン文脈
			 * @param {number} next 現在文字コード
			 * @param {number} pos 位置
			 * @returns {number}
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
 * コールアウト先頭の `[!type]` / `[!type]-` / `[!type]+` マーカー
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
			 * `[!type]` および折りたたみ記号 `+`/`-` を取り込む
			 * @param {import('@lezer/markdown').InlineContext} cx インライン文脈
			 * @param {number} next 現在文字コード
			 * @param {number} pos 位置
			 * @returns {number}
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
 * TMS-MDEditor 向け Obsidian 独自記法拡張一式
 */
export const tmsMarkdownExtensions: MarkdownConfig[] = [
	YamlFrontMatter,
	Highlight,
	WikiEmbed,
	WikiLink,
	CalloutMark,
];

/** Obsidian 標準コールアウト種別（正規化後） */
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

export type CalloutType = typeof CALLOUT_TYPES[number];

/** 別名 → 正規化種別（Obsidian Help 準拠） */
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

export type CalloutFoldDefault = 'none' | 'collapsed' | 'expanded';

export type CalloutInfo = {
	type: CalloutType;
	markFrom: number;
	markTo: number;
	foldDefault: CalloutFoldDefault;
	calloutFrom: number;
};

/**
 * コールアウト種別を正規化する（未知は note）
 * @param {string} raw 生の種別文字列
 * @returns {CalloutType}
 */
export function normalizeCalloutType(raw: string): CalloutType {
	const lower = raw.toLowerCase();
	return CALLOUT_ALIASES[lower] ?? 'note';
}

/**
 * 折りたたみ記号からデフォルト状態を返す
 * @param {string | undefined} foldMark `+` / `-` / なし
 * @returns {CalloutFoldDefault}
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
