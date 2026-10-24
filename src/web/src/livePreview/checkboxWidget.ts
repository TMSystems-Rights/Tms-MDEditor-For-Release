/**
 * プレビュー行のタスク記法を、チェック状態を持つチェックボックスへ置き換える
 * エディタ状態は持たず、クリックは ignoreEvent が false のため呼び出し側のトグルへ渡る
 * @file
 */
import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';

/**
 * タスクのチェック状態を input として描くウィジェット
 * 生成後に checked は変えず、状態が変われば別インスタンスへ作り直す
 */
class CheckboxWidget extends WidgetType {
	/** チェック済みなら true。生成後は変えない */
	readonly checked: boolean;

	/**
	 * チェック状態を固定したウィジェットを作る
	 * @param checked - チェック済みなら true
	 */
	constructor(checked: boolean) {
		super();
		this.checked = checked;
	}

	/**
	 * 基底の契約と同じ。チェック状態が同じインスタンスだけを同一とみなす
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も CheckboxWidget で checked が一致すれば true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof CheckboxWidget && other.checked === this.checked;
	}

	/**
	 * 基底の契約と同じ。クラス `cm-md-checkbox` のチェックボックスを返す
	 * フォーカスは受け取らず、読み上げ名は「タスク」固定
	 * @returns チェック状態を反映した input 要素
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
	 * クリックをエディタのトグル処理へ渡す
	 * 基底はイベントを無視するが、このウィジェットはチェック操作のため無視しない
	 * @returns 常に false
	 */
	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * プレビュー行の TaskMarker をチェックボックスに置き換える装飾を追加する
 * from が to 以上のときは何も足さない
 * @param entries - 装飾を追加する配列。この関数が末尾へ push する
 * @param from - 置き換える記法の開始位置
 * @param to - 置き換える記法の終端。from 以上なら追加しない
 * @param checked - チェック済みなら true。ウィジェットの表示と一致させる
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
