/**
 * 表示中のインラインコードへ、言語トークンの装飾を付ける
 * 言語の解決と読み込み開始は codeLanguage に任せ、本ファイルは表示範囲の装飾と、読み込み完了後の再構築だけを持つ
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { StateEffect, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { collectInlineCodeContentRanges, requestCodeLanguage, resolveCodeLanguage, subscribeCodeLanguageReady } from './codeLanguage';
import { collectCodeHighlightRanges, splitInlineCodeLanguageContent } from './codeHighlight';
import { buildDecorationSet, type DecorationEntry } from '../livePreview/inlineDecorations';

/**
 * 言語チャンクの読み込み後に、インラインコード装飾を再構築させる Effect
 * 値は常に null。通知そのものが再構築の合図である
 */
export const codeLanguageReadyEffect = StateEffect.define<null>();

// ----------------------------------------------
// 装飾の収集
// ----------------------------------------------

/**
 * 表示中のインライン `{lang}` コードへ、トークン装飾のエントリを集める
 * 言語が未ロードなら読み込みを開始し、その場のエントリには含めない
 * @param state - 構文木を持つ文書
 * @param from - 走査開始の文書オフセット（含む）
 * @param to - 走査終了の文書オフセット（含まない）
 * @returns 色付きトークンの装飾。言語指定が無い、または未ロードのインラインコードは含めない
 */
export function collectInlineCodeHighlightEntries(state: EditorState, from: number, to: number): DecorationEntry[] {
	const entries: DecorationEntry[] = [];

	syntaxTree(state).iterate({
		from,
		to,
		/**
		 * InlineCode の言語指定をトークン装飾へ展開し、そのノードの子は走査しない
		 * @param ref - 走査中のノード
		 * @param ref.name - Lezer のノード名。InlineCode 以外は無視する
		 * @param ref.node - 本文範囲を取る構文ノード
		 * @returns InlineCode を処理したとき false。それ以外は未指定で探索を続ける
		 */
		enter(ref) {
			// InlineCode 以外は子を歩き続ける。言語指定はインラインコードの中だけを見る
			if (ref.name !== 'InlineCode') {
				return;
			}

			for (const range of collectInlineCodeContentRanges(ref.node)) {
				// バッククォートの内側。言語指定が先頭に無ければ分割しない
				const content = state.doc.sliceString(range.from, range.to);
				// 言語名と、それを除いたコード。指定が無ければ null
				const split   = splitInlineCodeLanguageContent(content);
				// 言語指定が無い、またはカタログに無い名前なら装飾しない。どちらか一方でもこの本文は飛ばす
				if (!split || !resolveCodeLanguage(split.language)) {
					continue;
				}

				// 読み込み済みの言語。未ロードなら読み込みを始め、この場では null
				const language = requestCodeLanguage(split.language);
				// 言語がまだ無い、または言語指定を除くと空ならトークンを出さない。どちらか一方でも装飾しない
				if (!language || !split.code) {
					continue;
				}

				// 言語指定を除いたコードの文書上の開始（文字）。接頭辞の分だけ本文の先頭からずらす
				const codeFrom = range.from + split.prefixLength;
				for (const token of collectCodeHighlightRanges(split.code, language)) {
					// 文書上のトークン範囲と、色の class。コード文字列内の位置は codeFrom で文書位置へずらす
					entries.push({
						// トークン先頭（文書オフセット、含む）
						from: codeFrom + token.from,
						// トークン末尾（文書オフセット、含まない）
						to: codeFrom + token.to,
						// ハイライト style の class を付けるマーク装飾
						decoration: Decoration.mark({ class: token.className })
					});
				}
			}

			return false;
		}
	});

	return entries;
}

/**
 * 表示範囲のインラインコードハイライトを DecorationSet にする
 * @param view - 表示範囲を持つビュー。visibleRanges の外は含めない
 * @returns 表示中トークンの装飾。該当が無いときは空
 */
function buildInlineCodeHighlightDecorations(view: EditorView): DecorationSet {
	const entries: DecorationEntry[] = [];
	for (const visible of view.visibleRanges) {
		entries.push(...collectInlineCodeHighlightEntries(view.state, visible.from, visible.to));
	}

	return buildDecorationSet(entries);
}

// ----------------------------------------------
// 読み込み完了後の再描画
// ----------------------------------------------

/**
 * 言語読み込み完了で再描画 Effect を送るプラグインを返す
 * @returns 購読と解除をビューの寿命に合わせる Extension
 */
function createCodeLanguageReadyListener(): Extension {
	return ViewPlugin.fromClass(
		/** 言語読み込み完了を購読し、接続中のビューへ再描画 Effect を送る。購読の解除は destroy までこのインスタンスが持つ */ class CodeLanguageReadyListener {
			/** 言語読み込み完了の購読解除。プラグイン破棄まで保持する */
			private readonly unsubscribe: () => void;

			/**
			 * 読み込み完了を購読する
			 * 通知が来たら、次のマイクロタスクでビューが接続されていれば再描画 Effect を送る
			 * @param view - 再描画するエディタ。DOM が外れていたら Effect は送らない
			 */
			constructor(view: EditorView) {
				// 言語の読み込み完了で、次のマイクロタスクに再描画を予約する。ビューが外れていたら送らない
				this.unsubscribe = subscribeCodeLanguageReady(() => {
					queueMicrotask(() => {
						// DOM が繋がっているときだけ再描画を送る。外れたビューへは Effect を送らない
						if (view.dom.isConnected) {
							view.dispatch({ effects: codeLanguageReadyEffect.of(null) });
						}
					});
				});
			}

			/**
			 * 読み込み完了の購読を解除する
			 */
			destroy(): void {
				this.unsubscribe();
			}
		}
	);
}

/**
 * インラインコードの言語別ハイライト Extension を返す
 * @returns 読み込み完了の購読と、表示範囲の装飾プラグイン
 */
export function createInlineCodeHighlightExtensions(): Extension[] {
	return [
		createCodeLanguageReadyListener(),
		ViewPlugin.fromClass(
			/** 表示中範囲のインラインコード装飾を保持する。文書、表示範囲、言語準備のいずれかが変わったときだけ作り直す */ class InlineCodeHighlightPlugin {
				/** 表示中範囲のインラインコード装飾。文書、表示範囲、言語準備のいずれかが変わると作り直す */
				decorations: DecorationSet;

				/**
				 * 開いた直後の表示範囲から装飾を作る
				 * @param view - 初期装飾を作るビュー
				 */
				constructor(view: EditorView) {
					this.decorations = buildInlineCodeHighlightDecorations(view);
				}

				/**
				 * 文書、表示範囲、言語準備のいずれかが変わったら装飾を作り直す
				 * @param update - 今回のビュー更新。該当が無ければ装飾は維持する
				 */
				update(update: ViewUpdate): void {
					// この更新に言語準備の Effect があるか。無いときは false で、文書と表示範囲だけを見る
					const languageReady = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(codeLanguageReadyEffect)));
					// 文書、表示範囲、言語準備のどれかが変わったとき装飾を作り直す。三つとも無い更新では維持する
					if (update.docChanged || update.viewportChanged || languageReady) {
						this.decorations = buildInlineCodeHighlightDecorations(update.view);
					}
				}
			},
			{
				/**
				 * プラグインが持つ装飾をビューへ公開する
				 * @param plugin - 装飾を保持するプラグインインスタンス
				 * @returns 現在の DecorationSet
				 */
				decorations: (plugin) => plugin.decorations
			}
		)
	];
}
