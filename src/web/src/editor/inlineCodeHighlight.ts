import { syntaxTree } from '@codemirror/language';
import { StateEffect, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import {
	collectInlineCodeContentRanges,
	requestCodeLanguage,
	resolveCodeLanguage,
	subscribeCodeLanguageReady,
} from './codeLanguage';
import { collectCodeHighlightRanges, splitInlineCodeLanguageContent } from './codeHighlight';
import { buildDecorationSet, type DecorationEntry } from '../livePreview/inlineDecorations';

/**
 * 言語チャンク読み込み後に装飾を再構築する Effect
 */
export const codeLanguageReadyEffect = StateEffect.define<null>();

/**
 * 表示中のインライン `{lang}` コードへトークン装飾を付ける
 * @param {EditorState} state エディタ状態
 * @param {number} from 走査開始
 * @param {number} to 走査終了
 * @returns {DecorationEntry[]}
 */
export function collectInlineCodeHighlightEntries(
	state: EditorState,
	from: number,
	to: number,
): DecorationEntry[] {
	const entries: DecorationEntry[] = [];

	syntaxTree(state).iterate({
		from,
		to,
		/**
		 * @param {{ name: string; node: import('@lezer/common').SyntaxNode }} ref ノード
		 * @returns {boolean | void}
		 */
		enter(ref) {
			if (ref.name !== 'InlineCode') {
				return;
			}

			for (const range of collectInlineCodeContentRanges(ref.node)) {
				const content = state.doc.sliceString(range.from, range.to);
				const split   = splitInlineCodeLanguageContent(content);
				if (!split || !resolveCodeLanguage(split.language)) {
					continue;
				}

				const language = requestCodeLanguage(split.language);
				if (!language || !split.code) {
					continue;
				}

				const codeFrom = range.from + split.prefixLength;
				for (const token of collectCodeHighlightRanges(split.code, language)) {
					entries.push({
						from      : codeFrom + token.from,
						to        : codeFrom + token.to,
						decoration: Decoration.mark({ class: token.className }),
					});
				}
			}

			return false;
		},
	});

	return entries;
}

/**
 * 表示範囲のインラインコードハイライト DecorationSet を構築する
 * @param {EditorView} view ビュー
 * @returns {DecorationSet}
 */
function buildInlineCodeHighlightDecorations(view: EditorView): DecorationSet {
	const entries: DecorationEntry[] = [];
	for (const visible of view.visibleRanges) {
		entries.push(...collectInlineCodeHighlightEntries(view.state, visible.from, visible.to));
	}

	return buildDecorationSet(entries);
}

/**
 * 言語読み込み完了で再描画するリスナー
 * @returns {Extension}
 */
function createCodeLanguageReadyListener(): Extension {
	return ViewPlugin.fromClass(class CodeLanguageReadyListener {
		private readonly unsubscribe: () => void;

		/**
		 * @param {EditorView} view ビュー
		 */
		constructor(view: EditorView) {
			this.unsubscribe = subscribeCodeLanguageReady(() => {
				queueMicrotask(() => {
					if (view.dom.isConnected) {
						view.dispatch({ effects: codeLanguageReadyEffect.of(null) });
					}
				});
			});
		}

		/**
		 * 購読を解除する
		 * @returns {void}
		 */
		destroy(): void {
			this.unsubscribe();
		}
	});
}

/**
 * インラインコードの言語別ハイライト拡張
 * @returns {Extension[]}
 */
export function createInlineCodeHighlightExtensions(): Extension[] {
	return [
		createCodeLanguageReadyListener(),
		ViewPlugin.fromClass(class InlineCodeHighlightPlugin {
			decorations: DecorationSet;

			/**
			 * @param {EditorView} view ビュー
			 */
			constructor(view: EditorView) {
				this.decorations = buildInlineCodeHighlightDecorations(view);
			}

			/**
			 * @param {ViewUpdate} update 更新
			 * @returns {void}
			 */
			update(update: ViewUpdate): void {
				const languageReady = update.transactions.some((transaction) => (
					transaction.effects.some((effect) => effect.is(codeLanguageReadyEffect))
				));
				if (update.docChanged || update.viewportChanged || languageReady) {
					this.decorations = buildInlineCodeHighlightDecorations(update.view);
				}
			}
		}, {
			/**
			 * @param {{ decorations: import('@codemirror/view').DecorationSet }} plugin プラグイン
			 * @returns {import('@codemirror/view').DecorationSet}
			 */
			decorations: (plugin) => plugin.decorations,
		}),
	];
}
