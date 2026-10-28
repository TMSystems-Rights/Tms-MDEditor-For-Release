/**
 * サニタイズ済みの HTML 表を、編集できないブロックウィジェットとして装飾配列へ足す
 * エディタ状態は持たず、タグの選別は htmlTable に任せる
 * @file
 */
import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';
import { sanitizeHtmlTable } from './htmlTable';
import { attachTableHorizontalOverflow } from './tableResize';

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
		// 表を包む編集不可の要素。innerHTML にはサニタイズ済みの表を入れる
		const wrap     = document.createElement('div');
		wrap.className = 'cm-md-html-table-wrap';
		wrap.setAttribute('contenteditable', 'false');
		wrap.innerHTML = this.html;
		// ラッパー内の最初の table。サニタイズ結果に表が無ければ null
		const table    = wrap.querySelector('table');
		// 表要素があるときだけ Markdown 表と HTML 表のクラスを付ける。無ければクラスは足さない
		if (table instanceof HTMLTableElement) {
			table.classList.add('cm-md-table', 'cm-md-html-table');
			// 高さ制限で見切れた行を、枠の中でスクロールできるようにする
			attachTableHorizontalOverflow(wrap, table);
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
export function pushHtmlTableReplace(entries: DecorationEntry[], from: number, to: number, raw: string): boolean {
	// サニタイズ後の表 HTML。表を取り出せなければ null
	const html = sanitizeHtmlTable(raw);
	// 表 HTML が無い、または範囲が空なら装飾を足さない。どちらか一方でも false
	if (!html || from >= to) {
		return false;
	}

	// 編集できない表ウィジェットへの replace
	entries.push({
		// 置き換えるブロックの開始。ドキュメント先頭からの文字位置
		from,
		// 置き換えるブロックの終端。from より大きい
		to,
		// サニタイズ済み HTML を固定したウィジェット。元のタグ文字は残さない
		decoration: Decoration.replace({
			widget: new HtmlTableWidget(html)
		})
	});
	return true;
}
