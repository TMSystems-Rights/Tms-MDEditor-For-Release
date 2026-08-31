import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { Extension } from '@codemirror/state';
import { resolveFencedCodeLanguage } from './codeLanguage';
import { tmsMarkdownExtensions } from './markdownSyntax';

/**
 * TMS-MDEditor 用 Markdown 言語サポートを生成する
 * @param {object} [options] オプション
 * @param {boolean} [options.addKeymap=false] Markdown キーマップを含めるか
 * @returns {Extension}
 */
export function createTmsMarkdownSupport(options: { addKeymap?: boolean } = {}): Extension {
	return markdown({
		base         : markdownLanguage,
		extensions   : tmsMarkdownExtensions,
		addKeymap    : options.addKeymap ?? false,
		codeLanguages: resolveFencedCodeLanguage,
	});
}
