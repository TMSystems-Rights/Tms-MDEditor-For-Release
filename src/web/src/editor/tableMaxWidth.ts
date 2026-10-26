/**
 * 表示中の編集領域に合わせて、表の最大幅を CSS 変数へ書く
 * 幅の計算は渡された矩形と余白から行い、表そのものの描画は持たない
 * 呼び出し側は Extension を受け取り、変数の更新タイミングは本ファイルがサイズ変化に合わせて決める
 * @file
 */
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** 表の最大幅を書く CSS 変数名。表示中の編集領域幅を px で入れる */
export const TABLE_MAX_WIDTH_PROPERTY = '--tms-mde-table-max-width';

/**
 * 表の最大幅を、表示中の編集領域から求めるための計測値
 * 座標はビューポート基準。幅の計算は resolveTableMaxWidth が行う
 */
export type TableMaxWidthInput = {
	/** スクロールポート右端（ビューポート座標、px） */
	visibleRight: number;
	/** コンテンツ枠の左端（ビューポート座標、px） */
	contentLeft: number;
	/** エディタの横スクロール量（px）。増えても表示幅自体は変えない */
	scrollLeft: number;
	/** 表の外側で横方向に使う余白（px）。padding、border、行とラッパーの左右を含む */
	horizontalInset: number;
};

// ==============================================
// 最大幅の算出
// ==============================================

/**
 * 表ラッパーの最大幅を求める
 * 横スクロール位置が変わっても、表示中の編集領域の幅は変えない
 * @param input - ビューポート座標と余白。有限な数値でないときは 0
 * @returns 最大幅（px）。端数は切り下げる。レイアウト前や負の結果は 0
 */
export function resolveTableMaxWidth(input: TableMaxWidthInput): number {
	// 表示中の編集領域から余白を引いた幅（px）。非数になり得る
	const width = input.visibleRight - (input.contentLeft + input.scrollLeft) - input.horizontalInset;
	// 有限な数値でなければ、レイアウト前として 0 を返す
	if (!Number.isFinite(width)) {
		return 0;
	}

	return Math.max(0, Math.floor(width));
}

/**
 * CSS の長さを px 数値にする
 * @param value - computed style の値。`px` 以外や空文字は解釈しない
 * @returns px。解釈できないときは 0
 */
function readCssPixels(value: string): number {
	// px として読めた数値。単位付き以外や空文字は NaN になり、0 として扱う
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 要素の左右 padding、border、margin を合計する
 * @param style - 計算済みスタイル。左右 6 辺を px として足す
 * @returns 左右の合計（px）。読めない辺は 0
 */
function readHorizontalBox(style: CSSStyleDeclaration): number {
	return readCssPixels(style.paddingLeft) + readCssPixels(style.paddingRight) + readCssPixels(style.borderLeftWidth) + readCssPixels(style.borderRightWidth) + readCssPixels(style.marginLeft) + readCssPixels(style.marginRight);
}

/**
 * 表示中の編集領域に収まる表の最大幅を測る
 * コンテンツ、行、行ラッパーの左右の箱を余白として引く
 * @param view - 対象エディタ。行やラッパーが無いときは、その分の余白は 0
 * @returns 最大幅（px）。レイアウト前は 0
 */
export function readTableMaxWidth(view: EditorView): number {
	// スクロールポート。右端と横スクロール量はここから取る
	const scroller     = view.scrollDOM;
	// 本文の枠。左端と余白の基準
	const content      = view.contentDOM;
	// スクロールポートの表示矩形（ビューポート座標、px）
	const scrollerRect = scroller.getBoundingClientRect();
	// コンテンツ枠の表示矩形（ビューポート座標、px）
	const contentRect  = content.getBoundingClientRect();
	// コンテンツの計算済みスタイル。左右の padding と border を余白に使う
	const contentStyle = getComputedStyle(content);
	// 最初の行要素。無いレイアウトでは null で、行の余白は足さない
	const line         = content.querySelector('.cm-line');
	// 行の計算済みスタイル。行要素が無いときは null
	const lineStyle    = line instanceof Element ? getComputedStyle(line) : null;
	// 最初の行ラッパー。無いときは null で、ラッパーの余白は足さない
	const wrapper      = content.querySelector('.tms-mde-cm-line-wrapper');
	// ラッパーの計算済みスタイル。ラッパーが無いときは null
	const wrapperStyle = wrapper instanceof Element ? getComputedStyle(wrapper) : null;
	// 表の外側で横に使う余白（px）。コンテンツの左右から始め、行とラッパーがあれば足す
	let inset          = readCssPixels(contentStyle.paddingLeft) + readCssPixels(contentStyle.paddingRight) + readCssPixels(contentStyle.borderLeftWidth) + readCssPixels(contentStyle.borderRightWidth);
	// 行要素があるときだけ、その左右の箱を余白に足す。行が無いレイアウトでは足さない
	if (lineStyle) {
		inset += readHorizontalBox(lineStyle);
	}

	// 行ラッパーがあるときだけ、その左右の箱を余白に足す。ラッパーが無いときは足さない
	if (wrapperStyle) {
		inset += readHorizontalBox(wrapperStyle);
	}

	// 表示中の編集領域に収まる最大幅。横スクロール量は引いても、見える幅自体は変えない
	return resolveTableMaxWidth({
		// スクロールポートの右端（ビューポート座標、px）
		visibleRight: scrollerRect.left + scroller.clientWidth,
		// コンテンツ枠の左端（ビューポート座標、px）
		contentLeft: contentRect.left,
		// 横スクロール量（px）。増えても表示幅の計算には足さない側で使う
		scrollLeft: scroller.scrollLeft,
		// コンテンツ、行、ラッパーの左右を足した余白（px）
		horizontalInset: inset
	});
}

/**
 * 計測した最大幅をエディタの CSS 変数へ書く。0 以下は未レイアウトなので書かない
 * 同じ値なら書き直さず、再レイアウトの連鎖を避ける
 * @param view - 変数を書くエディタ
 * @param width - 最大幅（px）。0 以下は書かない
 */
function applyTableMaxWidth(view: EditorView, width: number): void {
	// 0 以下は未レイアウトなので、変数を書かない。前回の値も消さない
	if (width <= 0) {
		return;
	}

	// 書く CSS 長さ。px 単位の文字列
	const next = `${width}px`;
	// 同じ値なら書き直さない。再レイアウトの連鎖を避ける
	if (view.dom.style.getPropertyValue(TABLE_MAX_WIDTH_PROPERTY) === next) {
		return;
	}

	view.dom.style.setProperty(TABLE_MAX_WIDTH_PROPERTY, next);
}

// ==============================================
// サイズ変化への追従
// ==============================================

/**
 * 編集領域のサイズに合わせて表の最大幅を更新する
 * ResizeObserver と requestMeasure は、このインスタンスがビューの寿命に合わせて持つ
 */
class TableMaxWidthController {
	/** 破棄後は計測結果を書かない。schedule の予約が遅れてもフラグで止める */
	private destroyed = false;

	/** スクロールポートとガターのサイズ変化。破棄で disconnect する */
	private readonly observer: ResizeObserver;

	/**
	 * スクロールポートとガターを監視し、生成時にも最大幅を測る
	 * @param view - 対象エディタ。DOM の CSS 変数はこのビューへ書く
	 */
	public constructor(private readonly view: EditorView) {
		this.observer = new ResizeObserver(() => {
			this.schedule();
		});
		this.observer.observe(this.view.scrollDOM);
		// ガター。幅が変わると編集領域の残り幅も変わる。無いテーマでは null
		const gutters = this.view.dom.querySelector('.cm-gutters');
		// ガター要素があるときだけ監視する。無いときはスクロールポートだけで幅を追う
		if (gutters instanceof Element) {
			this.observer.observe(gutters);
		}

		this.schedule();
	}

	/**
	 * 行の寸法が変わったときも最大幅を測り直す
	 * @param update - 今回のビュー更新。geometryChanged のときだけ測り直す
	 */
	public update(update: ViewUpdate): void {
		// 行の寸法が変わったときだけ最大幅を測り直す。選択だけの更新では測らない
		if (update.geometryChanged) {
			this.schedule();
		}
	}

	/**
	 * 監視を解除し、遅れて届く計測結果は書かないようにする
	 */
	public destroy(): void {
		this.destroyed = true;
		this.observer.disconnect();
	}

	/**
	 * レイアウト計測を予約する
	 * 読取と書込を requestMeasure の別フェーズに分け、読取の途中で CSS 変数を書かない
	 */
	private schedule(): void {
		// 破棄後の予約は計測しない。遅れて届く結果を書かない
		if (this.destroyed) {
			return;
		}

		// 読取と書込を分けて、読取の途中で CSS 変数を書かない
		this.view.requestMeasure({
			key: TABLE_MAX_WIDTH_PROPERTY,
			/**
			 * DOM 読取フェーズで最大幅を集計し、レイアウトの読み書きを分離する
			 * @param view - 計測対象のエディタ
			 * @returns 表示中の編集領域に収まる最大幅（px）。レイアウト前は 0
			 */
			read: (view) => readTableMaxWidth(view),
			/**
			 * 書込フェーズで CSS 変数だけを更新し、再レイアウトの連鎖を避ける
			 * @param width - read が測った最大幅（px）。0 以下は未レイアウトなので書かない
			 * @param view - CSS 変数を書くエディタ。破棄済みなら書かない
			 */
			write: (width, view) => {
				// 計測のあいだに破棄されていたら、CSS 変数を書かない
				if (this.destroyed) {
					return;
				}

				applyTableMaxWidth(view, width);
			}
		});
	}
}

/**
 * 表の最大幅を表示中の編集領域へ追従させる Extension を返す
 * @returns ビューごとに TableMaxWidthController を作る Extension
 */
export function createTableMaxWidthExtension() {
	return ViewPlugin.define((view) => new TableMaxWidthController(view));
}
