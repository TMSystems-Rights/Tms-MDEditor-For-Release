import type { Language } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { tmsHighlightStyle } from './markdownHighlightStyle';
import {
	parseInlineCodeLanguagePrefix,
	requestCodeLanguage,
	resolveCodeLanguage,
} from './codeLanguage';

export type CodeHighlightRange = {
	from: number;
	to: number;
	className: string;
};

/**
 * コード文字列を言語パーサでトークン範囲へ分解する
 * @param {string} code コード
 * @param {Language} language 言語
 * @returns {CodeHighlightRange[]}
 */
export function collectCodeHighlightRanges(code: string, language: Language): CodeHighlightRange[] {
	if (!code) {
		return [];
	}

	const tree                         = language.parser.parse(code);
	const ranges: CodeHighlightRange[] = [];
	highlightTree(tree, tmsHighlightStyle, (from, to, className) => {
		if (from < to && className) {
			ranges.push({ from, to, className });
		}
	});
	return ranges;
}

/**
 * インラインコード本文から言語指定とその直後空白を除いたコードを返す
 * @param {string} content インラインコード本文
 * @returns {{ language: string; code: string; prefixLength: number } | null}
 */
export function splitInlineCodeLanguageContent(
	content: string,
): { language: string; code: string; prefixLength: number } | null {
	const prefix = parseInlineCodeLanguagePrefix(content);
	if (!prefix) {
		return null;
	}

	return {
		language    : prefix.language,
		prefixLength: prefix.prefixLength,
		code        : content.slice(prefix.prefixLength),
	};
}

/**
 * ハイライト済みのコードテキストを DOM へ追加する
 * 言語未ロードなら読み込みを開始し、本文は単色で出す
 * @param {HTMLElement} parent 親要素
 * @param {string} content インラインコード本文（`{java}` 付き可）
 * @returns {void}
 */
export function appendHighlightedInlineCode(parent: HTMLElement, content: string): void {
	const split = splitInlineCodeLanguageContent(content);
	if (!split || !resolveCodeLanguage(split.language)) {
		parent.appendChild(parent.ownerDocument.createTextNode(content));
		return;
	}

	const language = requestCodeLanguage(split.language);
	if (!language) {
		if (split.code) {
			parent.appendChild(parent.ownerDocument.createTextNode(split.code));
		}

		return;
	}

	appendHighlightedCodeText(parent, split.code, language);
}

/**
 * 読み込み済み言語でコードをトークン span として追加する
 * @param {HTMLElement} parent 親要素
 * @param {string} code コード
 * @param {Language} language 言語
 * @returns {void}
 */
export function appendHighlightedCodeText(
	parent: HTMLElement,
	code: string,
	language: Language,
): void {
	if (!code) {
		return;
	}

	const ranges = collectCodeHighlightRanges(code, language);
	let cursor   = 0;
	const doc    = parent.ownerDocument;
	for (const range of ranges) {
		if (range.from > cursor) {
			parent.appendChild(doc.createTextNode(code.slice(cursor, range.from)));
		}

		const span       = doc.createElement('span');
		span.className   = range.className;
		span.textContent = code.slice(range.from, range.to);
		parent.appendChild(span);
		cursor = range.to;
	}

	if (cursor < code.length) {
		parent.appendChild(doc.createTextNode(code.slice(cursor)));
	}
}
