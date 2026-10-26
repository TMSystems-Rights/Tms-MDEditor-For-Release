/**
 * プレビュー行の `#` タグへ mark 装飾を付ける
 * エディタ状態は持たず、コードやリンクの中は構文ノードを見て対象から外す
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { isPreviewLineNumber, collectSourceLineNumbers } from './cursorLine';
import type { DecorationEntry } from './inlineDecorations';

// ----------------------------------------------
// タグ文字の判定
// ----------------------------------------------

/**
 * タグ本文の文字、結合文字、数字、`_`、`-`
 * `/` と非 ASCII の記号は別の条件で見る。実行中は変えない
 */
const TAG_TEXT_CHARACTER = /^[\p{L}\p{M}\p{N}_-]$/u;

/**
 * Unicode の記号
 * ASCII より大きい文字のときだけ、タグ本文へ追加できるかの条件に使う
 */
const UNICODE_SYMBOL = /^\p{S}$/u;

/**
 * Unicode の句読点
 * 日本語のかっこなどをタグ本文へ含めるための条件
 */
const UNICODE_PUNCTUATION = /^\p{P}$/u;

/**
 * Unicode の数字
 * 数字だけのタグを除外する判定に使う。`/` はこの文字クラスに含めない
 */
const NUMERIC_CHARACTER = /^\p{N}$/u;

/**
 * タグとして装飾しない構文ノード名
 * コード、リンク、HTML、フロントマターの中の `#` はタグにしない
 */
const TAG_EXCLUDED_NODE_NAMES = new Set(['Autolink', 'CodeBlock', 'FencedCode', 'HTMLBlock', 'HTMLTag', 'Image', 'InlineCode', 'Link', 'WikiEmbed', 'WikiLink', 'YamlFrontMatter']);

/**
 * タグ本文に利用できる文字かを判定する
 * ASCII 記号は `_`、`-`、`/` のみ。Unicode の句読点と記号は、ASCII より大きいときだけ許可する
 * @param character - 判定する 1 文字。サロゲートペアを含む Unicode 文字
 * @returns タグ本文に続けられるなら true
 */
function isTagCharacter(character: string): boolean {
	// 階層区切りのスラッシュは、ASCII 記号でも本文に続ける
	if (character === '/') {
		return true;
	}

	// 文字、結合文字、数字、`_`、`-` は本文にできる
	if (TAG_TEXT_CHARACTER.test(character)) {
		return true;
	}

	return (character.codePointAt(0) ?? 0) > 0x7f && (UNICODE_SYMBOL.test(character) || UNICODE_PUNCTUATION.test(character));
}

/**
 * `#` がバックスラッシュでエスケープされているかを判定する
 * 直前の `\` が奇数個のときだけエスケープとみなす
 * @param lineText - 判定する行のテキスト。文書全体ではない
 * @param hashIndex - `#` の UTF-16 位置。行頭なら 0
 * @returns エスケープされていれば true
 */
function isEscapedHash(lineText: string, hashIndex: number): boolean {
	// `#` の直前に続くバックスラッシュの個数。0 ならエスケープではない
	let slashCount = 0;
	for (let index = hashIndex - 1; index >= 0 && lineText[index] === '\\'; index -= 1) {
		slashCount += 1;
	}

	return slashCount % 2 === 1;
}

/**
 * タグ開始位置が、単語や別タグの途中ではないかを判定する
 * 直前が `#` またはタグ本文文字なら、新しいタグの境界ではない
 * @param lineText - 判定する行のテキスト
 * @param hashIndex - `#` の UTF-16 位置。行頭なら境界として認める
 * @returns タグを始めてよい位置なら true
 */
function hasTagBoundary(lineText: string, hashIndex: number): boolean {
	// 行頭の `#` は単語の途中ではないので、新しいタグを始めてよい
	if (hashIndex === 0) {
		return true;
	}

	// `#` の直前の1文字。取れなければ空文字で、境界として扱う
	const previous = Array.from(lineText.slice(0, hashIndex)).at(-1) ?? '';
	return previous !== '#' && !isTagCharacter(previous);
}

/**
 * タグ候補に、数字以外の文字が含まれるかを判定する
 * `/` は階層区切りのため、この条件を満たす文字には数えない
 * @param body - `#` を除いたタグ本文
 * @returns 数字と `/` 以外の文字が 1 つでもあれば true
 */
function hasNonNumericTagCharacter(body: string): boolean {
	return Array.from(body).some((character) => character !== '/' && !NUMERIC_CHARACTER.test(character));
}

/**
 * タグ位置が、コードやリンクなどの除外構文の中かを判定する
 * 内側のノードから親へたどり、除外名が 1 つでもあれば対象外にする
 * @param state - 構文木を読むエディタ状態。文書は変えない
 * @param position - `#` の文書上の文字位置
 * @returns 除外構文の中なら true
 */
function isExcludedSyntaxPosition(state: EditorState, position: number): boolean {
	// 位置の最も内側のノード。親をたどり、根の先は null
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, 1);
	while (node) {
		// コードやリンクなどの除外名に当たった時点で、タグにしない
		if (TAG_EXCLUDED_NODE_NAMES.has(node.name)) {
			return true;
		}

		node = node.parent;
	}

	return false;
}

// ----------------------------------------------
// 行からの収集
// ----------------------------------------------

/**
 * 1 行からタグの mark 装飾を集め、渡された配列へ足す
 * エスケープ、境界、除外構文、数字だけ、先頭スラッシュは装飾しない
 * @param state - 除外構文の判定に使うエディタ状態
 * @param lineText - 走査する行のテキスト
 * @param lineFrom - その行の文書上の開始位置。タグ位置へ足す
 * @param entries - 装飾を追加する配列。見つかったタグを末尾へ push する
 */
function collectTagsFromLine(state: EditorState, lineText: string, lineFrom: number, entries: DecorationEntry[]): void {
	// 行内の次の `#` の UTF-16 位置。無ければ -1 で走査を終える
	let hashIndex = lineText.indexOf('#');
	while (hashIndex >= 0) {
		// エスケープでなく、境界があり、除外構文の外であるときだけ本文を読む。どれか一つが欠けてもタグにしない
		if (!isEscapedHash(lineText, hashIndex) && hasTagBoundary(lineText, hashIndex) && !isExcludedSyntaxPosition(state, lineFrom + hashIndex)) {
			// 本文の終端。行内の UTF-16 位置。`#` の直後から、使えない文字の手前まで
			let bodyTo = hashIndex + 1;
			for (const character of lineText.slice(bodyTo)) {
				// 本文に使えない文字でタグを打ち切る
				if (!isTagCharacter(character)) {
					break;
				}

				bodyTo += character.length;
			}

			// `#` を除いた本文。空ならタグにしない
			const body = lineText.slice(hashIndex + 1, bodyTo);
			// 本文があり、先頭が `/` でなく、数字以外の文字もあるときだけ装飾する。どれか一つが欠けても mark を足さない
			if (body.length > 0 && !body.startsWith('/') && hasNonNumericTagCharacter(body)) {
				// この `#` から本文末までをタグ色にする mark
				entries.push({
					// タグの開始。行頭からの `#` 位置を文書位置へ足したもの
					from: lineFrom + hashIndex,
					// 本文の終端。文書上の文字位置
					to: lineFrom + bodyTo,
					// タグ用の mark。範囲の文字は残す
					decoration: Decoration.mark({ class: 'cm-md-tag' })
				});
			}
		}

		hashIndex = lineText.indexOf('#', hashIndex + 1);
	}
}

/**
 * ライブプレビュー行のタグ装飾を集める
 * ソース表示の行はスキップする。省略時は現在の選択からソース行を求める
 * @param state - 文書と構文木を読むエディタ状態。装飾は戻り値で返し、状態は変えない
 * @param sourceLineNumbers - ソース表示の行番号。1 始まり。省略時は選択から作る
 * @returns タグ範囲の mark 装飾。該当が無ければ空
 */
export function collectTagDecorationEntries(state: EditorState, sourceLineNumbers: Set<number> = collectSourceLineNumbers(state)): DecorationEntry[] {
	// 集めたタグの mark。該当が無ければ空配列
	const entries: DecorationEntry[] = [];

	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		// ソース表示の行はタグ装飾を足さない
		if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
			continue;
		}

		// プレビュー行。from はタグ位置へ足す文書上の開始
		const line = state.doc.line(lineNumber);
		collectTagsFromLine(state, line.text, line.from, entries);
	}

	return entries;
}
