import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { formatMarkdownImage, formatWikiEmbed, splitImageAlt, splitWikiEmbedTarget } from './imageSize';

/**
 * 指定位置の画像記法へ表示幅を書き戻す
 * @param {EditorView} view エディタ
 * @param {number} pos 画像ウィジェット位置
 * @param {number} width 幅（px）
 * @returns {boolean} 更新したか
 */
export function applyImageDisplayWidth(view: EditorView, pos: number, width: number): boolean {
	const rounded               = Math.max(24, Math.round(width));
	let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(Math.min(pos, view.state.doc.length), 1);
	while (node && node.name !== 'WikiEmbed' && node.name !== 'Image') {
		node = node.parent;
	}

	if (!node || (node.name !== 'WikiEmbed' && node.name !== 'Image')) {
		return false;
	}

	const text = view.state.sliceDoc(node.from, node.to);
	let insert = '';
	if (node.name === 'WikiEmbed') {
		if (!text.startsWith('![[') || !text.endsWith(']]')) {
			return false;
		}

		const { path } = splitWikiEmbedTarget(text.slice(3, -2));
		insert         = formatWikiEmbed(path, rounded);
	} else {
		const closeAlt = text.indexOf('](');
		if (!text.startsWith('![') || closeAlt < 0 || !text.endsWith(')')) {
			return false;
		}

		const alt           = text.slice(2, closeAlt);
		const url           = text.slice(closeAlt + 2, -1);
		const { alt: name } = splitImageAlt(alt);
		insert              = formatMarkdownImage(name, url, rounded);
	}

	if (insert === text) {
		return false;
	}

	view.dispatch({
		changes  : { from: node.from, to: node.to, insert },
		userEvent: 'input.imageResize',
	});
	return true;
}
