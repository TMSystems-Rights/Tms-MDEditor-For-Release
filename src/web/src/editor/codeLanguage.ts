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
	// 前後の空白を除いた CodeInfo。空白だけなら空文字で、言語名が無い
	const trimmed = info.trim();
	// 空なら言語名を読まない。パターンへ空文字を渡さない
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
	// `{言語名}` に一致した先頭。形が違えば null
	const match = INLINE_CODE_LANGUAGE_PATTERN.exec(content);
	// 言語指定の形でなければ、隠す接頭辞は無い
	if (!match) {
		return null;
	}

	// 言語指定の直後。ここから空白だけを隠す対象にする。無ければ空文字
	const afterLang = content.slice(match[0].length);
	// 直後の半角スペースとタブの文字数。空白が無ければ 0 で、隠す長さは言語指定だけ
	const spaces    = INLINE_CODE_PREFIX_SPACE_PATTERN.exec(afterLang)?.[0].length ?? 0;

	// 言語名と、プレビューが隠す文字数
	return {
		// 波括弧を除いた言語名。大文字小文字は本文のまま
		language: match[1],
		// 本文先頭から隠す文字数。言語指定と、その直後の空白を含む
		prefixLength: match[0].length + spaces
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
	// 開始側バッククォートの終端。まだ見ていなければ null で、本文の開始が決まらない
	let firstMarkEnd: number | null                           = null;
	// 最後に見たバッククォートの開始。終了マークが無ければ null
	let lastMarkStart: number | null                          = null;
	// CodeText 子の本文範囲。1 つでもあれば、マークからの推定は使わない
	const codeTextRanges: Array<{ from: number; to: number }> = [];

	node.cursor().iterate((child) => {
		// バッククォート。最初の一つだけ終端を覚え、最後に見たものの開始を終了側にする
		if (child.name === 'CodeMark') {
			// まだ開始マークを見ていないときだけ終端を記録する。2 つ目以降は終了側の開始だけを更新する
			if (firstMarkEnd === null) {
				// 開始のバッククォートの直後。本文はこの位置から
				firstMarkEnd = child.to;
			}

			// いま見たマークの先頭。最後に見たものが終了マークの開始になる
			lastMarkStart = child.from;
			return;
		}

		// 本文ノード。単純なインラインコードでは現れないことがある
		if (child.name === 'CodeText') {
			// CodeText の半開区間。文書オフセット
			codeTextRanges.push({
				// 本文先頭（文書オフセット、含む）
				from: child.from,
				// 本文末尾（文書オフセット、含まない）
				to: child.to
			});
		}
	});

	// CodeText が 1 つでもあれば、その範囲だけを本文にする。マークからの推定は使わない
	if (codeTextRanges.length > 0) {
		return codeTextRanges;
	}

	// 開始か終了のマークが無い、または開始直後が終了マーク以上なら本文が空。いずれか一つでも空配列
	if (firstMarkEnd === null || lastMarkStart === null || firstMarkEnd >= lastMarkStart) {
		return [];
	}

	// 開始マークの直後から、終了マークの直前まで
	return [
		{
			// 本文先頭（文書オフセット、含む）
			from: firstMarkEnd,
			// 本文末尾（文書オフセット、含まない）
			to: lastMarkStart
		}
	];
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
	// 前後の空白を除いた言語名。空なら解決しない
	const trimmed = name.trim();
	// 空、または mermaid なら入れ子言語にしない。mermaid は図描画の対象。どちらか一方でも null
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
	// カタログ上の説明。未知の名前や mermaid は null
	const description = resolveCodeLanguage(extractCodeLanguageName(info));
	// 言語が無ければ読み込みも始めない
	if (!description) {
		return null;
	}

	// 未ロードのときだけ動的 import を始める。済みなら読み込みを重ねない
	if (!description.support) {
		// 読み込みが終わったら再描画を予約する。失敗時は通知せず単色のまま
		void description
			.load()
			.then(() => {
				scheduleCodeLanguageReady();
			})
			.catch(() => {
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
	// カタログ上の説明。未知の名前や mermaid は null
	const description = resolveCodeLanguage(name);
	// 言語が無ければ読み込みを始めず、null を返す
	if (!description) {
		return null;
	}

	// 既にロード済みなら、その Language を返す。読み込みは始めない
	if (description.support) {
		return description.support.language;
	}

	// 未ロードなら読み込みを始め、この場では null。成功したときだけ再描画を予約する
	void description
		.load()
		.then(() => {
			scheduleCodeLanguageReady();
		})
		.catch(() => {
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
	// 完了のたびにこの listener を呼ぶ。解除まで集合に残す
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
	// 同じマイクロタスクで既に予約済みなら、世代を二重に増やさない
	if (notifyScheduled) {
		return;
	}

	// この予約が走るまで、追加の完了は通知を足さない
	notifyScheduled = true;
	// このマイクロタスクの終わりに、購読者へ 1 回だけ通知する
	queueMicrotask(() => {
		// 予約を消化した。次の完了は改めて予約できる
		notifyScheduled     = false;
		// 購読側が前回描画と比較する世代。この通知で 1 だけ増やす
		languageGeneration += 1;
		for (const listener of [...readyListeners]) {
			listener();
		}
	});
}
