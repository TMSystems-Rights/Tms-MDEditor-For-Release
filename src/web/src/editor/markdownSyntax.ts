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
			name: 'Highlight',
			style: { 'Highlight/...': tags.special(tags.content) }
		},
		{
			name: 'HighlightMark',
			style: tags.processingInstruction
		}
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
				// 現在が = でない、次も = でない、または 3 文字目も = なら区切りにしない。`==` ちょうど 2 つのときだけ続ける
				if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) {
					return -1;
				}

				// 区切り直前の 1 文字。文書先頭では空文字で、境界として扱う
				const before  = cx.slice(pos - 1, pos);
				// `==` の直後の 1 文字。文末では空文字
				const after   = cx.slice(pos + 2, pos + 3);
				// 直前が空白、または文字が無い。開閉の判定に使う
				const sBefore = /\s|^$/.test(before);
				// 直後が空白、または文字が無い
				const sAfter  = /\s|^$/.test(after);
				// 直前が区切り記号。空白とは別に、記号に挟まれた `==` を区切りにできるか
				const pBefore = Punctuation.test(before);
				// 直後が区切り記号
				const pAfter  = Punctuation.test(after);

				return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter && (!pAfter || sBefore || pBefore), !sBefore && (!pBefore || sAfter || pAfter));
			},
			after: 'Emphasis'
		}
	]
};

/**
 * 文書先頭の YAML フロントマター
 * `---` を水平線または Setext 見出しの下線として解釈させない
 */
export const YamlFrontMatter: MarkdownConfig = {
	defineNodes: [
		{ name: 'YamlFrontMatter', block: true, style: tags.meta },
		{ name: 'YamlFrontMatterMark', style: tags.processingInstruction },
		{ name: 'YamlFrontMatterContent', style: tags.content }
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
				// 文書先頭でない、インデントがある、行頭以外、または開始マーカーでない。一つでも当たればフロントマターにしない。四つとも欠けるときだけ続ける
				if (cx.lineStart !== 0 || line.baseIndent !== 0 || line.pos !== 0 || !YAML_FRONT_MATTER_MARKER.test(line.text)) {
					return false;
				}

				// 開始マーカーの文書上の位置（文字）。ブロックの開始
				const from     = cx.lineStart + line.pos;
				// 開始の --- をマークとして持つ子。本文と終了マーカーは後から足す
				const children = [cx.elt('YamlFrontMatterMark', from, from + 3)];

				while (cx.nextLine()) {
					// この行の本文開始（文字）。行頭インデントは basePos に含まれる
					const lineFrom = cx.lineStart + line.basePos;
					// この行の末尾（文字）。改行は含めない。空行は開始と終了が同じ
					const lineTo   = cx.lineStart + line.text.length;

					// 行頭で、インデントが無く、終了マーカーである。一つでも欠けると閉じずに本文として読む
					if (line.baseIndent === 0 && line.pos === 0 && YAML_FRONT_MATTER_MARKER.test(line.text)) {
						children.push(cx.elt('YamlFrontMatterMark', lineFrom, lineFrom + 3));
						cx.nextLine();
						break;
					}

					// 中身がある行だけ本文にする。空行は開始と終了が同じなので足さない
					if (lineFrom < lineTo) {
						children.push(cx.elt('YamlFrontMatterContent', lineFrom, lineTo));
					}
				}

				cx.addElement(cx.elt('YamlFrontMatter', from, cx.prevLineEnd(), children));
				return true;
			},
			before: 'HorizontalRule'
		}
	]
};

/**
 * `![[埋め込み]]` 記法（Obsidian の埋め込み）の Markdown 拡張
 * 空の `![[]]` はノードにしない
 */
export const WikiEmbed: MarkdownConfig = {
	defineNodes: [
		{ name: 'WikiEmbed', style: tags.link },
		{ name: 'WikiEmbedMark', style: tags.processingInstruction },
		{ name: 'WikiEmbedPath', style: tags.link }
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
				// 現在が ! でない、次が [ でない、またはその次が [ でない。一つでも欠けると埋め込みにしない。三つ揃ったときだけ続ける
				if (next !== 33 /* '!' */ || cx.char(pos + 1) !== 91 /* '[' */ || cx.char(pos + 2) !== 91 /* '[' */) {
					return -1;
				}

				// 閉じ ]] の終端（文字）。改行が先、または範囲内に閉じが無ければ -1 のまま
				let end = -1;
				for (let index = pos + 3; index < cx.end - 1; index += 1) {
					// この位置の文字コード。改行なら行をまたぐので埋め込みを閉じない
					const code = cx.char(index);
					// 改行が閉じより先。行をまたぐ ![[ はノードにしない
					if (code === 10 /* '\n' */) {
						break;
					}

					// ] の次も ] のときだけ閉じ。片方だけでは閉じとみなさない
					if (code === 93 /* ']' */ && cx.char(index + 1) === 93) {
						// 閉じ ]] の直後（文字）
						end = index + 2;
						break;
					}
				}

				// 空の ![[]] は対象外
				// 閉じが見つからない、または中身が空（`![[]]` は 5 文字）ならノードにしない。どちらか一方でも対象外
				if (end < 0 || end - pos <= 5) {
					return -1;
				}

				return cx.addElement(cx.elt('WikiEmbed', pos, end, [cx.elt('WikiEmbedMark', pos, pos + 3), cx.elt('WikiEmbedPath', pos + 3, end - 2), cx.elt('WikiEmbedMark', end - 2, end)]));
			},
			before: 'Image'
		}
	]
};

/**
 * `[[内部リンク]]` 記法の Markdown 拡張
 * 見た目のノードだけを作り、遷移は持たない。空の `[[]]` はノードにしない
 */
export const WikiLink: MarkdownConfig = {
	defineNodes: [
		{ name: 'WikiLink', style: tags.link },
		{ name: 'WikiLinkMark', style: tags.processingInstruction },
		{ name: 'WikiLinkPage', style: tags.link }
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
				// 現在が [ でない、または次が [ でない。どちらか一方でも内部リンクにしない。二つ揃ったときだけ続ける
				if (next !== 91 /* '[' */ || cx.char(pos + 1) !== 91) {
					return -1;
				}

				// 閉じ ]] の終端（文字）。改行が先、または範囲内に閉じが無ければ -1 のまま
				let end = -1;
				for (let index = pos + 2; index < cx.end - 1; index += 1) {
					// この位置の文字コード。改行なら行をまたぐのでリンクを閉じない
					const code = cx.char(index);
					// 改行が閉じより先。行をまたぐ [[ はノードにしない
					if (code === 10 /* '\n' */) {
						break;
					}

					// ] の次も ] のときだけ閉じ。片方だけでは閉じとみなさない
					if (code === 93 /* ']' */ && cx.char(index + 1) === 93) {
						// 閉じ ]] の直後（文字）
						end = index + 2;
						break;
					}
				}

				// 空の [[]] は対象外
				// 閉じが見つからない、または中身が空（`[[]]` は 4 文字）ならノードにしない。どちらか一方でも対象外
				if (end < 0 || end - pos <= 4) {
					return -1;
				}

				return cx.addElement(cx.elt('WikiLink', pos, end, [cx.elt('WikiLinkMark', pos, pos + 2), cx.elt('WikiLinkPage', pos + 2, end - 2), cx.elt('WikiLinkMark', end - 2, end)]));
			},
			before: 'Link'
		}
	]
};

/**
 * コールアウト先頭の `[!type]`、`[!type]-`、`[!type]+` マーカー
 * 折りたたみ記号が無いときは CalloutFoldMark を作らない
 */
export const CalloutMark: MarkdownConfig = {
	defineNodes: [
		{ name: 'CalloutMark', style: tags.processingInstruction },
		{ name: 'CalloutType', style: tags.labelName },
		{ name: 'CalloutFoldMark', style: tags.processingInstruction }
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
				// 現在が [ でない、または次が ! でない。どちらか一方でもコールアウトにしない。二つ揃ったときだけ続ける
				if (next !== 91 /* '[' */ || cx.char(pos + 1) !== 33 /* '!' */) {
					return -1;
				}

				// 種別判定に使う断片。現在位置から最大 48 文字。文書末尾が近ければそこまで
				const slice = cx.slice(pos, Math.min(cx.end, pos + 48));
				// [!type] と、あれば折りたたみ記号 1 文字。形が違えば null
				const match = /^\[!([A-Za-z][\w-]*)\]([+-])?/.exec(slice);
				// 種別の形が合わない。ノードにせず、続くリンクの解釈へ返す
				if (!match) {
					return -1;
				}

				// マーカー全体の終端（文字）。折りたたみ記号があればその次、無ければ ] の次
				const end      = pos + match[0].length;
				// 種別の開始（文字）。[! の直後
				const typeFrom = pos + 2;
				// 種別の終端（文字）。] の手前
				const typeTo   = typeFrom + match[1].length;
				// 子ノード。種別は必ず入れ、折りたたみ記号は後から足す。記号が無ければ種別だけ
				const children = [cx.elt('CalloutType', typeFrom, typeTo)];

				// 折りたたみ記号 + か - があるときだけ、記号のノードを足す。キャプチャが無いときは種別だけ
				if (match[2]) {
					const foldPos = typeTo + 1; // `]` の次
					children.push(cx.elt('CalloutFoldMark', foldPos, foldPos + 1));
				}

				return cx.addElement(cx.elt('CalloutMark', pos, end, children));
			},
			before: 'Link'
		}
	]
};

/**
 * TMS-MDEditor 向けの Obsidian 独自記法拡張
 * この並びでパーサへ渡す。フロントマターをハイライトより先に解釈する
 */
export const tmsMarkdownExtensions: MarkdownConfig[] = [YamlFrontMatter, Highlight, WikiEmbed, WikiLink, CalloutMark];

/** Obsidian 標準のコールアウト種別。正規化後の値だけを並べ、別名は含まない */
export const CALLOUT_TYPES = ['note', 'abstract', 'info', 'todo', 'tip', 'success', 'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote'] as const;

/**
 * 正規化後のコールアウト種別
 * 別名は CALLOUT_ALIASES を通したあと、このいずれかになる。未知は note
 */
export type CalloutType = (typeof CALLOUT_TYPES)[number];

/** 別名から正規化種別への対応。Obsidian Help に合わせ、`fnq` も question として残す */
const CALLOUT_ALIASES: Record<string, CalloutType> = {
	note: 'note',
	abstract: 'abstract',
	summary: 'abstract',
	tldr: 'abstract',
	info: 'info',
	todo: 'todo',
	tip: 'tip',
	hint: 'tip',
	important: 'tip',
	success: 'success',
	check: 'success',
	done: 'success',
	question: 'question',
	help: 'question',
	faq: 'question',
	fnq: 'question', // テスト文書の typo も question 扱い
	warning: 'warning',
	caution: 'warning',
	attention: 'warning',
	failure: 'failure',
	fail: 'failure',
	missing: 'failure',
	danger: 'danger',
	error: 'danger',
	bug: 'bug',
	example: 'example',
	quote: 'quote',
	cite: 'quote'
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
	// 比較用の小文字。大文字の種別も同じ別名に畳む。マップに無いときは note
	const lower = raw.toLowerCase();
	return CALLOUT_ALIASES[lower] ?? 'note';
}

/**
 * 折りたたみ記号から、コールアウトの初期状態を返す
 * @param foldMark - `+`、`-`、または記号なし。未指定と空以外の文字は none
 * @returns `-` は collapsed、`+` は expanded、それ以外は none
 */
export function foldDefaultFromMark(foldMark: string | undefined): CalloutFoldDefault {
	// `-` は初期状態を折りたたみにする
	if (foldMark === '-') {
		return 'collapsed';
	}

	// `+` は初期状態を展開にする。記号が無い、または別の文字はこの分岐に入らない
	if (foldMark === '+') {
		return 'expanded';
	}

	return 'none';
}
