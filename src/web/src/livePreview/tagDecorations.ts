import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { isPreviewLineNumber, collectSourceLineNumbers } from './cursorLine';
import type { DecorationEntry } from './inlineDecorations';

const TAG_TEXT_CHARACTER  = /^[\p{L}\p{M}\p{N}_-]$/u;
const UNICODE_SYMBOL      = /^\p{S}$/u;
const UNICODE_PUNCTUATION = /^\p{P}$/u;
const NUMERIC_CHARACTER   = /^\p{N}$/u;

const TAG_EXCLUDED_NODE_NAMES = new Set([
	'Autolink',
	'CodeBlock',
	'FencedCode',
	'HTMLBlock',
	'HTMLTag',
	'Image',
	'InlineCode',
	'Link',
	'WikiEmbed',
	'WikiLink',
	'YamlFrontMatter',
]);

/**
 * タグ本文に利用できる文字か判定する。
 * ASCII 記号は `_` `-` `/` のみ、Unicode の句読点・記号は許可する。
 * @param {string} character 1 Unicode 文字
 * @returns {boolean}
 */
function isTagCharacter(character: string): boolean {
	if (character === '/') {
		return true;
	}

	if (TAG_TEXT_CHARACTER.test(character)) {
		return true;
	}

	return (character.codePointAt(0) ?? 0) > 0x7f
		&& (UNICODE_SYMBOL.test(character) || UNICODE_PUNCTUATION.test(character));
}

/**
 * `#` がバックスラッシュでエスケープされているか判定する。
 * @param {string} lineText 行テキスト
 * @param {number} hashIndex `#` の UTF-16 位置
 * @returns {boolean}
 */
function isEscapedHash(lineText: string, hashIndex: number): boolean {
	let slashCount = 0;
	for (let index = hashIndex - 1; index >= 0 && lineText[index] === '\\'; index -= 1) {
		slashCount += 1;
	}

	return slashCount % 2 === 1;
}

/**
 * タグ開始位置が単語や別タグの途中ではないか判定する。
 * @param {string} lineText 行テキスト
 * @param {number} hashIndex `#` の UTF-16 位置
 * @returns {boolean}
 */
function hasTagBoundary(lineText: string, hashIndex: number): boolean {
	if (hashIndex === 0) {
		return true;
	}

	const previous = Array.from(lineText.slice(0, hashIndex)).at(-1) ?? '';
	return previous !== '#' && !isTagCharacter(previous);
}

/**
 * タグ候補に数字以外の文字が含まれるか判定する。
 * `/` は階層区切りのため、この条件を満たす文字には数えない。
 * @param {string} body `#` を除いたタグ本文
 * @returns {boolean}
 */
function hasNonNumericTagCharacter(body: string): boolean {
	return Array.from(body).some((character) => (
		character !== '/' && !NUMERIC_CHARACTER.test(character)
	));
}

/**
 * タグ位置がコードやリンクなどの除外構文内か判定する。
 * @param {EditorState} state エディタ状態
 * @param {number} position 文書位置
 * @returns {boolean}
 */
function isExcludedSyntaxPosition(state: EditorState, position: number): boolean {
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, 1);
	while (node) {
		if (TAG_EXCLUDED_NODE_NAMES.has(node.name)) {
			return true;
		}

		node = node.parent;
	}

	return false;
}

/**
 * 1 行からタグ Decoration を収集する。
 * @param {EditorState} state エディタ状態
 * @param {string} lineText 行テキスト
 * @param {number} lineFrom 行開始位置
 * @param {DecorationEntry[]} entries 追加先
 * @returns {void}
 */
function collectTagsFromLine(
	state: EditorState,
	lineText: string,
	lineFrom: number,
	entries: DecorationEntry[],
): void {
	let hashIndex = lineText.indexOf('#');
	while (hashIndex >= 0) {
		if (
			!isEscapedHash(lineText, hashIndex)
			&& hasTagBoundary(lineText, hashIndex)
			&& !isExcludedSyntaxPosition(state, lineFrom + hashIndex)
		) {
			let bodyTo = hashIndex + 1;
			for (const character of lineText.slice(bodyTo)) {
				if (!isTagCharacter(character)) {
					break;
				}

				bodyTo += character.length;
			}

			const body = lineText.slice(hashIndex + 1, bodyTo);
			if (
				body.length > 0
				&& !body.startsWith('/')
				&& hasNonNumericTagCharacter(body)
			) {
				entries.push({
					from      : lineFrom + hashIndex,
					to        : lineFrom + bodyTo,
					decoration: Decoration.mark({ class: 'cm-md-tag' }),
				});
			}
		}

		hashIndex = lineText.indexOf('#', hashIndex + 1);
	}
}

/**
 * ライブプレビュー行のタグ Decoration を収集する。
 * @param {EditorState} state エディタ状態
 * @param {Set<number>} [sourceLineNumbers] ソース表示行番号
 * @returns {DecorationEntry[]}
 */
export function collectTagDecorationEntries(
	state: EditorState,
	sourceLineNumbers: Set<number> = collectSourceLineNumbers(state),
): DecorationEntry[] {
	const entries: DecorationEntry[] = [];

	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
			continue;
		}

		const line = state.doc.line(lineNumber);
		collectTagsFromLine(state, line.text, line.from, entries);
	}

	return entries;
}
