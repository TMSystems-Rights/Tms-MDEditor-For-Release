import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';

/**
 * リスト・引用・チェックボックス行の Enter 継続
 * 空マーカー行ではレベル解除する（非タイト化のための空行挿入はしない）
 */
export const continueListMarkup = insertNewlineContinueMarkupCommand({
	nonTightLists: false,
});
