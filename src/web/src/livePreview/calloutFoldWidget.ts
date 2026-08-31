import { Decoration, WidgetType } from '@codemirror/view';
import type { CalloutType } from '../editor/markdownSyntax';
import type { DecorationEntry } from './inlineDecorations';
import { TableWidget } from './tableWidget';

type CalloutIconShape =
	| { kind: 'path'; d: string }
	| { kind: 'circle'; cx: number; cy: number; r: number; fill?: boolean };

/**
 * コールアウト種別ごとの独自 SVG 図形（Obsidian / Lucide 資産の複製ではない）
 * viewBox 0 0 24 24、stroke 描画前提
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

/**
 * 折りたたみ時に本文を潰す空ウィジェット（CodeMirror fold と同様のインライン replace 用）
 */
export class CalloutCollapseWidget extends WidgetType {
	/**
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof CalloutCollapseWidget;
	}

	/**
	 * @returns {HTMLElement}
	 */
	toDOM(): HTMLElement {
		const span     = document.createElement('span');
		span.className = 'cm-md-callout-collapsed';
		span.setAttribute('aria-hidden', 'true');
		return span;
	}

	/**
	 * 高さを 0 に固定し、ビューポート計測の不安定化を防ぐ
	 * @returns {number}
	 */
	get estimatedHeight(): number {
		return 0;
	}

	/**
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

const calloutCollapseWidget = new CalloutCollapseWidget();

/**
 * コールアウト折りたたみトグル用ウィジェット
 */
export class CalloutFoldWidget extends WidgetType {
	readonly collapsed: boolean;

	readonly calloutFrom: number;

	/**
	 * @param {boolean} collapsed 折りたたみ中か
	 * @param {number} calloutFrom Blockquote 開始位置
	 */
	constructor(collapsed: boolean, calloutFrom: number) {
		super();
		this.collapsed   = collapsed;
		this.calloutFrom = calloutFrom;
	}

	/**
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof CalloutFoldWidget
			&& other.collapsed === this.collapsed
			&& other.calloutFrom === this.calloutFrom;
	}

	/**
	 * @returns {HTMLElement}
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
	 * クリックをエディタの domEventHandlers へ渡す（チェックボックスと同じ）
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * コールアウト種別アイコン用ウィジェット
 */
export class CalloutTypeLabelWidget extends WidgetType {
	readonly calloutType: CalloutType;

	/**
	 * @param {CalloutType} calloutType コールアウト種別
	 */
	constructor(calloutType: CalloutType) {
		super();
		this.calloutType = calloutType;
	}

	/**
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof CalloutTypeLabelWidget && other.calloutType === this.calloutType;
	}

	/**
	 * @returns {HTMLElement}
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
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * 折りたたみボタン Decoration を追加する
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} pos 挿入位置
 * @param {boolean} collapsed 折りたたみ中か
 * @param {number} calloutFrom Blockquote 開始位置
 * @returns {void}
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
 * コールアウト種別アイコン Decoration を追加する
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} pos 挿入位置
 * @param {CalloutType} calloutType コールアウト種別
 * @returns {void}
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
 * 折りたたみ時にタイトル行末〜本文末をインライン replace で潰す
 * （`block: true` は行境界要件を満たさず描画崩壊の原因になるため使わない）
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} from 開始位置（タイトル行末）
 * @param {number} to 終了位置（コールアウト末尾）
 * @returns {void}
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

/**
 * 複数行 replace ウィジェットか判定する
 * @param {unknown} widget ウィジェット
 * @returns {boolean}
 */
function isMultiLineReplaceWidget(widget: unknown): boolean {
	return widget instanceof CalloutCollapseWidget || widget instanceof TableWidget;
}

/**
 * 折りたたみ / テーブル等の複数行 replace 範囲の内部に食い込む装飾を除去する
 * @param {DecorationEntry[]} entries エントリ配列
 * @returns {DecorationEntry[]}
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
