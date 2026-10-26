/**
 * インラインコードとコード本文を、言語パーサのトークンへ分解して DOM に載せる
 * 言語の解決と読み込み開始は codeLanguage に任せ、本ファイルは範囲の収集と span の追加だけを持つ
 * @file
 */
import type { Language } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { tmsHighlightStyle } from './markdownHighlightStyle';
import { parseInlineCodeLanguagePrefix, requestCodeLanguage, resolveCodeLanguage } from './codeLanguage';

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
	// 空文字はパーサに渡さない。色付き範囲は無い
	if (!code) {
		return [];
	}

	// 言語パーサが切った構文木。色はこの木のトークンから取る
	const tree                         = language.parser.parse(code);
	// 色が付いたトークンだけ。空き区間は入れず、該当が無ければ空のまま
	const ranges: CodeHighlightRange[] = [];
	// 色と幅があるトークンだけを積む。class が空、または幅が 0 の通知は捨てる
	highlightTree(tree, tmsHighlightStyle, (from, to, className) => {
		// 幅があり、かつ class があるときだけ範囲にする。どちらか一方が欠けると装飾しない
		if (from < to && className) {
			ranges.push({
				// トークン先頭（コード文字列内オフセット、含む）
				from,
				// トークン末尾（コード文字列内オフセット、含まない）
				to,
				// このトークンに付く class。テーマの色はこの名前へ当たる
				className
			});
		}
	});
	return ranges;
}

/**
 * インラインコード本文から言語指定と、その直後の空白を除いたコードを返す
 * @param content - バッククォートの内側。先頭に言語指定が無いときは分割しない
 * @returns 言語名、隠す接頭辞の文字数、言語指定を除いたコード。言語指定が無いときは null
 */
export function splitInlineCodeLanguageContent(content: string): { language: string; code: string; prefixLength: number } | null {
	// `{言語}` と、直後の空白を含む接頭辞。パターンでなければ null
	const prefix = parseInlineCodeLanguagePrefix(content);
	// 言語指定が無い本文は分割しない
	if (!prefix) {
		return null;
	}

	// 言語指定を除いたあとにハイライトする部分。接頭辞の長さはプレビューが隠す文字数
	return {
		// 波括弧を除いた言語名。大文字小文字は本文のまま
		language: prefix.language,
		// 本文先頭から隠す文字数。言語指定と、その直後の空白を含む
		prefixLength: prefix.prefixLength,
		// 言語指定と直後の空白を除いたコード。指定だけなら空文字で、トークンは出さない
		code: content.slice(prefix.prefixLength)
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
	// 言語指定と、それを除いたコード。指定が無ければ null で、本文全体を単色のまま出す
	const split = splitInlineCodeLanguageContent(content);
	// 言語指定が無い、またはカタログに無い言語名なら、接頭辞も含めて本文をそのまま出す。どちらか一方でも分割しない
	if (!split || !resolveCodeLanguage(split.language)) {
		parent.appendChild(parent.ownerDocument.createTextNode(content));
		return;
	}

	// 読み込み済みの言語。未ロードなら読み込みを始め、この場では null
	const language = requestCodeLanguage(split.language);
	// まだ言語が無いときは、言語指定を除いたコードだけを単色で出す。色分けは読み込み完了後の再描画に任せる
	if (!language) {
		// 除いたあとに文字があるときだけテキストを足す。言語指定だけのインラインコードは空のまま
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
export function appendHighlightedCodeText(parent: HTMLElement, code: string, language: Language): void {
	// 空文字はノードを足さない
	if (!code) {
		return;
	}

	// 色付きトークンの範囲。空き区間は含まれない
	const ranges = collectCodeHighlightRanges(code, language);
	// まだノードにしていない先頭（コード文字列内オフセット）。0 から始まり、出力したトークンの末尾まで進む
	let cursor   = 0;
	// テキストと span を作る文書。parent の所属文書で、別文書のノードを足さない
	const doc    = parent.ownerDocument;
	for (const range of ranges) {
		// トークンの前に色の無い区間があるとき、その文字列をそのまま出す。隙間が無いときはテキストノードを足さない
		if (range.from > cursor) {
			parent.appendChild(doc.createTextNode(code.slice(cursor, range.from)));
		}

		// 色付きトークンを包む要素。色の無い区間はこちらへ入れない
		const span       = doc.createElement('span');
		// ハイライト style の class。テーマのトークン色はこの名前へ当たる
		span.className   = range.className;
		// このトークンの文字列。前後の空き区間は含めない
		span.textContent = code.slice(range.from, range.to);
		parent.appendChild(span);
		// 次の空き区間の開始。このトークンの末尾まで出力済み
		cursor = range.to;
	}

	// 最後のトークンより後ろに文字が残るとき、その文字列を出す。トークンが末尾までなら足さない
	if (cursor < code.length) {
		parent.appendChild(doc.createTextNode(code.slice(cursor)));
	}
}
