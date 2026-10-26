/**
 * Enter でリスト・引用・チェックボックスのマーカーを継続するコマンドを公開する
 * 継続規則は CodeMirror の実装に任せ、本ファイルは非タイト化の空行を入れない設定だけを固定する
 * @file
 */
import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';

/**
 * リスト・引用・チェックボックス行で Enter したときにマーカーを継続するコマンド
 * 空のマーカー行ではレベルを解除する。非タイト化のための空行は挿入しない
 */
export const continueListMarkup = insertNewlineContinueMarkupCommand({
	// 継続時に空行を挟まない。false のあいだは、項目のあいだを非タイトなリストにしない
	nonTightLists: false
});
