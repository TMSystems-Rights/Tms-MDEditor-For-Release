import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';

/**
 * 箇条書きマーカー `•` 表示ウィジェット
 */
class BulletMarkerWidget extends WidgetType {
	/**
	 * 同一ウィジェットか判定する
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof BulletMarkerWidget;
	}

	/**
	 * DOM を生成する
	 * @returns {HTMLElement}
	 */
	toDOM(): HTMLElement {
		const span       = document.createElement('span');
		span.className   = 'cm-md-bullet-marker';
		span.textContent = '•';
		return span;
	}

	/**
	 * イベントを無視する
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

const bulletMarkerWidget = new BulletMarkerWidget();

/**
 * プレビュー行の箇条書きマークを `•` に置換する Decoration エントリを追加する
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} from 開始位置
 * @param {number} to 終了位置
 * @returns {void}
 */
export function pushBulletMarkerReplace(entries: DecorationEntry[], from: number, to: number): void {
	if (from >= to) {
		return;
	}

	entries.push({
		from,
		to,
		decoration: Decoration.replace({
			widget: bulletMarkerWidget,
		}),
	});
}
