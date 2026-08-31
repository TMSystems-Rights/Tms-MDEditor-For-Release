import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';

/**
 * チェックボックス表示ウィジェット
 */
class CheckboxWidget extends WidgetType {
	readonly checked: boolean;

	/**
	 * @param {boolean} checked チェック状態
	 */
	constructor(checked: boolean) {
		super();
		this.checked = checked;
	}

	/**
	 * 同一ウィジェットか判定する
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof CheckboxWidget && other.checked === this.checked;
	}

	/**
	 * DOM を生成する
	 * @returns {HTMLElement}
	 */
	toDOM(): HTMLElement {
		const input     = document.createElement('input');
		input.type      = 'checkbox';
		input.className = 'cm-md-checkbox';
		input.checked   = this.checked;
		input.tabIndex  = -1;
		input.setAttribute('aria-label', 'タスク');
		return input;
	}

	/**
	 * クリックをエディタへ渡す
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * プレビュー行の TaskMarker をチェックボックスに置換する Decoration エントリを追加する
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} from 開始位置
 * @param {number} to 終了位置
 * @param {boolean} checked チェック状態
 * @returns {void}
 */
export function pushCheckboxReplace(
	entries: DecorationEntry[],
	from: number,
	to: number,
	checked: boolean,
): void {
	if (from >= to) {
		return;
	}

	entries.push({
		from,
		to,
		decoration: Decoration.replace({
			widget: new CheckboxWidget(checked),
		}),
	});
}
