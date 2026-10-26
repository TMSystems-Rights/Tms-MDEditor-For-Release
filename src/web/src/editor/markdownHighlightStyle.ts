/**
 * Markdown 記法とコードトークンを、CSS 変数の色で塗るハイライト style を公開する
 * テーマの色そのものは呼び出し側の CSS が持ち、本ファイルはタグと変数の対応だけを固定する
 * @file
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * Markdown 記法とコードトークンを CSS 変数で塗るハイライト
 * 非フォールバックとして登録する。フォールバック指定だと主ハイライトがある限り効かない
 */
export const tmsHighlightStyle = HighlightStyle.define([
	// 処理指示。ハイライトの区切りなど、マーク記号の色に使う
	{
		// 対象タグ。記法のマーク側
		tag: tags.processingInstruction,
		// 文字色。マーク用の CSS 変数。太さは変えない
		color: 'var(--tms-mde-color-mark)'
	},
	// メタ情報。フロントマターなど、コメント色で鈍くする
	{
		// 対象タグ。文書のメタ
		tag: tags.meta,
		// 文字色。コメント用の CSS 変数
		color: 'var(--tms-mde-color-syntax-comment)'
	},
	// 見出し本文。色と太さの両方を指定する
	{
		// 対象タグ。ATX と Setext の見出し
		tag: tags.heading,
		// 文字色。見出し用の CSS 変数
		color: 'var(--tms-mde-color-heading)',
		// 太さ。700 で見出しだけを本文より重くする
		fontWeight: '700'
	},
	// 強調。色は変えず、斜体だけを足す
	{
		// 対象タグ。`*` や `_` の強調
		tag: tags.emphasis,
		// 字体。色の指定は無く、地の文字色のまま斜体になる
		fontStyle: 'italic'
	},
	// 強強調。色は変えず、太さだけを足す
	{
		// 対象タグ。`**` の強強調
		tag: tags.strong,
		// 太さ。700。色は地の文字色のまま
		fontWeight: '700'
	},
	// 打ち消し。色は変えず、取り消し線だけを足す
	{
		// 対象タグ。`~~` の打ち消し
		tag: tags.strikethrough,
		// 線種。取り消し線。色は地の文字色のまま
		textDecoration: 'line-through'
	},
	// リンクとリンク先の文字色
	{
		// 対象タグ。URL とウィキリンクの本文
		tag: tags.link,
		// 文字色。リンク用の CSS 変数
		color: 'var(--tms-mde-color-link)'
	},
	// コードのキーワード
	{
		// 対象タグ。言語パーサの keyword
		tag: tags.keyword,
		// 文字色。キーワード用の CSS 変数
		color: 'var(--tms-mde-color-syntax-keyword)'
	},
	// 原子、真偽値、ラベル名。コールアウト種別も labelName でこの色になる
	{
		// 同じ色を共有するタグ。コードの原子と、コールアウトの種別名
		tag: [tags.atom, tags.bool, tags.labelName],
		// 文字色。原子用の CSS 変数
		color: 'var(--tms-mde-color-syntax-atom)'
	},
	// 数値とリテラル
	{
		// 同じ色を共有するタグ。数値と、その他のリテラル
		tag: [tags.number, tags.literal],
		// 文字色。数値用の CSS 変数
		color: 'var(--tms-mde-color-syntax-number)'
	},
	// 文字列。特殊な文字列も同じ色
	{
		// 同じ色を共有するタグ。通常の文字列と、特殊扱いの文字列
		tag: [tags.string, tags.special(tags.string)],
		// 文字色。文字列用の CSS 変数
		color: 'var(--tms-mde-color-syntax-string)'
	},
	// 正規表現とエスケープ
	{
		// 同じ色を共有するタグ。正規表現リテラルと、エスケープシーケンス
		tag: [tags.regexp, tags.escape],
		// 文字色。正規表現用の CSS 変数
		color: 'var(--tms-mde-color-syntax-regexp)'
	},
	// コメント。色に加えて斜体
	{
		// 対象タグ。言語パーサのコメント
		tag: tags.comment,
		// 文字色。コメント用の CSS 変数
		color: 'var(--tms-mde-color-syntax-comment)',
		// 字体。コメントだけ斜体。色だけでは地の文字と分かれないテーマ向け
		fontStyle: 'italic'
	},
	// 変数名。特殊な変数名も同じ色
	{
		// 同じ色を共有するタグ。通常の変数と、特殊扱いの変数
		tag: [tags.variableName, tags.special(tags.variableName)],
		// 文字色。変数用の CSS 変数
		color: 'var(--tms-mde-color-syntax-variable)'
	},
	// 型名、名前空間、クラス名
	{
		// 同じ色を共有するタグ。型、名前空間、クラス
		tag: [tags.typeName, tags.namespace, tags.className],
		// 文字色。型用の CSS 変数
		color: 'var(--tms-mde-color-syntax-type)'
	},
	// プロパティ名とマクロ名
	{
		// 同じ色を共有するタグ。プロパティとマクロ
		tag: [tags.propertyName, tags.macroName],
		// 文字色。プロパティ用の CSS 変数
		color: 'var(--tms-mde-color-syntax-property)'
	},
	// 不正なトークン
	{
		// 対象タグ。パーサが invalid とした範囲
		tag: tags.invalid,
		// 文字色。不正用の CSS 変数
		color: 'var(--tms-mde-color-syntax-invalid)'
	}
]);

/**
 * 記法トークン色とコードトークン色を CSS 変数で塗るシンタックスハイライト拡張を返す
 * @returns tmsHighlightStyle を非フォールバックで登録する Extension の配列
 */
export function createMarkdownSyntaxHighlighting(): Extension[] {
	return [syntaxHighlighting(tmsHighlightStyle)];
}
