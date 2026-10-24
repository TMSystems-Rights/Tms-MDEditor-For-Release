/**
 * プレビュー行の箇条書き記号を、共通の `•` ウィジェットへ置き換える
 * エディタ状態は持たず、呼び出し側の装飾配列へ replace を足す
 * @file
 */
import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';

/**
 * 箇条書きマーカー `•` を描くウィジェット
 * 表示は常に同じなので、比較は型だけで行う
 */
class BulletMarkerWidget extends WidgetType {
	/**
	 * 基底の契約と同じ。すべての箇条書きマーカーを同一とみなす
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も BulletMarkerWidget なら true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof BulletMarkerWidget;
	}

	/**
	 * 基底の契約と同じ。クラス `cm-md-bullet-marker` の `•` を返す
	 * @returns マーカー要素。テキストは `•` 固定
	 */
	toDOM(): HTMLElement {
		const span       = document.createElement('span');
		span.className   = 'cm-md-bullet-marker';
		span.textContent = '•';
		return span;
	}

	/**
	 * 基底の契約と同じ。マーカー上のイベントはエディタへ渡さない
	 * @returns 常に true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * すべての箇条書きマーカーで共有するウィジェット
 * 表示内容が変わらないため、モジュール内で1つだけ生成する
 */
const bulletMarkerWidget = new BulletMarkerWidget();

/**
 * プレビュー行の箇条書き記号を `•` に置き換える装飾を追加する
 * from が to 以上のときは何も足さない
 * @param entries - 装飾を追加する配列。この関数が末尾へ push する
 * @param from - 置き換える記号の開始位置
 * @param to - 置き換える記号の終端。from 以上なら追加しない
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
