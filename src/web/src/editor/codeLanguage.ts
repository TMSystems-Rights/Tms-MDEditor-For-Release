import { LanguageDescription, type Language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { SyntaxNode } from '@lezer/common';

const INLINE_CODE_LANGUAGE_PATTERN     = /^\{([A-Za-z][\w+#.-]*)\}/;
const INLINE_CODE_PREFIX_SPACE_PATTERN = /^[ \t]+/;
const FENCED_LANGUAGE_NAME_PATTERN     = /^[A-Za-z][\w+#.-]*/;

export type InlineCodeLanguagePrefix = {
	language: string;
	prefixLength: number;
};

type CodeLanguageReadyListener = () => void;

const readyListeners = new Set<CodeLanguageReadyListener>();

let languageGeneration = 0;
let notifyScheduled    = false;

/**
 * フェンス情報文字列から言語名を取り出す
 * @param {string} info CodeInfo（` ```js title` など）
 * @returns {string}
 */
export function extractCodeLanguageName(info: string): string {
	const trimmed = info.trim();
	if (!trimmed) {
		return '';
	}

	return FENCED_LANGUAGE_NAME_PATTERN.exec(trimmed)?.[0] ?? '';
}

/**
 * インラインコード本文先頭の `{java}` を解釈する
 * `}` 直後のスペースは不要。ある場合は prefixLength に含める（プレビューで隠すため）
 * @param {string} content インラインコード本文
 * @returns {InlineCodeLanguagePrefix | null}
 */
export function parseInlineCodeLanguagePrefix(content: string): InlineCodeLanguagePrefix | null {
	const match = INLINE_CODE_LANGUAGE_PATTERN.exec(content);
	if (!match) {
		return null;
	}

	const afterLang = content.slice(match[0].length);
	const spaces    = INLINE_CODE_PREFIX_SPACE_PATTERN.exec(afterLang)?.[0].length ?? 0;

	return {
		language    : match[1],
		prefixLength: match[0].length + spaces,
	};
}

/**
 * InlineCode ノードの本文範囲を返す
 * Lezer の単純な \`...\` では CodeText 子が無く、CodeMark だけが並ぶ
 * @param {SyntaxNode} node InlineCode ノード
 * @returns {Array<{ from: number; to: number }>}
 */
export function collectInlineCodeContentRanges(node: SyntaxNode): Array<{ from: number; to: number }> {
	let firstMarkEnd: number | null                           = null;
	let lastMarkStart: number | null                          = null;
	const codeTextRanges: Array<{ from: number; to: number }> = [];

	node.cursor().iterate((child) => {
		if (child.name === 'CodeMark') {
			if (firstMarkEnd === null) {
				firstMarkEnd = child.to;
			}

			lastMarkStart = child.from;
			return;
		}

		if (child.name === 'CodeText') {
			codeTextRanges.push({ from: child.from, to: child.to });
		}
	});

	if (codeTextRanges.length > 0) {
		return codeTextRanges;
	}

	if (firstMarkEnd === null || lastMarkStart === null || firstMarkEnd >= lastMarkStart) {
		return [];
	}

	return [{ from: firstMarkEnd, to: lastMarkStart }];
}

/**
 * 言語名からカタログの LanguageDescription を返す
 * mermaid は図描画対象のため除外する
 * @param {string} name 言語名
 * @returns {LanguageDescription | null}
 */
export function resolveCodeLanguage(name: string): LanguageDescription | null {
	const trimmed = name.trim();
	if (!trimmed || trimmed.toLowerCase() === 'mermaid') {
		return null;
	}

	return LanguageDescription.matchLanguageName(languages, trimmed, true);
}

/**
 * フェンス CodeInfo から入れ子言語を返す
 * 読み込み済みなら Language を返し、未ロードなら LanguageDescription を返す
 * @param {string} info CodeInfo
 * @returns {Language | LanguageDescription | null}
 */
export function resolveFencedCodeLanguage(info: string): Language | LanguageDescription | null {
	const description = resolveCodeLanguage(extractCodeLanguageName(info));
	if (!description) {
		return null;
	}

	if (!description.support) {
		void description.load().then(() => {
			scheduleCodeLanguageReady();
		}).catch(() => {
			// 未対応チャンクや動的 import 失敗では単色のままにする
		});
	}

	return description.support?.language ?? description;
}

/**
 * 読み込み済み言語を返す
 * @param {string} name 言語名
 * @returns {Language | null}
 */
export function getLoadedCodeLanguage(name: string): Language | null {
	return resolveCodeLanguage(name)?.support?.language ?? null;
}

/**
 * 言語の読み込みを開始し、済みなら Language を返す
 * @param {string} name 言語名
 * @returns {Language | null}
 */
export function requestCodeLanguage(name: string): Language | null {
	const description = resolveCodeLanguage(name);
	if (!description) {
		return null;
	}

	if (description.support) {
		return description.support.language;
	}

	void description.load().then(() => {
		scheduleCodeLanguageReady();
	}).catch(() => {
		// 未対応チャンクや動的 import 失敗では単色のままにする
	});

	return null;
}

/**
 * 言語カタログ再描画世代を返す
 * @returns {number}
 */
export function getCodeLanguageGeneration(): number {
	return languageGeneration;
}

/**
 * 言語読み込み完了を購読する
 * @param {CodeLanguageReadyListener} listener コールバック
 * @returns {() => void} 解除関数
 */
export function subscribeCodeLanguageReady(listener: CodeLanguageReadyListener): () => void {
	readyListeners.add(listener);
	return () => {
		readyListeners.delete(listener);
	};
}

/**
 * 言語読み込み完了通知を予約する
 * @returns {void}
 */
function scheduleCodeLanguageReady(): void {
	if (notifyScheduled) {
		return;
	}

	notifyScheduled = true;
	queueMicrotask(() => {
		notifyScheduled     = false;
		languageGeneration += 1;
		for (const listener of [...readyListeners]) {
			listener();
		}
	});
}
