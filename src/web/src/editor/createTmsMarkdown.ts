/**
 * TMS-MDEditor 用の Markdown 言語サポートを組み立てて返す
 * キーマップを含めるかだけを呼び出し側が決め、言語拡張とコードフェンスの解決は本ファイルが固定する
 * @file
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { Extension } from '@codemirror/state';
import { resolveFencedCodeLanguage } from './codeLanguage';
import { tmsMarkdownExtensions } from './markdownSyntax';

/**
 * Markdown 言語サポートの Extension を返す
 * @param options - 言語サポートの組み立て方。未指定時は空オブジェクトで、キーマップを含めない
 * @param options.addKeymap - true のとき Markdown のキーマップを含める。未指定時は false
 * @returns エディタへ渡す Extension。キーマップ以外の構成は常に同じ
 */
export function createTmsMarkdownSupport(options: { addKeymap?: boolean } = {}): Extension {
	// 言語サポートへ渡す構成。キーマップを含めるか以外は、呼び出しのたびに同じ並び
	return markdown({
		// 基底の Markdown 言語。独自記法は extensions 側で足す
		base: markdownLanguage,
		// Obsidian 相当の独自記法。解釈の順は markdownSyntax が固定する
		extensions: tmsMarkdownExtensions,
		// Markdown のキーマップを含めるか。未指定は false で、エディタ側のキーマップと重ねない
		addKeymap: options.addKeymap ?? false,
		// フェンスの言語名から入れ子言語を決める関数。未ロードなら読み込みを始める
		codeLanguages: resolveFencedCodeLanguage
	});
}
