/**
 * フェンスとインラインコードの言語名を解釈し、CodeMirror の言語カタログから解決する
 * 未ロードの言語は動的 import を開始し、完了は世代番号と購読者へ通知する。図の描画は持たない
 * mermaid は図描画の対象なので、入れ子言語としては返さない
 * @file
 */
import { LanguageDescription, type Language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { SyntaxNode } from '@lezer/common';

/** `{java}` のように、インラインコード先頭の言語指定に一致するパターン。キャプチャは言語名 */
const INLINE_CODE_LANGUAGE_PATTERN     = /^\{([A-Za-z][\w+#.-]*)\}/;
/** 言語指定の直後にある、プレビューで隠す空白。半角スペースとタブ */
const INLINE_CODE_PREFIX_SPACE_PATTERN = /^[ \t]+/;
/** フェンスの CodeInfo 先頭から言語名として読むパターン */
const FENCED_LANGUAGE_NAME_PATTERN     = /^[A-Za-z][\w+#.-]*/;

/**
 * インラインコード先頭の言語指定と、プレビューで隠す接頭辞の長さ
 * `}` の直後の空白が無いときは、言語指定そのものの長さだけを prefixLength にする
 */
export type InlineCodeLanguagePrefix = {
	/** 波括弧を除いた言語名。大文字小文字は本文のまま */
	language: string;
	/** 本文先頭から隠す文字数。言語指定と、その直後の空白を含む */
	prefixLength: number;
};

/**
 * 言語の動的読み込みが終わったときに呼ぶ関数
 * 引数は無く、再描画のきっかけだけを購読側が持つ
 */
type CodeLanguageReadyListener = () => void;

/** 読み込み完了を待つ購読者。解除するまで残る */
const readyListeners = new Set<CodeLanguageReadyListener>();

/** 読み込み完了のたびに増やす世代番号。0 はまだ通知していない */
let languageGeneration = 0;
/** 同一マイクロタスク内の完了通知を 1 回にまとめる予約フラグ。通知の実行で false に戻る */
let notifyScheduled    = false;

// ==============================================
// 言語名の解釈
// ==============================================

/**
 * フェンス情報文字列から言語名を取り出す
 * @param info - CodeInfo。` ```js title` のように、言語名の後ろに情報があってもよい。空白だけや空文字のときは言語名が無い
 * @returns 先頭の言語名。言語名として読めないときは空文字
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
 * @param content - インラインコード本文。言語指定は先頭だけを見る
 * @returns 言語名と隠す接頭辞の長さ。パターンに一致しないときは null
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

// ==============================================
// インラインコードの本文範囲
// ==============================================

/**
 * InlineCode ノードの本文範囲を返す
 * Lezer の単純な `` `...` `` では CodeText 子が無く、CodeMark だけが並ぶ
 * @param node - InlineCode ノード。子の CodeText または CodeMark から本文を決める
 * @returns 本文の半開区間。CodeText が無いときは最初の CodeMark の直後から最後の CodeMark の直前まで。取れないときは空配列
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

// ==============================================
// 言語の解決と読み込み
// ==============================================

/**
 * 言語名からカタログの LanguageDescription を返す
 * mermaid は図描画対象のため除外する
 * @param name - 言語名。前後の空白は無視する。空文字のときは解決しない
 * @returns カタログ上の説明。mermaid と未知の名前は null
 */
export function resolveCodeLanguage(name: string): LanguageDescription | null {
	const trimmed = name.trim();
	if (!trimmed || trimmed.toLowerCase() === 'mermaid') {
		return null;
	}

	return LanguageDescription.matchLanguageName(languages, trimmed, true);
}

/**
 * フェンスの CodeInfo から入れ子言語を返す
 * 読み込み済みなら Language を返し、未ロードなら LanguageDescription を返して読み込みを開始する
 * @param info - フェンスの CodeInfo。言語名の抽出に使う
 * @returns 読み込み済みの Language、または未ロードの LanguageDescription。言語が無いときは null
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
 * 読み込み済みの言語を返す。未ロードの読み込みは開始しない
 * @param name - 言語名。前後の空白は無視する
 * @returns 既にロードされた Language。未ロードや未知の名前は null
 */
export function getLoadedCodeLanguage(name: string): Language | null {
	return resolveCodeLanguage(name)?.support?.language ?? null;
}

/**
 * 言語の読み込みを開始し、済みなら Language を返す
 * @param name - 言語名。前後の空白は無視する
 * @returns 既にロードされていれば Language。読み込みを開始しただけのとき、または未知の名前は null
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

// ==============================================
// 読み込み完了の通知
// ==============================================

/**
 * 言語カタログの再描画世代を返す
 * 読み込み完了の通知のたびに増え、購読側が前回の描画と比較する
 * @returns 完了通知の回数。まだ通知していないときは 0
 */
export function getCodeLanguageGeneration(): number {
	return languageGeneration;
}

/**
 * 言語読み込み完了を購読する
 * @param listener - 完了のたびに呼ぶ関数。引数は無く、世代の取得は購読側が行う
 * @returns 購読を解除する関数。同じ listener だけを外す
 */
export function subscribeCodeLanguageReady(listener: CodeLanguageReadyListener): () => void {
	readyListeners.add(listener);
	return () => {
		readyListeners.delete(listener);
	};
}

/**
 * 言語読み込み完了の通知を予約する
 * 同じマイクロタスク内の複数完了は 1 回にまとめ、世代番号を 1 だけ増やす
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
