/**
 * コールアウトの折りたたみボタン、種別アイコン、本文を潰す装飾を呼び出し側の配列へ足す
 * 折りたたみ状態そのものは calloutFold が持ち、このファイルは描画と重なりの除去だけを行う
 * @file
 */
import { Decoration, WidgetType } from '@codemirror/view';
import type { CalloutType } from '../editor/markdownSyntax';
import type { DecorationEntry } from './inlineDecorations';
import { TableWidget } from './tableWidget';

/**
 * コールアウトアイコンの SVG 部品
 * path は viewBox 24 の d 属性。circle は中心と半径で、fill が true のときだけ塗りつぶす
 */
type CalloutIconShape =
	| { kind: 'path'; d: string }
	| { kind: 'circle'; cx: number; cy: number; r: number; fill?: boolean };

// ==============================================
// 種別アイコン
// ==============================================

/**
 * コールアウト種別ごとの独自 SVG 図形
 * Obsidian / Lucide 資産の複製ではない。viewBox は 0 0 24 24、線描画が前提。実行中は変えない
 */
const CALLOUT_ICON_SHAPES: Record<CalloutType, CalloutIconShape[]> = {
	note: [
		{ kind: 'path', d: 'M6 4h9l3 3v13H6V4z' },
		{ kind: 'path', d: 'M15 4v3h3' },
	],
	abstract: [
		{ kind: 'path', d: 'M8 4h8v16H8z' },
		{ kind: 'path', d: 'M10 8h4 M10 12h4 M10 16h2' },
	],
	info: [
		{ kind: 'path', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z' },
		{ kind: 'path', d: 'M12 11v5' },
		{ kind: 'circle', cx: 12, cy: 8, r: 0.9, fill: true },
	],
	todo: [
		{ kind: 'path', d: 'M6 5h12v14H6z' },
		{ kind: 'path', d: 'M9 12l2 2 4-4' },
	],
	tip: [
		{ kind: 'path', d: 'M9 18h6' },
		{ kind: 'path', d: 'M10 21h4' },
		{ kind: 'path', d: 'M12 3a6 6 0 0 1 4 10c-.8.7-1.3 1.7-1.5 2.7h-5C9.3 14.7 8.8 13.7 8 13a6 6 0 0 1 4-10z' },
	],
	success: [
		{ kind: 'path', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z' },
		{ kind: 'path', d: 'M8.5 12.5l2.5 2.5 4.5-5' },
	],
	question: [
		{ kind: 'path', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z' },
		{ kind: 'path', d: 'M9.5 9a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.2 1-1.2 2.3' },
		{ kind: 'circle', cx: 12, cy: 17, r: 0.9, fill: true },
	],
	warning: [
		{ kind: 'path', d: 'M12 3 22 20H2L12 3z' },
		{ kind: 'path', d: 'M12 10v4' },
		{ kind: 'circle', cx: 12, cy: 17, r: 0.9, fill: true },
	],
	failure: [
		{ kind: 'path', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z' },
		{ kind: 'path', d: 'M9 9l6 6 M15 9l-6 6' },
	],
	danger: [
		{ kind: 'path', d: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z' },
	],
	bug: [
		{ kind: 'path', d: 'M8 9h8v7a4 4 0 0 1-8 0V9z' },
		{ kind: 'path', d: 'M12 5v4 M9 5h6' },
		{ kind: 'path', d: 'M5 12h3 M16 12h3 M6 8l2 2 M18 8l-2 2 M6 16l2-2 M18 16l-2-2' },
	],
	example: [
		{ kind: 'path', d: 'M8 6h8 M8 12h8 M8 18h5' },
		{ kind: 'path', d: 'M5 6h.01 M5 12h.01 M5 18h.01' },
	],
	quote: [
		{ kind: 'path', d: 'M8 11V9.5A2.5 2.5 0 0 1 10.5 7H11v2h-.5A1 1 0 0 0 9.5 10v1H11v5H8v-5z' },
		{ kind: 'path', d: 'M15 11V9.5A2.5 2.5 0 0 1 17.5 7H18v2h-.5a1 1 0 0 0-1 1v1H18v5h-3v-5z' },
	],
};

// ==============================================
// 折りたたみ
// ==============================================

/**
 * 折りたたみ時に本文を潰す空ウィジェット
 * CodeMirror の fold と同じくインライン replace に使い、ブロック装飾は使わない
 */
export class CalloutCollapseWidget extends WidgetType {
	/**
	 * 基底の契約と同じ。すべての折りたたみウィジェットを同一とみなす
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も CalloutCollapseWidget なら true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof CalloutCollapseWidget;
	}

	/**
	 * 基底の契約と同じ。高さを持たない隠し要素を返す
	 * @returns クラス `cm-md-callout-collapsed` の空 span
	 */
	toDOM(): HTMLElement {
		const span     = document.createElement('span');
		span.className = 'cm-md-callout-collapsed';
		span.setAttribute('aria-hidden', 'true');
		return span;
	}

	/**
	 * 高さを 0 に固定し、ビューポート計測の不安定化を防ぐ
	 * @returns 常に 0
	 */
	get estimatedHeight(): number {
		return 0;
	}

	/**
	 * 基底の契約と同じ。潰した本文の上のイベントはエディタへ渡さない
	 * @returns 常に true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * 折りたたみ本文で共有する空ウィジェット
 * 表示が位置に依存しないため、モジュール内で 1 つだけ生成する
 */
const calloutCollapseWidget = new CalloutCollapseWidget();

/**
 * コールアウトの折りたたみボタンを描くウィジェット
 * クリックは ignoreEvent が false のため、エディタの domEventHandlers へ渡る
 */
export class CalloutFoldWidget extends WidgetType {
	/** 折りたたみ中なら true。生成後は変えない */
	readonly collapsed: boolean;

	/** blockquote の開始位置。クリック時に dataset へ文字列で載せる */
	readonly calloutFrom: number;

	/**
	 * 折りたたみ状態と、対象コールアウトの位置を固定する
	 * @param collapsed - 折りたたみ中なら true。ボタンの記号と aria-expanded に使う
	 * @param calloutFrom - blockquote の開始位置。dataset.calloutFrom へ文字列で入れる
	 */
	constructor(collapsed: boolean, calloutFrom: number) {
		super();
		this.collapsed   = collapsed;
		this.calloutFrom = calloutFrom;
	}

	/**
	 * 基底の契約と同じ。折りたたみ状態と開始位置が同じボタンだけを同一とみなす
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も CalloutFoldWidget で collapsed と calloutFrom が一致すれば true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof CalloutFoldWidget
			&& other.collapsed === this.collapsed
			&& other.calloutFrom === this.calloutFrom;
	}

	/**
	 * 基底の契約と同じ。展開状態を示すボタン風の span を返す
	 * @returns クラス `cm-md-callout-fold` の要素。折りたたみ中は `▶`、展開中は `▼`
	 */
	toDOM(): HTMLElement {
		const button       = document.createElement('span');
		button.className   = 'cm-md-callout-fold';
		button.textContent = this.collapsed ? '▶' : '▼';
		button.title       = this.collapsed ? '展開' : '折りたたみ';
		button.setAttribute('role', 'button');
		button.setAttribute('aria-expanded', this.collapsed ? 'false' : 'true');
		button.tabIndex            = 0;
		button.dataset.calloutFrom = String(this.calloutFrom);
		return button;
	}

	/**
	 * クリックをエディタの domEventHandlers へ渡す
	 * チェックボックスと同じく、基底はイベントを無視するが、このボタンは操作のため無視しない
	 * @returns 常に false
	 */
	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * コールアウト種別の SVG アイコンを描くウィジェット
 * 図形は CALLOUT_ICON_SHAPES から取り、種別が変われば別インスタンスにする
 */
export class CalloutTypeLabelWidget extends WidgetType {
	/** 描くアイコンの種別。CALLOUT_ICON_SHAPES のキー */
	readonly calloutType: CalloutType;

	/**
	 * 表示するコールアウト種別を固定する
	 * @param calloutType - アイコンと読み上げ名に使う種別
	 */
	constructor(calloutType: CalloutType) {
		super();
		this.calloutType = calloutType;
	}

	/**
	 * 基底の契約と同じ。種別が同じアイコンだけを同一とみなす
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も CalloutTypeLabelWidget で calloutType が一致すれば true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof CalloutTypeLabelWidget && other.calloutType === this.calloutType;
	}

	/**
	 * 基底の契約と同じ。種別の SVG を含む span を返す
	 * @returns クラス `cm-md-callout-type-label` の要素。図形は viewBox 24 の線描画
	 */
	toDOM(): HTMLElement {
		const span     = document.createElement('span');
		span.className = 'cm-md-callout-type-label';
		span.setAttribute('aria-label', this.calloutType);
		span.title = this.calloutType;

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');

		for (const shape of CALLOUT_ICON_SHAPES[this.calloutType]) {
			if (shape.kind === 'path') {
				const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute('d', shape.d);
				svg.appendChild(path);
				continue;
			}

			const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			circle.setAttribute('cx', String(shape.cx));
			circle.setAttribute('cy', String(shape.cy));
			circle.setAttribute('r', String(shape.r));
			if (shape.fill) {
				circle.setAttribute('fill', 'currentColor');
				circle.setAttribute('stroke', 'none');
			}

			svg.appendChild(circle);
		}

		span.appendChild(svg);
		return span;
	}

	/**
	 * 基底の契約と同じ。アイコン上のイベントはエディタへ渡さない
	 * @returns 常に true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * 折りたたみボタンの point 装飾を追加する
 * 文書の文字は置き換えず、指定位置の side 1 にボタンを挿入する
 * @param entries - 装飾を追加する配列。この関数が末尾へ push する
 * @param pos - ボタンを挿入する文書位置
 * @param collapsed - 折りたたみ中なら true
 * @param calloutFrom - blockquote の開始位置。クリック後の上書き先
 */
export function pushCalloutFoldWidget(
	entries: DecorationEntry[],
	pos: number,
	collapsed: boolean,
	calloutFrom: number,
): void {
	entries.push({
		from      : pos,
		to        : pos,
		decoration: Decoration.widget({
			widget: new CalloutFoldWidget(collapsed, calloutFrom),
			side  : 1,
		}),
	});
}

/**
 * コールアウト種別アイコンの point 装飾を追加する
 * 文書の文字は置き換えず、指定位置の side 1 にアイコンを挿入する
 * @param entries - 装飾を追加する配列。この関数が末尾へ push する
 * @param pos - アイコンを挿入する文書位置
 * @param calloutType - 描くアイコンの種別
 */
export function pushCalloutTypeLabel(
	entries: DecorationEntry[],
	pos: number,
	calloutType: CalloutType,
): void {
	entries.push({
		from      : pos,
		to        : pos,
		decoration: Decoration.widget({
			widget: new CalloutTypeLabelWidget(calloutType),
			side  : 1,
		}),
	});
}

/**
 * 折りたたみ時に、タイトル行末から本文末までをインライン replace で潰す
 * `block: true` は行境界要件を満たさず描画崩壊の原因になるため使わない。範囲が空のときは何もしない
 * @param entries - 装飾を追加する配列。範囲が空でなければ末尾へ push する
 * @param from - 潰す範囲の開始。タイトル行末
 * @param to - 潰す範囲の終端。コールアウト末尾。from 以上なら追加しない
 */
export function pushCalloutCollapseReplace(
	entries: DecorationEntry[],
	from: number,
	to: number,
): void {
	if (from >= to) {
		return;
	}

	entries.push({
		from,
		to,
		decoration: Decoration.replace({
			widget: calloutCollapseWidget,
		}),
	});
}

// ==============================================
// 重なった装飾の除去
// ==============================================

/**
 * 複数行をまとめて置き換えるウィジェットかを判定する
 * 折りたたみ本文と表ウィジェットが対象。点だけのボタンは含めない
 * @param widget - 装飾が持つウィジェット。ウィジェットでなければ false
 * @returns CalloutCollapseWidget または TableWidget なら true
 */
function isMultiLineReplaceWidget(widget: unknown): boolean {
	return widget instanceof CalloutCollapseWidget || widget instanceof TableWidget;
}

/**
 * 折りたたみや表の複数行 replace の内部に食い込む装飾を除く
 * 複数行 replace 自身と、範囲の端にちょうど乗る point 装飾は残す
 * @param entries - 選別前の装飾。この配列は変更せず、新しい配列を返す
 * @returns 範囲の内部に入っていない装飾。複数行 replace が無ければ入力と同じ配列
 */
export function filterEntriesOutsideCollapseRanges(
	entries: DecorationEntry[],
): DecorationEntry[] {
	const collapseRanges = entries
		.filter((entry) => isMultiLineReplaceWidget(entry.decoration.spec.widget))
		.map((entry) => ({ from: entry.from, to: entry.to }));

	if (collapseRanges.length === 0) {
		return entries;
	}

	return entries.filter((entry) => {
		if (isMultiLineReplaceWidget(entry.decoration.spec.widget)) {
			return true;
		}

		for (const range of collapseRanges) {
			const intersects  = entry.from < range.to && entry.to > range.from;
			const pointOnEdge = entry.from === entry.to
				&& (entry.from === range.from || entry.from === range.to);
			if (intersects && !pointOnEdge) {
				return false;
			}

			// 範囲内部の point widget（fold 以外）も落とす
			if (entry.from === entry.to
				&& entry.from > range.from
				&& entry.from < range.to) {
				return false;
			}
		}

		return true;
	});
}
