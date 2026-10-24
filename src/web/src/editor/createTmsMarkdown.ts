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
	return markdown({
		base         : markdownLanguage,
		extensions   : tmsMarkdownExtensions,
		addKeymap    : options.addKeymap ?? false,
		codeLanguages: resolveFencedCodeLanguage,
	});
}
