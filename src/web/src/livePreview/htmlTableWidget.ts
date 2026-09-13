import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';
import { sanitizeHtmlTable } from './htmlTable';

/**
 * フェンス無し HTML 表ウィジェット
 */
export class HtmlTableWidget extends WidgetType {
	readonly html: string;

	/**
	 * @param {string} html サニタイズ済み HTML
	 */
	constructor(html: string) {
		super();
		this.html = html;
	}

	/**
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof HtmlTableWidget && other.html === this.html;
	}

	/**
	 * @returns {HTMLElement}
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
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * HTML 表ブロックをウィジェットへ置換する。
 * @param {DecorationEntry[]} entries 装飾
 * @param {number} from 開始
 * @param {number} to 終了
 * @param {string} raw 生 HTML
 * @returns {boolean} 追加したか
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
