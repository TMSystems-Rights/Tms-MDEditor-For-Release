import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** 表の最大幅。表示中の編集領域幅を px で入れる */
export const TABLE_MAX_WIDTH_PROPERTY = '--tms-mde-table-max-width';

export type TableMaxWidthInput = {
	/** スクロールポート右端（ビューポート座標） */
	visibleRight: number;
	/** コンテンツ枠の左端（ビューポート座標） */
	contentLeft: number;
	/** エディタの横スクロール量 */
	scrollLeft: number;
	/** 表の外側で横方向に使う余白 */
	horizontalInset: number;
};

/**
 * 表ラッパーの最大幅を求める。
 * 横スクロール位置が変わっても、表示中の編集領域の幅は変えない。
 * @param {TableMaxWidthInput} input 計測値
 * @returns {number} 最大幅（px）。レイアウト前は 0
 */
export function resolveTableMaxWidth(input: TableMaxWidthInput): number {
	const width = input.visibleRight
		- (input.contentLeft + input.scrollLeft)
		- input.horizontalInset;
	if (!Number.isFinite(width)) {
		return 0;
	}

	return Math.max(0, Math.floor(width));
}

/**
 * CSS の長さを px 数値にする。
 * @param {string} value computed style の値
 * @returns {number} px。解釈できないときは 0
 */
function readCssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 要素の左右 padding・border・margin を合計する。
 * @param {CSSStyleDeclaration} style 計算済みスタイル
 * @returns {number} 左右の合計 px
 */
function readHorizontalBox(style: CSSStyleDeclaration): number {
	return readCssPixels(style.paddingLeft)
		+ readCssPixels(style.paddingRight)
		+ readCssPixels(style.borderLeftWidth)
		+ readCssPixels(style.borderRightWidth)
		+ readCssPixels(style.marginLeft)
		+ readCssPixels(style.marginRight);
}

/**
 * 表示中の編集領域に収まる表の最大幅を測る。
 * @param {EditorView} view 対象エディタ
 * @returns {number} 最大幅（px）
 */
export function readTableMaxWidth(view: EditorView): number {
	const scroller     = view.scrollDOM;
	const content      = view.contentDOM;
	const scrollerRect = scroller.getBoundingClientRect();
	const contentRect  = content.getBoundingClientRect();
	const contentStyle = getComputedStyle(content);
	const line         = content.querySelector('.cm-line');
	const lineStyle    = line instanceof Element ? getComputedStyle(line) : null;
	const wrapper      = content.querySelector('.tms-mde-cm-line-wrapper');
	const wrapperStyle = wrapper instanceof Element ? getComputedStyle(wrapper) : null;
	let inset          = readCssPixels(contentStyle.paddingLeft)
		+ readCssPixels(contentStyle.paddingRight)
		+ readCssPixels(contentStyle.borderLeftWidth)
		+ readCssPixels(contentStyle.borderRightWidth);
	if (lineStyle) {
		inset += readHorizontalBox(lineStyle);
	}

	if (wrapperStyle) {
		inset += readHorizontalBox(wrapperStyle);
	}

	return resolveTableMaxWidth({
		visibleRight    : scrollerRect.left + scroller.clientWidth,
		contentLeft     : contentRect.left,
		scrollLeft      : scroller.scrollLeft,
		horizontalInset : inset,
	});
}

/**
 * 計測した最大幅をエディタの CSS 変数へ書く。0 以下は未レイアウトなので書かない。
 * @param {EditorView} view 対象エディタ
 * @param {number} width 最大幅
 * @returns {void}
 */
function applyTableMaxWidth(view: EditorView, width: number): void {
	if (width <= 0) {
		return;
	}

	const next = `${width}px`;
	if (view.dom.style.getPropertyValue(TABLE_MAX_WIDTH_PROPERTY) === next) {
		return;
	}

	view.dom.style.setProperty(TABLE_MAX_WIDTH_PROPERTY, next);
}

/**
 * 編集領域のサイズに合わせて表の最大幅を更新する。
 */
class TableMaxWidthController {
	private destroyed = false;

	private readonly observer: ResizeObserver;

	/**
	 * @param {EditorView} view 対象エディタ
	 */
	public constructor(private readonly view: EditorView) {
		this.observer = new ResizeObserver(() => {
			this.schedule();
		});
		this.observer.observe(this.view.scrollDOM);
		const gutters = this.view.dom.querySelector('.cm-gutters');
		if (gutters instanceof Element) {
			this.observer.observe(gutters);
		}

		this.schedule();
	}

	/**
	 * 行の寸法が変わったときも最大幅を測り直す。
	 * @param {ViewUpdate} update 更新情報
	 * @returns {void}
	 */
	public update(update: ViewUpdate): void {
		if (update.geometryChanged) {
			this.schedule();
		}
	}

	/**
	 * 監視を解除する。
	 * @returns {void}
	 */
	public destroy(): void {
		this.destroyed = true;
		this.observer.disconnect();
	}

	/**
	 * レイアウト計測を予約する。
	 * @returns {void}
	 */
	private schedule(): void {
		if (this.destroyed) {
			return;
		}

		this.view.requestMeasure({
			key  : TABLE_MAX_WIDTH_PROPERTY,
			/** DOM読取フェーズで最大幅を集計し、レイアウトの読み書きを分離する。 */
			read : (view) => readTableMaxWidth(view),
			/** 書込フェーズでCSS変数だけを更新し、再レイアウトの連鎖を避ける。 */
			write: (width, view) => {
				if (this.destroyed) {
					return;
				}

				applyTableMaxWidth(view, width);
			},
		});
	}
}

/**
 * 表の最大幅を表示中の編集領域へ追従させる拡張を返す。
 * @returns {import('@codemirror/state').Extension} 拡張
 */
export function createTableMaxWidthExtension() {
	return ViewPlugin.define((view) => new TableMaxWidthController(view));
}
