import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** 固定対象の見出しセル。選択セルより手前に描く */
export const TABLE_HEADER_PIN_CLASS = 'cm-md-table-pin-cell';

const TABLE_HEADER_PIN_KEY = 'tms-mde-table-header-pin';

type ScrollTimelineConstructor = new (options: {
	source: Element;
	axis: 'block' | 'inline' | 'x' | 'y';
}) => AnimationTimeline;

/** 見出しを留める基準位置と、下へ動かせる量 */
export type TableHeaderPinSpan = {
	/** スクロール内容上の基準位置 */
	headerDocTop: number;
	/** 見出しを下へ動かせる最大量 */
	maxTravel: number;
};

/**
 * 表全体の高さと、表の枠だけが縦スクロールする場合の見える高さを切り替える。
 * 枠の中をスクロールしているとき、表の全高を使うと見出しがデータ行の中へめり込む。
 * @param {boolean} scrollsInside 表の枠自身が縦スクロールするか
 * @param {number} wrapDocTop 表の枠の位置（スクロール内容の上端から）
 * @param {number} wrapClientHeight 表の枠の見える高さ
 * @param {number} headerDocTop 見出しの位置（スクロール内容の上端から）
 * @param {number} headerHeight 見出しの高さ
 * @param {number} tableBottom 表の下端（スクロール内容の上端から）
 * @returns {TableHeaderPinSpan} 基準位置と移動量
 */
export function resolveTableHeaderPinSpan(
	scrollsInside: boolean,
	wrapDocTop: number,
	wrapClientHeight: number,
	headerDocTop: number,
	headerHeight: number,
	tableBottom: number,
): TableHeaderPinSpan {
	if (scrollsInside) {
		return {
			headerDocTop: wrapDocTop,
			maxTravel    : Math.max(0, wrapClientHeight - headerHeight),
		};
	}

	return {
		headerDocTop,
		maxTravel: tableBottom - headerDocTop - headerHeight,
	};
}

/** データ行が見出しの裏に入っているあいだ、仕切りを出すセル */
const TABLE_HEADER_COVERING_CLASS = 'cm-md-table-pin-covering';

/** スクロール位置に対する見出しのずらし */
export type TableHeaderPinFrame = {
	/** エディタスクロール全体に対する位置（0〜1） */
	offset: number;
	/** 下へずらす px */
	translateY: number;
};

type TableHeaderPinUpdate = {
	wrap: HTMLElement;
	cells: HTMLElement[];
	stale: HTMLElement[];
	frames: TableHeaderPinFrame[];
	headerDocTop: number;
	signature: string;
	skip: boolean;
};

/**
 * データ行が見出しの裏に入っているかを返す。
 * @param {number} scrollTop エディタのスクロール量
 * @param {number} headerDocTop 見出しの基準位置
 * @param {number} wrapScrollTop 表の枠自身のスクロール量
 * @returns {boolean} 隠れているなら true
 */
export function isTableHeaderCovering(scrollTop: number, headerDocTop: number, wrapScrollTop: number): boolean {
	const documentCovering = Number.isFinite(headerDocTop) && scrollTop > headerDocTop + 0.5;
	return documentCovering || wrapScrollTop > 1;
}

/**
 * エディタのスクロール範囲に対する見出しのずらしキーフレームを返す。
 * スクロールの途中では線形補間が、その時点の必要量と一致する。
 * @param {number} headerDocTop 見出しのレイアウト位置（スクロール内容の上端から）
 * @param {number} maxTravel 見出しを下へ動かせる最大量
 * @param {number} maxScroll エディタの最大スクロール量
 * @returns {TableHeaderPinFrame[]} 空なら固定しない
 */
export function buildTableHeaderPinFrames(
	headerDocTop: number,
	maxTravel: number,
	maxScroll: number,
): TableHeaderPinFrame[] {
	if (!Number.isFinite(headerDocTop) || !Number.isFinite(maxTravel) || !Number.isFinite(maxScroll)) {
		return [];
	}
	if (maxTravel <= 0 || maxScroll <= 0) {
		return [];
	}

	/**
	 *
	 */
	const at = (scroll: number): number => Math.max(0, Math.min(maxTravel, scroll - headerDocTop));
	const frames: TableHeaderPinFrame[] = [
		{ offset: 0, translateY: at(0) },
		{ offset: 1, translateY: at(maxScroll) },
	];
	const start                         = headerDocTop / maxScroll;
	const end                           = (headerDocTop + maxTravel) / maxScroll;
	if (start > 0 && start < 1) {
		frames.push({ offset: start, translateY: 0 });
	}
	if (end > 0 && end < 1) {
		frames.push({ offset: end, translateY: maxTravel });
	}

	frames.sort((left, right) => left.offset - right.offset);
	const unique: TableHeaderPinFrame[] = [];
	frames.forEach((frame) => {
		const last = unique[unique.length - 1];
		if (last && Math.abs(last.offset - frame.offset) < 1e-4) {
			return;
		}
		unique.push(frame);
	});
	return unique;
}

/**
 * ライブプレビューの表見出しを、エディタのスクロールと同時に留める。
 * スクロールイベントで位置を書き直すと1フレーム遅れてちらつくため、スクロール連動アニメーションを使う。
 * @returns {import('@codemirror/state').Extension} 拡張
 */
export function createTableHeaderPinExtension() {
	return ViewPlugin.define((view) => new TableHeaderPinController(view));
}

/**
 * 表の寸法が変わったときだけ、見出しのスクロール連動アニメーションを張り直す。
 */
class TableHeaderPinController {
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
		this.observer.observe(this.view.contentDOM);
		this.view.scrollDOM.addEventListener('scroll', this.onWrapScroll, { capture: true, passive: true });
		this.schedule();
	}

	/**
	 * 文書や行の高さが変わったとき、見出し位置を測り直す。
	 * スクロールだけでは張り直さない。
	 * @param {ViewUpdate} update 更新情報
	 * @returns {void}
	 */
	public update(update: ViewUpdate): void {
		if (update.docChanged || update.geometryChanged) {
			this.schedule();
		}
	}

	/**
	 * 監視を解除する。
	 * @returns {void}
	 */
	public destroy(): void {
		this.destroyed = true;
		this.view.scrollDOM.removeEventListener('scroll', this.onWrapScroll, { capture: true });
		this.observer.disconnect();
		this.view.dom.querySelectorAll<HTMLElement>(`.${TABLE_HEADER_PIN_CLASS}`).forEach((cell) => {
			clearTableHeaderPin(cell);
		});
	}

	/**
	 * 仕切りは、隠れ始めた瞬間と戻った瞬間だけ切り替える。
	 * 見出しの移動そのものはスクロール連動アニメーションに任せる。
	 * @param {Event} event スクロールイベント
	 * @returns {void}
	 */
	private readonly onWrapScroll = (event: Event): void => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return;
		}
		if (target === this.view.scrollDOM) {
			target.querySelectorAll<HTMLElement>('.cm-md-table-wrap, .cm-md-html-table-wrap').forEach((wrap) => {
				syncTableHeaderCovering(wrap, target.scrollTop);
			});
			return;
		}
		if (!target.classList.contains('cm-md-table-wrap') && !target.classList.contains('cm-md-html-table-wrap')) {
			return;
		}

		syncTableHeaderCovering(target, this.view.scrollDOM.scrollTop);
	};

	/**
	 * 見出し位置の計測を次のレイアウトへ予約する。
	 * @returns {void}
	 */
	private schedule(): void {
		if (this.destroyed) {
			return;
		}

		this.view.requestMeasure({
			key  : TABLE_HEADER_PIN_KEY,
			/** DOM読取フェーズで、スクロール範囲に対するずらし量を決める。 */
			read : (view) => readTableHeaderPinUpdates(view),
			/** 書込フェーズでスクロール連動アニメーションを張り替える。 */
			write: (updates) => {
				if (this.destroyed) {
					return;
				}

				applyTableHeaderPinUpdates(updates, this.view.scrollDOM);
			},
		});
	}
}

/**
 * 表示中の表について、アニメーションの張り替えが必要かを集める。
 * @param {EditorView} view 対象エディタ
 * @returns {TableHeaderPinUpdate[]} 表ごとの更新
 */
function readTableHeaderPinUpdates(view: EditorView): TableHeaderPinUpdate[] {
	const updates: TableHeaderPinUpdate[] = [];
	view.dom.querySelectorAll<HTMLElement>('.cm-md-table-wrap, .cm-md-html-table-wrap').forEach((wrap) => {
		updates.push(readTableHeaderPinUpdate(wrap, view.scrollDOM));
	});
	return updates;
}

/**
 * 1つの表のずらしキーフレームを測る。寸法が同じなら張り替えない。
 * @param {HTMLElement} wrap 表ラッパー
 * @param {HTMLElement} scroller エディタのスクロール要素
 * @returns {TableHeaderPinUpdate} 更新内容
 */
function readTableHeaderPinUpdate(wrap: HTMLElement, scroller: HTMLElement): TableHeaderPinUpdate {
	const cells = findTableHeaderPinCells(wrap);
	const keep  = new Set(cells);
	const stale = [...wrap.querySelectorAll<HTMLElement>(`.${TABLE_HEADER_PIN_CLASS}`)]
		.filter((cell) => !keep.has(cell));
	if (cells.length === 0 || !canUseScrollTimeline()) {
		return {
			wrap,
			cells,
			stale: stale.concat(cells),
			frames: [],
			headerDocTop: Number.NaN,
			signature: '',
			skip: false,
		};
	}

	const table = wrap.querySelector('table');
	if (!table) {
		return {
			wrap,
			cells,
			stale: stale.concat(cells),
			frames: [],
			headerDocTop: Number.NaN,
			signature: '',
			skip: false,
		};
	}

	const translateY       = readTranslateY(cells[0]);
	const rects            = cells.map((cell) => cell.getBoundingClientRect());
	const scrollerRect     = scroller.getBoundingClientRect();
	const visualTop        = Math.min(...rects.map((rect) => rect.top)) - translateY;
	const headerHeight     = Math.max(...rects.map((rect) => rect.bottom)) - Math.min(...rects.map((rect) => rect.top));
	const measuredTop      = visualTop - scrollerRect.top + scroller.scrollTop;
	const tableBottom      = table.getBoundingClientRect().bottom - scrollerRect.top + scroller.scrollTop;
	const wrapDocTop       = wrap.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop;
	const scrollsInside    = wrap.scrollHeight > wrap.clientHeight + 2;
	const span             = resolveTableHeaderPinSpan(
		scrollsInside,
		wrapDocTop,
		wrap.clientHeight,
		measuredTop,
		headerHeight,
		tableBottom,
	);
	const { headerDocTop } = span;
	const { maxTravel }    = span;
	const maxScroll        = scroller.scrollHeight - scroller.clientHeight;
	const frames           = buildTableHeaderPinFrames(headerDocTop, maxTravel, maxScroll);
	const signature        = [
		headerDocTop,
		maxTravel,
		maxScroll,
	].map((value) => value.toFixed(2)).join('|');
	const bound            = cells.every((cell) => cell.getAnimations().some((animation) => animation.id === TABLE_HEADER_PIN_KEY));
	return {
		wrap,
		cells,
		stale,
		frames,
		headerDocTop,
		signature,
		skip: bound && wrap.dataset.tmsMdeHeaderPin === signature,
	};
}

/**
 * 測り直した表へスクロール連動アニメーションを付ける。
 * @param {TableHeaderPinUpdate[]} updates 表ごとの更新
 * @param {HTMLElement} scroller エディタのスクロール要素
 * @returns {void}
 */
function applyTableHeaderPinUpdates(updates: TableHeaderPinUpdate[], scroller: HTMLElement): void {
	updates.forEach((update) => {
		update.stale.forEach((cell) => {
			clearTableHeaderPin(cell);
		});
		if (update.skip) {
			return;
		}

		update.wrap.dataset.tmsMdeHeaderPin = update.signature;
		if (update.frames.length === 0) {
			delete update.wrap.dataset.tmsMdeHeaderPinTop;
			update.cells.forEach((cell) => {
				clearTableHeaderPin(cell);
			});
			return;
		}

		update.wrap.dataset.tmsMdeHeaderPinTop = String(update.headerDocTop);
		bindTableHeaderPin(update.cells, update.frames, scroller);
		syncTableHeaderCovering(update.wrap, scroller.scrollTop);
	});
}

/**
 * 見出しセルをエディタの縦スクロールに連動させる。
 * @param {HTMLElement[]} cells 見出しセル
 * @param {TableHeaderPinFrame[]} frames ずらしキーフレーム
 * @param {HTMLElement} scroller エディタのスクロール要素
 * @returns {void}
 */
function bindTableHeaderPin(
	cells: HTMLElement[],
	frames: TableHeaderPinFrame[],
	scroller: HTMLElement,
): void {
	const keyframes: Keyframe[] = frames.map((frame) => ({
		offset   : frame.offset,
		transform: `translateY(${frame.translateY}px)`,
	}));
	const timeline              = createScrollTimeline(scroller);
	cells.forEach((cell) => {
		clearTableHeaderPin(cell);
		cell.classList.add(TABLE_HEADER_PIN_CLASS);
		const animation = cell.animate(keyframes, {
			fill: 'both',
			id  : TABLE_HEADER_PIN_KEY,
			timeline,
		});
		animation.id    = TABLE_HEADER_PIN_KEY;
	});
}

/**
 * 見出しの固定アニメーションと印を外す。
 * @param {HTMLElement} cell セル
 * @returns {void}
 */
function clearTableHeaderPin(cell: HTMLElement): void {
	cell.getAnimations().forEach((animation) => {
		if (animation.id === TABLE_HEADER_PIN_KEY) {
			animation.cancel();
		}
	});
	cell.style.transform = '';
	cell.classList.remove(TABLE_HEADER_PIN_CLASS, TABLE_HEADER_COVERING_CLASS);
}

/**
 * 表の枠内スクロールでデータ行が隠れているあいだ、仕切りを出す。
 * @param {HTMLElement} wrap 表ラッパー
 * @returns {void}
 */
function syncTableHeaderCovering(wrap: HTMLElement, scrollTop: number): void {
	const headerDocTop = Number(wrap.dataset.tmsMdeHeaderPinTop);
	const covering     = isTableHeaderCovering(scrollTop, headerDocTop, wrap.scrollTop);
	wrap.querySelectorAll<HTMLElement>(`.${TABLE_HEADER_PIN_CLASS}`).forEach((cell) => {
		if (cell.classList.contains(TABLE_HEADER_COVERING_CLASS) !== covering) {
			cell.classList.toggle(TABLE_HEADER_COVERING_CLASS, covering);
		}
	});
}

/**
 * スクロール連動アニメーションが使えるか。
 * @returns {boolean} 使えるなら true
 */
function canUseScrollTimeline(): boolean {
	return scrollTimelineConstructor() !== null;
}

/**
 * エディタの縦スクロールに紐づくタイムラインを作る。
 * @param {HTMLElement} scroller エディタのスクロール要素
 * @returns {AnimationTimeline} タイムライン
 */
function createScrollTimeline(scroller: HTMLElement): AnimationTimeline {
	const ScrollTimeline = scrollTimelineConstructor();
	if (!ScrollTimeline) {
		throw new Error('ScrollTimeline がありません。');
	}

	return new ScrollTimeline({
		source: scroller,
		axis  : 'block',
	});
}

/**
 * 実行環境の ScrollTimeline コンストラクタを返す。
 * @returns {ScrollTimelineConstructor | null} 未対応なら null
 */
function scrollTimelineConstructor(): ScrollTimelineConstructor | null {
	const host = globalThis as { ScrollTimeline?: ScrollTimelineConstructor };
	return host.ScrollTimeline ?? null;
}

/**
 * 留める見出しセルを返す。
 * GFM 表は thead の先頭行。HTML 表は thead の先頭行、無ければ th を含む先頭行。
 * @param {HTMLElement} wrap 表ラッパー
 * @returns {HTMLElement[]} 見出しセル
 */
export function findTableHeaderPinCells(wrap: HTMLElement): HTMLElement[] {
	const table = wrap.querySelector('table');
	if (!table) {
		return [];
	}

	const thead = table.querySelector('thead');
	if (thead) {
		const row = thead.querySelector(':scope > tr');
		return row ? rowCells(row) : [];
	}

	const firstRow = table.querySelector(':scope > tr') ?? table.querySelector(':scope > tbody > tr');
	if (!firstRow?.querySelector(':scope > th')) {
		return [];
	}

	return rowCells(firstRow);
}

/**
 * 行の直接のセルを返す。
 * @param {Element} row 行
 * @returns {HTMLElement[]} th / td
 */
function rowCells(row: Element): HTMLElement[] {
	return [...row.children].filter((child): child is HTMLElement =>
		child instanceof HTMLElement && (child.tagName === 'TH' || child.tagName === 'TD'));
}

/**
 * 適用中の translateY を返す。スクロール連動アニメーションの値を含む。
 * @param {HTMLElement} cell 見出しセル
 * @returns {number} px
 */
function readTranslateY(cell: HTMLElement): number {
	const transform = getComputedStyle(cell).transform;
	if (!transform || transform === 'none') {
		return 0;
	}

	return new DOMMatrix(transform).m42;
}
