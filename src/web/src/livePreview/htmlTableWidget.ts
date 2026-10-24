/**
 * サニタイズ済みの HTML 表を、編集できないブロックウィジェットとして装飾配列へ足す
 * エディタ状態は持たず、タグの選別は htmlTable に任せる
 * @file
 */
import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';
import { sanitizeHtmlTable } from './htmlTable';

/**
 * フェンス無し HTML 表を描くウィジェット
 * html は生成時の文字列のまま変えず、中の表は contenteditable にしない
 */
export class HtmlTableWidget extends WidgetType {
	/** サニタイズ済みの表 HTML。innerHTML へそのまま入れる */
	readonly html: string;

	/**
	 * サニタイズ済み HTML を固定したウィジェットを作る
	 * @param html - 表示する表 HTML。呼び出し側が sanitizeHtmlTable を通した文字列
	 */
	constructor(html: string) {
		super();
		this.html = html;
	}

	/**
	 * 基底の契約と同じ。HTML 文字列が一致するインスタンスだけを同一とみなす
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も HtmlTableWidget で html が一致すれば true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof HtmlTableWidget && other.html === this.html;
	}

	/**
	 * 基底の契約と同じ。編集できないラッパーの中へ表を入れる
	 * 表要素には Markdown 表と HTML 表の両方のクラスを付ける
	 * @returns クラス `cm-md-html-table-wrap` の要素
	 */
	toDOM(): HTMLElement {
		const wrap     = document.createElement('div');
		wrap.className = 'cm-md-html-table-wrap';
		wrap.setAttribute('contenteditable', 'false');
		wrap.innerHTML = this.html;
		const table    = wrap.querySelector('table');
		if (table) {
			table.classList.add('cm-md-table', 'cm-md-html-table');
		}

		return wrap;
	}

	/**
	 * 基底の契約と同じ。表の中の操作はエディタの選択へ渡さない
	 * @returns 常に true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * HTML 表ブロックをウィジェットへ置き換える
 * サニタイズ結果が空、または範囲が空のときは追加せず false を返す
 * @param entries - 装飾を追加する配列。成功したときだけ末尾へ push する
 * @param from - 置き換えるブロックの開始位置
 * @param to - 置き換えるブロックの終端。from 以上なら追加しない
 * @param raw - サニタイズ前の HTML。表が取り出せなければ追加しない
 * @returns 装飾を追加したら true
 */
export function pushHtmlTableReplace(
	entries: DecorationEntry[],
	from: number,
	to: number,
	raw: string,
): boolean {
	const html = sanitizeHtmlTable(raw);
	if (!html || from >= to) {
		return false;
	}

	entries.push({
		from,
		to,
		decoration: Decoration.replace({
			widget: new HtmlTableWidget(html),
		}),
	});
	return true;
}
