/**
 * ライブプレビューの表見出しを、エディタのスクロールに追従して留める
 * 文書は変えず、描画済みの見出しセルへスクロール連動アニメーションを張る
 * @file
 */
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** 固定対象の見出しセル。選択セルより手前に描く */
export const TABLE_HEADER_PIN_CLASS = 'cm-md-table-pin-cell';

/** 列選択ヘッダーの余白（px）。表示中の padding-top と背面の高さと同じ */
const TABLE_STRUCTURE_PIN_GUTTER_PX = 26;

/** 列選択を出している枠。このときだけ余白の分だけ早く留める */
const TABLE_STRUCTURE_CONTROLS_VISIBLE_CLASS = 'cm-md-table-structure-controls-visible';

/** 見出しと同じ縦ずらしを付ける列選択の帯と、行選択列の見出し。行ボタンは行に残す */
const TABLE_COLUMN_STRUCTURE_PIN_SELECTOR = '.cm-md-table-structure-column-band, .cm-md-table-structure-row-head';

/** 見出し位置の再計測をまとめる requestMeasure のキー */
const TABLE_HEADER_PIN_KEY = 'tms-mde-table-header-pin';

/** スクロール連動アニメーションのコンストラクタ。未対応環境では使わない */
type ScrollTimelineConstructor = new (options: { source: Element; axis: 'block' | 'inline' | 'x' | 'y' }) => AnimationTimeline;

/** 見出しを留める基準位置と、下へ動かせる量 */
export type TableHeaderPinSpan = {
	/** スクロール内容上の基準位置 */
	headerDocTop: number;
	/** 見出しを下へ動かせる最大量 */
	maxTravel: number;
};

/**
 * 表全体の高さと、表の枠だけが縦スクロールする場合の見える高さを切り替える
 * 枠の中をスクロールしているとき、表の全高を使うと見出しがデータ行の中へめり込む
 * @param scrollsInside - 表の枠自身が縦スクロールするか
 * @param wrapDocTop - 表の枠の位置（スクロール内容の上端から）
 * @param wrapClientHeight - 表の枠の見える高さ
 * @param headerDocTop - 見出しの位置（スクロール内容の上端から）
 * @param headerHeight - 見出しの高さ
 * @param tableBottom - 表の下端（スクロール内容の上端から）
 * @param structureGutter - 列選択ヘッダーの余白（px）。出ていなければ 0
 * @returns 基準位置と移動量
 */
export function resolveTableHeaderPinSpan(scrollsInside: boolean, wrapDocTop: number, wrapClientHeight: number, headerDocTop: number, headerHeight: number, tableBottom: number, structureGutter = 0): TableHeaderPinSpan {
	// 余白。負や非数は 0。列選択が無いときは固定の開始を早めない
	const gutter = Number.isFinite(structureGutter) ? Math.max(0, structureGutter) : 0;
	// 枠自身が縦スクロールするときは、表の全高ではなく見える高さで留める
	if (scrollsInside) {
		// 枠の中をスクロールするときの基準と移動量。余白は枠の padding が空ける
		return {
			// 基準は枠の上端。見出し行の文書位置は使わない
			headerDocTop: wrapDocTop,
			// 見える高さから見出しと列選択の余白を引いた量。負なら 0
			maxTravel: Math.max(0, wrapClientHeight - headerHeight - gutter)
		};
	}

	// 列選択の上端。見出しより余白分だけ前。文書先頭より前にはしない
	const origin = Math.max(0, headerDocTop - gutter);
	// エディタ全体のスクロールで留めるときの基準と移動量
	return {
		// 列選択が見える位置。余白が無ければ見出し自身
		headerDocTop: origin,
		// 見出し自身が表の下端まで動ける量。余白の分は移動量へ足さない
		maxTravel: Math.max(0, tableBottom - headerDocTop - headerHeight)
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

/** 1つの表へ見出し固定を張り直すための計測結果 */
type TableHeaderPinUpdate = {
	/** 対象の表の枠 */
	wrap: HTMLElement;
	/** 固定する見出しセル */
	cells: HTMLElement[];
	/** もう固定しないセル。アニメーションを外す */
	stale: HTMLElement[];
	/** スクロール位置に対するずらしのキーフレーム */
	frames: TableHeaderPinFrame[];
	/** 見出しの基準位置。スクロール内容の上端から（px） */
	headerDocTop: number;
	/** 寸法が変わったかを見る文字列。同じなら張り直さない */
	signature: string;
	/** 計測不能で、今回は何もしないなら true */
	skip: boolean;
};

/**
 * データ行が見出しの裏に入っているかを返す
 * @param scrollTop - エディタのスクロール量
 * @param headerDocTop - 見出しの基準位置
 * @param wrapScrollTop - 表の枠自身のスクロール量
 * @returns 隠れているなら true
 */
export function isTableHeaderCovering(scrollTop: number, headerDocTop: number, wrapScrollTop: number): boolean {
	// 文書スクロールが見出しを 0.5px より超えたか。位置が数値でないときは false
	const documentCovering = Number.isFinite(headerDocTop) && scrollTop > headerDocTop + 0.5;
	return documentCovering || wrapScrollTop > 1;
}

/**
 * エディタのスクロール範囲に対する見出しのずらしキーフレームを返す
 * スクロールの途中では線形補間が、その時点の必要量と一致する
 * @param headerDocTop - 見出しのレイアウト位置（スクロール内容の上端から）
 * @param maxTravel - 見出しを下へ動かせる最大量
 * @param maxScroll - エディタの最大スクロール量
 * @returns 空なら固定しない
 */
export function buildTableHeaderPinFrames(headerDocTop: number, maxTravel: number, maxScroll: number): TableHeaderPinFrame[] {
	// 基準、移動量、最大スクロールのどれかが数値でないときは固定しない
	if (!Number.isFinite(headerDocTop) || !Number.isFinite(maxTravel) || !Number.isFinite(maxScroll)) {
		return [];
	}
	// 動かせる量か最大スクロールが 0 以下なら固定しない。どちらか一方でも空
	if (maxTravel <= 0 || maxScroll <= 0) {
		return [];
	}

	/**
	 * スクロール位置を、見出しが動ける範囲へ収める
	 * @param scroll - エディタのスクロール量（px）
	 * @returns 0 から maxTravel までのずらし量（px）
	 */
	const at                            = (scroll: number): number => Math.max(0, Math.min(maxTravel, scroll - headerDocTop));
	// スクロールの両端。途中の折れ点は後から足す
	const frames: TableHeaderPinFrame[] = [
		{
			// スクロール先頭
			offset: 0,
			// 先頭でのずらし。見出しより前なら 0
			translateY: at(0)
		},
		{
			// スクロール末尾
			offset: 1,
			// 末尾でのずらし。上限は maxTravel
			translateY: at(maxScroll)
		}
	];
	// 見出しに到達するスクロール割合。0 未満や 1 超は折れ点にしない
	const start                         = headerDocTop / maxScroll;
	// 移動量を使い切るスクロール割合
	const end                           = (headerDocTop + maxTravel) / maxScroll;
	// 先頭でも末尾でもない位置で見出しに着くときだけ、ずらし 0 の折れ点を足す。どちらか一方では足さない
	if (start > 0 && start < 1) {
		// 見出しに到達した瞬間。まだずらさない
		frames.push({
			// 到達位置の割合
			offset: start,
			// 到達までは 0
			translateY: 0
		});
	}
	// 先頭でも末尾でもない位置で移動量を使い切るときだけ、上限の折れ点を足す。どちらか一方では足さない
	if (end > 0 && end < 1) {
		// 移動量を使い切った瞬間
		frames.push({
			// 使い切り位置の割合
			offset: end,
			// これ以上は下げない
			translateY: maxTravel
		});
	}

	frames.sort((left, right) => left.offset - right.offset);
	const unique: TableHeaderPinFrame[] = [];
	frames.forEach((frame) => {
		// 直前に採用した折れ点。最初は undefined
		const last = unique[unique.length - 1];
		// 直前と割合がほぼ同じ折れ点は捨てる。最初の 1 件は残す
		if (last && Math.abs(last.offset - frame.offset) < 1e-4) {
			return;
		}
		unique.push(frame);
	});
	return unique;
}

/**
 * ライブプレビューの表見出しを、エディタのスクロールと同時に留める
 * スクロールイベントで位置を書き直すと1フレーム遅れてちらつくため、スクロール連動アニメーションを使う
 * @returns 拡張
 */
export function createTableHeaderPinExtension() {
	return ViewPlugin.define((view) => new TableHeaderPinController(view));
}

/**
 * 表の寸法が変わったときだけ、見出しのスクロール連動アニメーションを張り直す
 */
class TableHeaderPinController {
	/** 破棄済みなら true。以降の計測と書き込みを止める */
	private destroyed = false;

	/** 表とスクロール領域の寸法変化。コンストラクタで監視を始める */
	private readonly observer: ResizeObserver;

	/**
	 * @param view - 対象エディタ
	 */
	public constructor(private readonly view: EditorView) {
		this.observer = new ResizeObserver(() => {
			this.schedule();
		});
		this.observer.observe(this.view.scrollDOM);
		this.observer.observe(this.view.contentDOM);
		// 枠内スクロールでも仕切りを切り替える。見出しの移動はアニメーション側
		this.view.scrollDOM.addEventListener('scroll', this.onWrapScroll, { capture: true, passive: true });
		this.schedule();
	}

	/**
	 * 文書や行の高さが変わったとき、見出し位置を測り直す
	 * スクロールだけでは張り直さない
	 * @param update - 更新情報
	 */
	public update(update: ViewUpdate): void {
		// 本文か寸法が変わったときだけ測り直す。スクロールだけでは張り直さない
		if (update.docChanged || update.geometryChanged) {
			this.schedule();
		}
	}

	/**
	 * 監視を解除する
	 */
	public destroy(): void {
		this.destroyed = true;
		this.view.scrollDOM.removeEventListener('scroll', this.onWrapScroll, { capture: true });
		this.observer.disconnect();
		this.view.dom.querySelectorAll<HTMLElement>(`.${TABLE_HEADER_PIN_CLASS}`).forEach((cell) => {
			clearTableHeaderPin(cell);
		});
		this.view.dom.querySelectorAll<HTMLElement>(TABLE_COLUMN_STRUCTURE_PIN_SELECTOR).forEach((element) => {
			clearScrollLinkedPin(element);
		});
	}

	/**
	 * 仕切りは、隠れ始めた瞬間と戻った瞬間だけ切り替える
	 * 見出しの移動そのものはスクロール連動アニメーションに任せる
	 * @param event - スクロールイベント
	 */
	private readonly onWrapScroll = (event: Event): void => {
		// スクロールした要素。要素でないターゲットは見ない
		const target = event.target;
		// 要素でないスクロールは仕切りを変えない
		if (!(target instanceof HTMLElement)) {
			return;
		}
		// エディタ全体のスクロールでは、表示中の表すべてを更新する
		if (target === this.view.scrollDOM) {
			target.querySelectorAll<HTMLElement>('.cm-md-table-wrap, .cm-md-html-table-wrap').forEach((wrap) => {
				syncTableHeaderCovering(wrap, target.scrollTop);
			});
			return;
		}
		// 表の枠でも HTML 表の枠でもない要素は見ない。どちらか一方でも return
		if (!target.classList.contains('cm-md-table-wrap') && !target.classList.contains('cm-md-html-table-wrap')) {
			return;
		}

		syncTableHeaderCovering(target, this.view.scrollDOM.scrollTop);
	};

	/**
	 * 見出し位置の計測を次のレイアウトへ予約する
	 */
	private schedule(): void {
		// 破棄後の計測は予約しない
		if (this.destroyed) {
			return;
		}

		// 次のレイアウトで読み、同じフレームの書き込みで張り替える
		this.view.requestMeasure({
			// 同じキーの計測は 1 回にまとめる
			key: TABLE_HEADER_PIN_KEY,
			/** DOM読取フェーズで、スクロール範囲に対するずらし量を決める */
			read: (view) => readTableHeaderPinUpdates(view),
			/** 書込フェーズでスクロール連動アニメーションを張り替える */
			write: (updates) => {
				// 破棄後の書き込みはアニメーションを張り替えない
				if (this.destroyed) {
					return;
				}

				applyTableHeaderPinUpdates(updates, this.view.scrollDOM);
			}
		});
	}
}

/**
 * 表示中の表について、アニメーションの張り替えが必要かを集める
 * @param view - 対象エディタ
 * @returns 表ごとの更新
 */
function readTableHeaderPinUpdates(view: EditorView): TableHeaderPinUpdate[] {
	// 表ごとの更新。対象が無ければ空
	const updates: TableHeaderPinUpdate[] = [];
	view.dom.querySelectorAll<HTMLElement>('.cm-md-table-wrap, .cm-md-html-table-wrap').forEach((wrap) => {
		updates.push(readTableHeaderPinUpdate(wrap, view.scrollDOM));
	});
	return updates;
}

/**
 * 1つの表のずらしキーフレームを測る。寸法が同じなら張り替えない
 * @param wrap - 表ラッパー
 * @param scroller - エディタのスクロール要素
 * @returns 更新内容
 */
function readTableHeaderPinUpdate(wrap: HTMLElement, scroller: HTMLElement): TableHeaderPinUpdate {
	// 留める見出しセル。無ければ空
	const cells = findTableHeaderPinCells(wrap);
	// 今回残すセル。以前の固定でこれに無いものは外す
	const keep  = new Set(cells);
	// もう見出しでないセル。固定クラスが残っているもの
	const stale = [...wrap.querySelectorAll<HTMLElement>(`.${TABLE_HEADER_PIN_CLASS}`)].filter((cell) => !keep.has(cell));
	// 見出しが無い、またはスクロール連動が使えないときは固定を外す。どちらか一方でも外す
	if (cells.length === 0 || !canUseScrollTimeline()) {
		// 固定を外す更新。寸法は測らない
		return {
			// 対象の枠
			wrap,
			// 見出しセル。空もあり得る
			cells,
			// 既存の固定と、今回のセルも外す
			stale: stale.concat(cells),
			// キーフレームは作らない
			frames: [],
			// 基準位置は未計測
			headerDocTop: Number.NaN,
			// 寸法の印は空
			signature: '',
			// 外す処理は行う
			skip: false
		};
	}

	// 枠の中の表。無ければ固定しない
	const table = wrap.querySelector('table');
	// 表要素が無い枠は固定を外す
	if (!table) {
		// 固定を外す更新。表が無いので寸法は測らない
		return {
			// 対象の枠
			wrap,
			// 見出しとして見つけたセル
			cells,
			// 既存の固定と今回のセルも外す
			stale: stale.concat(cells),
			// キーフレームは作らない
			frames: [],
			// 基準位置は未計測
			headerDocTop: Number.NaN,
			// 寸法の印は空
			signature: '',
			// 外す処理は行う
			skip: false
		};
	}

	// 先頭セルに既に掛かっている縦ずらし（px）。位置の計測から引く
	const translateY       = readTranslateY(cells[0]);
	// 見出しセルの画面矩形
	const rects            = cells.map((cell) => cell.getBoundingClientRect());
	// スクロール要素の画面矩形。文書位置へ戻す基準
	const scrollerRect     = scroller.getBoundingClientRect();
	// ずらしを除いた見出しの上端。画面座標
	const visualTop        = Math.min(...rects.map((rect) => rect.top)) - translateY;
	// 見出しの高さ。複数セルの上下端から取る
	const headerHeight     = Math.max(...rects.map((rect) => rect.bottom)) - Math.min(...rects.map((rect) => rect.top));
	// スクロール内容の上端から見た見出し位置
	const measuredTop      = visualTop - scrollerRect.top + scroller.scrollTop;
	// スクロール内容の上端から見た表の下端
	const tableBottom      = table.getBoundingClientRect().bottom - scrollerRect.top + scroller.scrollTop;
	// スクロール内容の上端から見た枠の上端
	const wrapDocTop       = wrap.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop;
	// 枠自身が縦スクロールするなら true。2px 以内の差は誤差
	const scrollsInside    = wrap.scrollHeight > wrap.clientHeight + 2;
	// 列選択の余白。出ていなければ 0。文書スクロールではこの分だけ早く留める
	const structureGutter  = wrap.classList.contains(TABLE_STRUCTURE_CONTROLS_VISIBLE_CLASS) ? TABLE_STRUCTURE_PIN_GUTTER_PX : 0;
	// 枠内スクロールか文書スクロールかで切り替えた基準と移動量
	const span             = resolveTableHeaderPinSpan(scrollsInside, wrapDocTop, wrap.clientHeight, measuredTop, headerHeight, tableBottom, structureGutter);
	// 見出しの基準位置（px）
	const { headerDocTop } = span;
	// 下へ動かせる最大量（px）
	const { maxTravel }    = span;
	// エディタの最大スクロール量（px）。0 以下なら固定しない
	const maxScroll        = scroller.scrollHeight - scroller.clientHeight;
	// スクロール割合に対するずらし。固定しないときは空
	const frames           = buildTableHeaderPinFrames(headerDocTop, maxTravel, maxScroll);
	// 寸法が同じかを見る文字列。小数 2 桁
	const signature        = [headerDocTop, maxTravel, maxScroll].map((value) => value.toFixed(2)).join('|');
	// 全セルにこの固定のアニメーションが付いているか
	const bound            = cells.every((cell) => cell.getAnimations().some((animation) => animation.id === TABLE_HEADER_PIN_KEY));
	// 張り替え判定まで含めた更新
	return {
		// 対象の枠
		wrap,
		// 固定する見出しセル
		cells,
		// 外すセル。今回の見出しは残す
		stale,
		// ずらしのキーフレーム
		frames,
		// 仕切り判定に使う基準位置
		headerDocTop,
		// 同じ印なら張り直さない
		signature,
		// 既に同じ印で付いているときは何もしない
		skip: bound && wrap.dataset.tmsMdeHeaderPin === signature
	};
}

/**
 * 測り直した表へスクロール連動アニメーションを付ける
 * @param updates - 表ごとの更新
 * @param scroller - エディタのスクロール要素
 */
function applyTableHeaderPinUpdates(updates: TableHeaderPinUpdate[], scroller: HTMLElement): void {
	updates.forEach((update) => {
		update.stale.forEach((cell) => {
			clearTableHeaderPin(cell);
		});
		// 寸法もアニメーションも同じ表は張り替えない
		if (update.skip) {
			return;
		}

		update.wrap.dataset.tmsMdeHeaderPin = update.signature;
		// キーフレームが空の表は固定を外し、基準位置も消す
		if (update.frames.length === 0) {
			delete update.wrap.dataset.tmsMdeHeaderPinTop;
			update.cells.forEach((cell) => {
				clearTableHeaderPin(cell);
			});
			columnStructurePinTargets(update.wrap).forEach((element) => {
				clearScrollLinkedPin(element);
			});
			return;
		}

		update.wrap.dataset.tmsMdeHeaderPinTop = String(update.headerDocTop);
		bindTableHeaderPin(update.wrap, update.cells, update.frames, scroller);
		syncTableHeaderCovering(update.wrap, scroller.scrollTop);
	});
}

/**
 * 見出しセルと列選択ヘッダーを、エディタの縦スクロールに連動させる
 * 行選択は行と一緒に流すため、ここには含めない
 * @param wrap - 表ラッパー。列選択を探す
 * @param cells - 見出しセル
 * @param frames - ずらしキーフレーム
 * @param scroller - エディタのスクロール要素
 */
function bindTableHeaderPin(wrap: HTMLElement, cells: HTMLElement[], frames: TableHeaderPinFrame[], scroller: HTMLElement): void {
	// ずらしのキーフレーム。割合と translateY
	const keyframes: Keyframe[] = frames.map((frame) => ({
		// スクロール割合。0 から 1
		offset: frame.offset,
		// その割合での縦ずらし
		transform: `translateY(${frame.translateY}px)`
	}));
	// エディタの縦スクロールに紐づくタイムライン
	const timeline              = createScrollTimeline(scroller);
	cells.forEach((cell) => {
		cell.classList.add(TABLE_HEADER_PIN_CLASS);
		bindScrollLinkedPin(cell, keyframes, timeline);
	});
	columnStructurePinTargets(wrap).forEach((element) => {
		bindScrollLinkedPin(element, keyframes, timeline);
	});
}

/**
 * 列選択の背面と列ボタンを返す
 * 行ボタンは含めない
 * @param wrap - 表ラッパー
 * @returns 見出しと同じずらしを付ける要素
 */
function columnStructurePinTargets(wrap: HTMLElement): HTMLElement[] {
	return [...wrap.querySelectorAll<HTMLElement>(TABLE_COLUMN_STRUCTURE_PIN_SELECTOR)];
}

/**
 * 要素をスクロール連動の縦ずらしへ付ける
 * 以前の同じアニメーションは外してから付け直す
 * @param element - 見出しセルか列選択
 * @param keyframes - ずらしキーフレーム
 * @param timeline - エディタの縦スクロール
 */
function bindScrollLinkedPin(element: HTMLElement, keyframes: Keyframe[], timeline: AnimationTimeline): void {
	clearScrollLinkedPin(element);
	// 要素をスクロールへ連動させるアニメーション
	const animation = element.animate(keyframes, {
		// 範囲外でも両端の値を保つ
		fill: 'both',
		// 張り替え判定に使う id
		id: TABLE_HEADER_PIN_KEY,
		// スクロール連動。時間では進めない
		timeline
	});
	animation.id    = TABLE_HEADER_PIN_KEY;
}

/**
 * 見出しの固定アニメーションと印を外す
 * @param cell - セル
 */
function clearTableHeaderPin(cell: HTMLElement): void {
	clearScrollLinkedPin(cell);
	cell.classList.remove(TABLE_HEADER_PIN_CLASS, TABLE_HEADER_COVERING_CLASS);
}

/**
 * スクロール連動の縦ずらしだけを外す
 * 列選択には固定クラスを付けないので、クラスは触らない
 * @param element - 見出しセルか列選択
 */
function clearScrollLinkedPin(element: HTMLElement): void {
	element.getAnimations().forEach((animation) => {
		// この固定のアニメーションだけ止める。ほかのアニメーションは残す
		if (animation.id === TABLE_HEADER_PIN_KEY) {
			animation.cancel();
		}
	});
	element.style.transform = '';
}

/**
 * 表の枠内スクロールでデータ行が隠れているあいだ、仕切りを出す
 * @param wrap - 表ラッパー
 */
function syncTableHeaderCovering(wrap: HTMLElement, scrollTop: number): void {
	// 枠に覚えた基準位置。未設定や不正なら NaN
	const headerDocTop = Number(wrap.dataset.tmsMdeHeaderPinTop);
	// データ行が見出しの裏に入っているか
	const covering     = isTableHeaderCovering(scrollTop, headerDocTop, wrap.scrollTop);
	wrap.querySelectorAll<HTMLElement>(`.${TABLE_HEADER_PIN_CLASS}`).forEach((cell) => {
		// 仕切りの有無が変わるセルだけクラスを切り替える
		if (cell.classList.contains(TABLE_HEADER_COVERING_CLASS) !== covering) {
			cell.classList.toggle(TABLE_HEADER_COVERING_CLASS, covering);
		}
	});
}

/**
 * スクロール連動アニメーションが使えるか
 * @returns 使えるなら true
 */
function canUseScrollTimeline(): boolean {
	return scrollTimelineConstructor() !== null;
}

/**
 * エディタの縦スクロールに紐づくタイムラインを作る
 * @param scroller - エディタのスクロール要素
 * @returns タイムライン
 */
function createScrollTimeline(scroller: HTMLElement): AnimationTimeline {
	// 実行環境のコンストラクタ。未対応なら null
	const ScrollTimeline = scrollTimelineConstructor();
	// 未対応のまま呼ばれたときは固定を作らない
	if (!ScrollTimeline) {
		throw new Error('ScrollTimeline がありません。');
	}

	// エディタの縦スクロールに紐づくタイムライン
	return new ScrollTimeline({
		// スクロール元。エディタのスクロール要素
		source: scroller,
		// 縦方向。横スクロールには連動しない
		axis: 'block'
	});
}

/**
 * 実行環境の ScrollTimeline コンストラクタを返す
 * @returns 未対応なら null
 */
function scrollTimelineConstructor(): ScrollTimelineConstructor | null {
	// globalThis 上のコンストラクタ。未対応なら undefined
	const host = globalThis as { ScrollTimeline?: ScrollTimelineConstructor };
	return host.ScrollTimeline ?? null;
}

/**
 * 留める見出しセルを返す
 * GFM 表は thead の先頭行。HTML 表は thead の先頭行、無ければ th を含む先頭行
 * @param wrap - 表ラッパー
 * @returns 見出しセル
 */
export function findTableHeaderPinCells(wrap: HTMLElement): HTMLElement[] {
	// 枠の中の表。無ければ固定対象も無い
	const table = wrap.querySelector('table');
	// 表が無い枠は空を返す
	if (!table) {
		return [];
	}

	// 見出し行の親。HTML 表に無ければ null
	const thead = table.querySelector('thead');
	// thead がある表は、その先頭行のセルだけを留める
	if (thead) {
		// thead 直下の先頭行。無ければ null
		const row = thead.querySelector(':scope > tr');
		return row ? rowCells(row) : [];
	}

	// thead が無いときの先頭行。表直下か tbody の先頭
	const firstRow = table.querySelector(':scope > tr') ?? table.querySelector(':scope > tbody > tr');
	// 先頭行が無い、または th を含まない行は見出しにしない。どちらか一方でも空
	if (!firstRow?.querySelector(':scope > th')) {
		return [];
	}

	return rowCells(firstRow);
}

/**
 * 行の直接のセルを返す
 * @param row - 行
 * @returns th / td
 */
function rowCells(row: Element): HTMLElement[] {
	return [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement && (child.tagName === 'TH' || child.tagName === 'TD'));
}

/**
 * 適用中の translateY を返す。スクロール連動アニメーションの値を含む
 * @param cell - 見出しセル
 * @returns px
 */
function readTranslateY(cell: HTMLElement): number {
	// 適用中の transform。アニメーションの値を含む。無ければ none
	const transform = getComputedStyle(cell).transform;
	// 変換が無いセルのずらしは 0
	if (!transform || transform === 'none') {
		return 0;
	}

	return new DOMMatrix(transform).m42;
}
