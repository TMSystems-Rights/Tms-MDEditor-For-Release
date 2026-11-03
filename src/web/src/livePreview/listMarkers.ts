/**
 * プレビュー表示のリスト記号を、箇条書きの `•` と番号付きのラベルのウィジェットへ置き換える
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
		// 箇条書きの表示記号。テキストは常に `•` で、記法の `-` や `*` は残さない
		const span       = document.createElement('span');
		span.className   = 'cm-md-bullet-marker';
		span.textContent = '•';
		return span;
	}

	/**
	 * 基底の契約と同じ。マーカー上のクリックもエディタへ渡し、記号の位置へキャレットを置く
	 * キャレットが記号に入ると、装飾側がソースの `-` を見せる
	 * @returns 常に false
	 */
	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * 番号付きリストの番号を、採番ルールのラベルで描くウィジェット
 * 兄弟の項目で最も広いラベルを見えない形で重ね、その幅を確保して本文の開始位置をそろえる
 * ラベルと最も広いラベルが同じなら同一とみなし、キャレットの移動で DOM を作り直さない
 */
class OrderedListLabelWidget extends WidgetType {
	/**
	 * 描くラベルと、幅をそろえる相手を受け取る
	 * @param label - 表示ラベル。`(ア)` や `①` など。空文字は渡さない
	 * @param widest - 兄弟の項目で最も広いラベル。label と同じなら重ねない
	 */
	constructor(private readonly label: string, private readonly widest: string) {
		super();
	}

	/**
	 * 基底の契約と同じ。ラベルと、幅をそろえる相手の文字列で比べる
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も番号ラベルで、両方の文字列が同じなら true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof OrderedListLabelWidget && other.label === this.label && other.widest === this.widest;
	}

	/**
	 * 基底の契約と同じ。クラス `cm-md-list-number cm-md-list-label` の span を返す
	 * `cm-md-list-number` は以前の数字の装飾と同じクラスで、CSS スニペットの指定をそのまま効かせる
	 * @returns ラベル要素。幅をそろえるときは、見えるラベルと見えない最も広いラベルを同じ升に重ねる
	 */
	toDOM(): HTMLElement {
		// 番号の表示ラベル。ソースの数字は DOM に残さない
		const span     = document.createElement('span');
		span.className = 'cm-md-list-number cm-md-list-label';
		// 自分が最も広いラベルなら、重ねる相手は要らない
		if (this.widest === this.label || this.widest.length === 0) {
			span.textContent = this.label;
			return span;
		}

		// 画面に見えるラベル
		const text        = document.createElement('span');
		text.className    = 'cm-md-list-label-text';
		text.textContent  = this.label;
		// 幅だけを確保する、兄弟で最も広いラベル。見えず、読み上げもしない
		const ghost       = document.createElement('span');
		ghost.className   = 'cm-md-list-label-ghost';
		ghost.textContent = this.widest;
		ghost.setAttribute('aria-hidden', 'true');
		span.append(text, ghost);
		return span;
	}

	/**
	 * 基底の契約と同じ。ラベル上のクリックもエディタへ渡し、番号の位置へキャレットを置く
	 * キャレットが番号に入ると、装飾側がソースの数字を見せて編集できるようにする
	 * @returns 常に false
	 */
	ignoreEvent(): boolean {
		return false;
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
	// 開始が終端以上なら置き換える記号が無い。空範囲の装飾は足さない
	if (from >= to) {
		return;
	}

	// 記号を共通の `•` へ置き換える replace
	entries.push({
		// 置き換える記号の開始。ドキュメント先頭からの文字位置
		from,
		// 置き換える記号の終端。from より大きい
		to,
		// 共有ウィジェットへの replace。元の記号はレイアウトに残さない
		decoration: Decoration.replace({
			widget: bulletMarkerWidget
		})
	});
}

/**
 * 番号付きリストの記号を、採番ルールのラベルへ置き換える装飾を追加する
 * from が to 以上のとき、またはラベルが空のときは何も足さない
 * @param entries - 装飾を追加する配列。この関数が末尾へ push する
 * @param from - 置き換える記号の開始位置
 * @param to - 置き換える記号の終端。from 以上なら追加しない
 * @param label - 表示ラベル。空文字なら追加しない
 * @param widest - 兄弟の項目で最も広いラベル。ラベルの幅をこれにそろえる。空文字ならそろえない
 */
export function pushOrderedListLabelReplace(entries: DecorationEntry[], from: number, to: number, label: string, widest: string): void {
	// 置き換える記号が無いか、出すラベルが無い。どちらか一方でも足さない
	if (from >= to || label.length === 0) {
		return;
	}

	// 記号を番号ラベルへ置き換える replace
	entries.push({
		// 置き換える記号の開始。数字の先頭
		from,
		// 置き換える記号の終端。区切りの `.` か `)` の直後
		to,
		// ラベルのウィジェットへの replace。元の数字はレイアウトに残さない
		decoration: Decoration.replace({
			widget: new OrderedListLabelWidget(label, widest)
		})
	});
}
