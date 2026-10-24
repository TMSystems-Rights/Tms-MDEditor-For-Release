/**
 * インラインコードとコード本文を、言語パーサのトークンへ分解して DOM に載せる
 * 言語の解決と読み込み開始は codeLanguage に任せ、本ファイルは範囲の収集と span の追加だけを持つ
 * @file
 */
import type { Language } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { tmsHighlightStyle } from './markdownHighlightStyle';
import {
	parseInlineCodeLanguagePrefix,
	requestCodeLanguage,
	resolveCodeLanguage,
} from './codeLanguage';

/**
 * ハイライト対象の半開区間と、付ける class 名
 * 言語パーサが色を付けた範囲だけを含み、空き区間は含まない
 */
export type CodeHighlightRange = {
	/** トークン先頭の、コード文字列内オフセット（含む） */
	from: number;
	/** トークン末尾の、コード文字列内オフセット（含まない） */
	to: number;
	/** ハイライト style が付けた class。空のトークンは範囲にしない */
	className: string;
};

// ----------------------------------------------
// 範囲の収集
// ----------------------------------------------

/**
 * コード文字列を言語パーサで走査し、色付きトークンの範囲を返す
 * @param code - ハイライトするコード。空文字のときは走査しない
 * @param language - トークン分割に使う読み込み済み言語
 * @returns 色付きトークンの範囲。空文字のときは空配列
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
 * インラインコード本文から言語指定と、その直後の空白を除いたコードを返す
 * @param content - バッククォートの内側。先頭に言語指定が無いときは分割しない
 * @returns 言語名、隠す接頭辞の文字数、言語指定を除いたコード。言語指定が無いときは null
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

// ----------------------------------------------
// DOM への追加
// ----------------------------------------------

/**
 * ハイライト済みのコードを DOM へ追加する
 * 言語未ロードなら読み込みを開始し、本文は単色のテキストのまま出す。言語指定が無いときは本文全体をそのまま出す
 * @param parent - テキストと span を追加する親要素
 * @param content - インラインコード本文。`{java}` 付きでもよい
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
 * 色が付かない区間は、元の文字列のテキストノードのまま残す
 * @param parent - span とテキストを追加する親要素
 * @param code - 言語指定を除いたコード。空文字のときは何も追加しない
 * @param language - トークン分割に使う読み込み済み言語
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
