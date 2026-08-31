import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * Markdown 記法とコードトークンを CSS 変数で塗るハイライト
 * 非フォールバックとして登録する。フォールバック指定だと主ハイライトがある限り効かない。
 */
export const tmsHighlightStyle = HighlightStyle.define([
	{ tag: tags.processingInstruction, color: 'var(--tms-mde-color-mark)' },
	{ tag: tags.meta, color: 'var(--tms-mde-color-syntax-comment)' },
	{ tag: tags.heading, color: 'var(--tms-mde-color-heading)', fontWeight: '700' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.strong, fontWeight: '700' },
	{ tag: tags.strikethrough, textDecoration: 'line-through' },
	{ tag: tags.link, color: 'var(--tms-mde-color-link)' },
	{ tag: tags.keyword, color: 'var(--tms-mde-color-syntax-keyword)' },
	{
		tag  : [tags.atom, tags.bool, tags.labelName],
		color: 'var(--tms-mde-color-syntax-atom)',
	},
	{
		tag  : [tags.number, tags.literal],
		color: 'var(--tms-mde-color-syntax-number)',
	},
	{
		tag  : [tags.string, tags.special(tags.string)],
		color: 'var(--tms-mde-color-syntax-string)',
	},
	{
		tag  : [tags.regexp, tags.escape],
		color: 'var(--tms-mde-color-syntax-regexp)',
	},
	{
		tag  : tags.comment,
		color: 'var(--tms-mde-color-syntax-comment)',
		fontStyle: 'italic',
	},
	{
		tag  : [tags.variableName, tags.special(tags.variableName)],
		color: 'var(--tms-mde-color-syntax-variable)',
	},
	{
		tag  : [tags.typeName, tags.namespace, tags.className],
		color: 'var(--tms-mde-color-syntax-type)',
	},
	{
		tag  : [tags.propertyName, tags.macroName],
		color: 'var(--tms-mde-color-syntax-property)',
	},
	{ tag: tags.invalid, color: 'var(--tms-mde-color-syntax-invalid)' },
]);

/**
 * 記法トークン色とコードトークン色を CSS 変数で塗るシンタックスハイライト拡張
 * @returns {Extension[]}
 */
export function createMarkdownSyntaxHighlighting(): Extension[] {
	return [syntaxHighlighting(tmsHighlightStyle)];
}
