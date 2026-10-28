/**
 * 表の列幅と行高のドラッグ結果をプロセス内に覚え、DOM の幅へ反映する
 * ノートへの書き戻しは onPersist に任せ、このファイルは表示中のレイアウトだけを持つ
 * @file
 */
export type TableResizeHit = {
	/** col は列境界、row は行境界 */
	kind: 'col' | 'row';
	/** 動かした境界の番号。0 始まり */
	index: number;
};

/** ドラッグ中に覚える列幅と行高。未設定の軸はプロパティを置かない */
export type TableLayout = {
	/** 列幅（px）。未設定ならプロパティ自体が無い */
	widths?: number[];
	/** 行高（px）。未設定ならプロパティ自体が無い */
	heights?: number[];
};

/** 描画済みセルの、列位置と横幅 */
export type TableCellBox = {
	/** セルの開始列。0 始まり */
	column: number;
	/** セルが占める列数。1 以上 */
	colspan: number;
	/** セルの左端。スクロール領域内の px */
	left: number;
	/** セルの幅（px） */
	width: number;
};

/** 表リサイズを始めるときのレイアウトと、保存の受け口 */
export type TableResizeOptions = {
	/** 開始時の列幅と行高。未指定なら DOM から測る */
	layout?: TableLayout;
	/** ドラッグ確定時にレイアウトを受け取る。省略なら保存しない */
	onPersist?: (layout: TableLayout, hit: TableResizeHit) => void;
};

// ----------------------------------------------
// 寸法の下限
// ----------------------------------------------
/** 列幅の下限（px）。これより細いドラッグはここまで戻す */
const MIN_COLUMN_WIDTH = 32;
/** 行高の下限（px）。これより低いドラッグはここまで戻す */
const MIN_ROW_HEIGHT   = 24;

/** 表が横にはみ出したときに枠へ付けるクラス */
const TABLE_HORIZONTAL_OVERFLOW_CLASS        = 'cm-md-table-horizontal-overflow';
/** 横はみ出しとみなす余裕（px）。1px 以内は誤差として無視する */
const TABLE_HORIZONTAL_OVERFLOW_TOLERANCE_PX = 1;
/** 表が縦にはみ出したときに枠へ付けるクラス */
const TABLE_VERTICAL_OVERFLOW_CLASS          = 'cm-md-table-vertical-overflow';
/** 縦はみ出しとみなす余裕（px）。1px 以内は誤差として無視する */
const TABLE_VERTICAL_OVERFLOW_TOLERANCE_PX   = 1;

/** セル内で折り返すクラス。はみ出し判定と対で使う */
const TABLE_CELL_WRAP_CLASS = 'cm-md-table-cell-wrap';

/** 列・行ハンドルのヒット幅（px） */
export const TABLE_RESIZE_HANDLE_PX = 14;

/** クリックとドラッグを区別する最小移動量（px） */
export const TABLE_RESIZE_DRAG_THRESHOLD_PX = 4;

// ----------------------------------------------
// レイアウトの記憶
// ----------------------------------------------
/** 表の位置と列数から、ドラッグ中の列幅・行高。プロセス内だけ */
const layouts = new Map<string, TableLayout>();

/**
 * スクロールコンテナ内での要素位置を返す
 * offsetLeft / offsetTop が含めない親 padding と、現在のスクロール量を補正する
 * @param containerStart - コンテナの画面座標
 * @param elementStart - 要素の画面座標
 * @param scrollOffset - コンテナのスクロール量
 * @returns スクロール領域内の座標
 */
export function resolveTableRelativeOffset(containerStart: number, elementStart: number, scrollOffset: number): number {
	return elementStart - containerStart + scrollOffset;
}

/**
 * 表本体がラッパーの表示幅を実際に超えているかを返す
 * @param tableLeft - 表左端のスクロール領域内座標
 * @param tableWidth - 表の実幅
 * @param viewportWidth - ラッパーの表示幅
 * @returns 横スクロールが必要か
 */
export function isTableHorizontallyOverflowing(tableLeft: number, tableWidth: number, viewportWidth: number): boolean {
	return tableLeft + tableWidth > viewportWidth + TABLE_HORIZONTAL_OVERFLOW_TOLERANCE_PX;
}

/**
 * 表の枠に実効の最大高さがあるかを返す
 * none や算出できない指定は、内容の高さのまま伸ばす
 * @param maxHeight - getComputedStyle が返す max-height
 * @returns 高さ制限があるなら true
 */
export function isTableHeightConstrained(maxHeight: string): boolean {
	// 未指定と none は制限なし。空白だけも制限にしない
	if (maxHeight.trim() === '' || maxHeight === 'none') {
		return false;
	}

	// 算出済みの高さ（px）。min() や vh も getComputedStyle では px になる
	const pixels = Number.parseFloat(maxHeight);
	return Number.isFinite(pixels) && pixels > 0;
}

/**
 * 表本体がラッパーの表示高を実際に超えているかを返す
 * @param tableTop - 表上端のスクロール領域内座標
 * @param tableHeight - 表の実高さ
 * @param viewportHeight - ラッパーの表示高
 * @returns 縦スクロールが必要か
 */
export function isTableVerticallyOverflowing(tableTop: number, tableHeight: number, viewportHeight: number): boolean {
	return tableTop + tableHeight > viewportHeight + TABLE_VERTICAL_OVERFLOW_TOLERANCE_PX;
}

/**
 * 表本体の実寸に応じて、横スクロールと高さ制限時の縦スクロールを切り替える
 * 絶対配置のヘッダー・リサイズ要素やサブピクセル丸めは判定対象にしない
 * 最大高さが無い表は縦スクロールにせず、僅かな誤差で縦横スクロールが連鎖しないようにする
 * @param wrap - 表ラッパー
 * @param table - 表
 * @returns 表位置・寸法が変わったときの再同期処理
 */
export function attachTableHorizontalOverflow(wrap: HTMLElement, table: HTMLTableElement): () => void {
	/** 現在の表実寸から縦横スクロールの要否を同期する */
	const sync = (): void => {
		// 枠と表の画面矩形。はみ出し判定の基準
		const wrapRect         = wrap.getBoundingClientRect();
		// 表本体の画面矩形。絶対配置のヘッダーは含まない
		const tableRect        = table.getBoundingClientRect();
		// スクロール領域内の表の左端
		const tableLeft        = resolveTableRelativeOffset(wrapRect.left, tableRect.left, wrap.scrollLeft);
		// 表が枠の表示幅を超えているか
		const overflow         = isTableHorizontallyOverflowing(tableLeft, tableRect.width, wrap.clientWidth);
		// スクロール領域内の表の上端
		const tableTop         = resolveTableRelativeOffset(wrapRect.top, tableRect.top, wrap.scrollTop);
		// 算出済みの max-height。none のときは高さ制限が無い
		const maxHeight        = getComputedStyle(wrap).maxHeight;
		// 高さ制限があり、かつ表本体が表示高を超えているか。制限が無い表は縦スクロールにしない
		const verticalOverflow = isTableHeightConstrained(maxHeight) && isTableVerticallyOverflowing(tableTop, tableRect.height, wrap.clientHeight);

		wrap.classList.toggle(TABLE_HORIZONTAL_OVERFLOW_CLASS, overflow);
		wrap.classList.toggle(TABLE_VERTICAL_OVERFLOW_CLASS, verticalOverflow);
		// はみ出していないのに横位置が残っているときは、先頭へ戻す
		if (!overflow && wrap.scrollLeft !== 0) {
			wrap.scrollLeft = 0;
		}
		// 縦にはみ出していないのに縦位置が残っているときは、先頭へ戻す
		if (!verticalOverflow && wrap.scrollTop !== 0) {
			wrap.scrollTop = 0;
		}
	};

	sync();
	requestAnimationFrame(sync);
	// 枠と表の寸法変化ではみ出しを見直す
	const observer = new ResizeObserver(() => {
		// 表が文書から外れたら監視を止める
		if (!table.isConnected) {
			observer.disconnect();
			return;
		}

		sync();
	});
	observer.observe(wrap);
	observer.observe(table);
	return sync;
}

/**
 * 表レイアウトの保存キーを返す
 * @param tableFrom - 表の開始位置
 * @param columnCount - 列数
 * @returns キー
 */
export function getTableLayoutKey(tableFrom: number, columnCount: number): string {
	return `${tableFrom}:${columnCount}`;
}

/**
 * ドラッグで決めた列幅・行高を覚える
 * @param key - 保存キー
 * @param layout - レイアウト
 */
export function rememberTableLayout(key: string, layout: TableLayout): void {
	// 配列を複製して覚える。呼び出し側の配列を後から変えても影響しない
	layouts.set(key, {
		// 列幅の複製。未設定ならプロパティ自体を置かない
		widths: layout.widths ? [...layout.widths] : undefined,
		// 行高の複製。未設定ならプロパティ自体を置かない
		heights: layout.heights ? [...layout.heights] : undefined
	});
}

/**
 * 1 表の保存レイアウトを消す
 * @param key - 保存キー
 */
export function forgetTableLayout(key: string): void {
	layouts.delete(key);
}

/**
 * 保存した列幅・行高を返す
 * @param key - 保存キー
 * @returns レイアウト
 */
export function recallTableLayout(key: string): TableLayout | undefined {
	// 覚えたレイアウト。無ければ undefined
	const layout = layouts.get(key);
	// 未記憶の表は undefined のまま返す
	if (!layout) {
		return undefined;
	}

	// 配列を複製して返す。記憶側を呼び出し側から書き換えさせない
	return {
		// 列幅の複製。未設定なら undefined
		widths: layout.widths ? [...layout.widths] : undefined,
		// 行高の複製。未設定なら undefined
		heights: layout.heights ? [...layout.heights] : undefined
	};
}

/**
 * 試験用に保存レイアウトを消す
 */
export function clearTableLayouts(): void {
	layouts.clear();
}

/**
 * 列ヒットと行ヒットのうち近い方を返す
 * @param columnHit - 列
 * @param rowHit - 行
 * @returns ヒット
 */
export function resolveTableResizeHit(columnHit: { index: number; distance: number } | null, rowHit: { index: number; distance: number } | null): TableResizeHit | null {
	// 列と行の両方に当たったときは、距離が近い軸を採用する
	if (columnHit && rowHit) {
		return columnHit.distance <= rowHit.distance
			? {
				// 列境界。行より近いか同じ
				kind: 'col',
				// 動かした列番号
				index: columnHit.index
			}
			: {
				// 行境界。列より近い
				kind: 'row',
				// 動かした行番号
				index: rowHit.index
			};
	}

	// 列だけ当たったときは列境界にする
	if (columnHit) {
		// 列だけ当たった境界
		return {
			// 列境界
			kind: 'col',
			// 動かした列番号
			index: columnHit.index
		};
	}

	// 行だけ当たったときは行境界にする
	if (rowHit) {
		// 行だけ当たった境界
		return {
			// 行境界
			kind: 'row',
			// 動かした行番号
			index: rowHit.index
		};
	}

	return null;
}

/**
 * 列幅の下限を適用する
 * @param width - 幅
 * @returns クランプ後
 */
export function clampColumnWidth(width: number): number {
	return Math.max(MIN_COLUMN_WIDTH, Math.round(width));
}

/**
 * 行高の下限を適用する
 * @param height - 高さ
 * @returns クランプ後
 */
export function clampRowHeight(height: number): number {
	return Math.max(MIN_ROW_HEIGHT, Math.round(height));
}

/**
 * 保存した列幅・行高を表へ適用する
 * @param table - 表
 * @param layout - レイアウト
 */
export function applyTableLayout(table: HTMLTableElement, layout: TableLayout | undefined): void {
	// 描画上の列数。0 なら幅を当てない
	const columnCount = getRenderedColumnCount(table);
	// レイアウトが無い、幅も高さも空、または列が 0 のときは固定を外す。どれか一つでも外す
	if (!layout || (!layout.widths?.length && !layout.heights?.length) || columnCount === 0) {
		table.classList.remove('is-resized');
		table.style.tableLayout = '';
		table.style.width       = '';
		clearColWidths(table);
		clearRowHeights(table);
		syncTableCellWrapping(table);
		return;
	}

	// 列幅の配列があるか。行高だけなら表全体の幅は固定しない
	const hasWidths = Boolean(layout.widths?.length);
	// 列幅があるときだけ fixed レイアウトと col 幅を入れる
	if (hasWidths) {
		// 列数に揃えた colgroup
		const columns = ensureColGroup(table, columnCount);

		table.classList.add('is-resized');
		table.style.tableLayout = 'fixed';
		// 正の列幅の合計（px）。0 なら表幅は自動に戻す
		let total               = 0;
		[...columns.children].forEach((column, index) => {
			// この列の保存幅。未設定は 0
			const width = layout.widths?.[index] ?? 0;
			// 正の幅だけ下限を適用して col へ入れる
			if (width > 0) {
				// 下限を適用した幅（px）
				const clamped                       = clampColumnWidth(width);
				(column as HTMLElement).style.width = `${clamped}px`;
				total                              += clamped;
			} else {
				(column as HTMLElement).style.width = '';
			}
		});
		table.style.width = total > 0 ? `${total}px` : '';
	} else {
		table.classList.remove('is-resized');
		table.style.tableLayout = '';
		table.style.width       = '';
		clearColWidths(table);
	}

	// 行高の配列があるときだけ、各行へ高さを入れる
	if (layout.heights && layout.heights.length > 0) {
		[...table.rows].forEach((row, index) => {
			// この行の保存高さ。未設定は undefined
			const height     = layout.heights?.[index];
			row.style.height = height && height > 0 ? `${clampRowHeight(height)}px` : '';
		});
	} else {
		clearRowHeights(table);
	}

	syncTableCellWrapping(table, hasWidths ? layout.widths : undefined);
}

/**
 * 固定列幅から横へはみ出すセルだけを折り返す
 * @param contentWidth - セル内容の折り返し前の横幅
 * @param availableWidth - セル内の利用可能幅
 * @param tolerance - サブピクセル丸めの許容値
 */
export function shouldWrapTableCell(contentWidth: number, availableWidth: number, tolerance = 1): boolean {
	return contentWidth > availableWidth + tolerance;
}

/** 固定列幅に収まらないセルだけへ折り返しクラスを付ける */
function syncTableCellWrapping(table: HTMLTableElement, widths?: number[]): void {
	// 折り返しを見直すセル。一度クラスを外してから付け直す
	const cells = [...table.querySelectorAll<HTMLElement>('th, td')];
	cells.forEach((cell) => cell.classList.remove(TABLE_CELL_WRAP_CLASS));
	// 固定列幅が無い表は折り返しクラスを付けない
	if (!widths?.length) {
		return;
	}

	cells.forEach((cell) => {
		// 列番号と結合を読むためのセル
		const tableCell      = cell as HTMLTableCellElement;
		// 開始列。dataset が無ければ 0
		const column         = Number(tableCell.dataset.tableColumn) || 0;
		// 占める列数。1 未満にはしない
		const colspan        = Math.max(1, tableCell.colSpan || 1);
		// 結合範囲の固定幅の合計（px）
		const fixedWidth     = widths.slice(column, column + colspan).reduce((total, width) => total + clampColumnWidth(width), 0);
		// パディングを引くための計算スタイル。窓が無ければ undefined
		const style          = cell.ownerDocument.defaultView?.getComputedStyle(cell);
		// 折り返す前の内容幅（px）
		const contentWidth   = measureTableCellContentWidth(cell, style);
		// 左右パディングの合計（px）。スタイルが無ければ 0
		const padding        = Number.parseFloat(style?.paddingLeft ?? '0') + Number.parseFloat(style?.paddingRight ?? '0');
		// 内容に使える幅（px）。負なら 0
		const availableWidth = Math.max(0, fixedWidth - padding);
		cell.classList.toggle(TABLE_CELL_WRAP_CLASS, shouldWrapTableCell(contentWidth, availableWidth));
	});
}

/** セル文字列を折り返さない状態で測定する。セル内の block 要素幅には依存しない */
function measureTableCellContentWidth(cell: HTMLElement, style: CSSStyleDeclaration | undefined): number {
	// 折り返さずに幅を測るための見えない要素
	const probe = cell.ownerDocument.createElement('span');

	probe.textContent         = cell.textContent ?? '';
	probe.style.position      = 'fixed';
	probe.style.left          = '-100000px';
	probe.style.top           = '0';
	probe.style.display       = 'inline-block';
	probe.style.visibility    = 'hidden';
	probe.style.pointerEvents = 'none';
	probe.style.whiteSpace    = 'pre';
	probe.style.width         = 'max-content';
	probe.style.maxWidth      = 'none';
	probe.style.font          = style?.font ?? '';
	probe.style.letterSpacing = style?.letterSpacing ?? '';
	probe.style.wordSpacing   = style?.wordSpacing ?? '';
	probe.style.textTransform = style?.textTransform ?? '';
	cell.ownerDocument.body.appendChild(probe);
	// 折り返さない内容幅（px）
	const width = probe.getBoundingClientRect().width;
	probe.remove();
	return width;
}

/**
 * リサイズ対象の軸で、クリックではなくドラッグとみなす距離を移動したか判定する
 */
export function hasTableResizePointerMoved(hit: TableResizeHit, start: { x: number; y: number }, current: { x: number; y: number }, threshold = TABLE_RESIZE_DRAG_THRESHOLD_PX): boolean {
	// 列なら横移動、行なら縦移動（px）
	const delta = hit.kind === 'col' ? current.x - start.x : current.y - start.y;
	return Math.abs(delta) >= threshold;
}

/**
 * 操作対象以外の寸法は、既に保存済みの場合だけドラッグ中の固定値へ含める
 */
export function resolveActiveTableResizeLayout(hit: TableResizeHit, measured: TableLayout, hadPersistedWidths: boolean, hadPersistedHeights: boolean): TableLayout {
	// 動かした軸は測った値を使い、動かしていない軸は保存済みのときだけ残す
	return {
		// 列ドラッグか、もともと列幅を保存していたときだけ列幅を返す
		widths: hit.kind === 'col' || hadPersistedWidths ? measured.widths : undefined,
		// 行ドラッグか、もともと行高を保存していたときだけ行高を返す
		heights: hit.kind === 'row' || hadPersistedHeights ? measured.heights : undefined
	};
}

/**
 * 罫線ドラッグで列幅・行高を変えられるようにする
 * @param wrap - 表ラッパー
 * @param table - 表
 * @param key - 保存キー
 * @param options - ソースのレイアウトと確定時の書き戻し。省略可
 * @returns 表位置が変わったときの再同期処理
 */
export function attachTableResize(wrap: HTMLElement, table: HTMLTableElement, key: string, options: TableResizeOptions = {}): () => void {
	applyTableLayout(table, options.layout);

	// 罫線上へハンドルを置く透明な層
	const overlay     = document.createElement('div');
	overlay.className = 'cm-md-table-resize-overlay';
	overlay.setAttribute('aria-hidden', 'true');
	wrap.appendChild(overlay);

	/**
	 * ハンドル位置を表の実寸に合わせる
	 */
	const sync = (): void => {
		syncTableResizeHandles(overlay, table, key, options.onPersist);
	};

	sync();
	requestAnimationFrame(sync);

	// 表の寸法変化でハンドル位置を合わせ直す。ドラッグ中は動かさない
	const observer = new ResizeObserver(() => {
		// 表が文書から外れたら監視を止める
		if (!table.isConnected) {
			observer.disconnect();
			return;
		}

		// ドラッグ中の再配置は、幅の変化でハンドルが追従してずれるので止める
		if (table.classList.contains('is-resizing')) {
			return;
		}

		sync();
	});
	observer.observe(table);
	table.querySelectorAll('img').forEach((image) => {
		// まだ読み終わっていない画像だけ、読み込み後にハンドルを合わせ直す
		if (!image.complete) {
			// 画像の寸法が決まってから、一度だけハンドル位置を更新する
			image.addEventListener('load', sync, { once: true });
		}
	});

	return sync;
}

/**
 * 列・行のドラッグハンドルを罫線上へ置く
 * @param overlay - オーバーレイ
 * @param table - 表
 * @param key - 保存キー
 * @param onPersist - 確定時。省略可
 */
export function syncTableResizeHandles(overlay: HTMLElement, table: HTMLTableElement, key: string, onPersist?: (layout: TableLayout, hit: TableResizeHit) => void): void {
	overlay.replaceChildren();
	// 表の画面矩形。オーバーレイの大きさと行ハンドルの基準
	const tableRect = table.getBoundingClientRect();
	// オーバーレイの親。無ければ null
	const wrap      = overlay.parentElement;
	// 親の画面矩形。無ければ undefined
	const wrapRect  = wrap?.getBoundingClientRect();
	// 親があるときはスクロールを補正した左端。無ければ offsetLeft
	const tableLeft = wrap && wrapRect ? resolveTableRelativeOffset(wrapRect.left, tableRect.left, wrap.scrollLeft) : table.offsetLeft;
	// 親があるときはスクロールを補正した上端。無ければ offsetTop
	const tableTop  = wrap && wrapRect ? resolveTableRelativeOffset(wrapRect.top, tableRect.top, wrap.scrollTop) : table.offsetTop;

	overlay.style.left   = `${tableLeft}px`;
	overlay.style.top    = `${tableTop}px`;
	overlay.style.width  = `${tableRect.width}px`;
	overlay.style.height = `${tableRect.height}px`;

	// 行要素。空ならハンドルを置かない
	const rows = [...table.rows];
	// 行が無い表には列ハンドルも置かない
	if (rows.length === 0) {
		return;
	}

	// 描画上の列数。右端の計算に使う
	const columnCount = getRenderedColumnCount(table);
	// セルの位置と幅。結合をまたいだ境界を出す
	const boxes       = collectTableCellBoxes(table);
	computeColumnRightEdges(boxes, columnCount).forEach((right, index) => {
		// 右端が 0 以下の列には境界が無いのでハンドルを置かない
		if (right <= 0) {
			return;
		}

		// 列境界のハンドル。右端からヒット幅だけ左へずらす
		const handle        = document.createElement('div');
		handle.className    = 'cm-md-table-col-resizer';
		handle.title        = 'ドラッグして列幅を変更';
		handle.style.left   = `${right - TABLE_RESIZE_HANDLE_PX}px`;
		handle.style.top    = '0';
		handle.style.height = `${tableRect.height}px`;
		// この列境界を動かすハンドル
		bindResizeHandle(
			handle,
			table,
			key,
			{
				// 列境界
				kind: 'col',
				// 動かした列番号
				index
			},
			overlay,
			onPersist
		);
		overlay.appendChild(handle);
	});

	rows.forEach((row, index) => {
		// 行の画面矩形。ハンドルは下端へ置く
		const rowRect      = row.getBoundingClientRect();
		// 行境界のハンドル
		const handle       = document.createElement('div');
		handle.className   = 'cm-md-table-row-resizer';
		handle.title       = 'ドラッグして行高を変更';
		handle.style.left  = '0';
		handle.style.top   = `${rowRect.bottom - tableRect.top - TABLE_RESIZE_HANDLE_PX}px`;
		handle.style.width = `${tableRect.width}px`;
		// この行境界を動かすハンドル
		bindResizeHandle(
			handle,
			table,
			key,
			{
				// 行境界
				kind: 'row',
				// 動かした行番号
				index
			},
			overlay,
			onPersist
		);
		overlay.appendChild(handle);
	});
}

/**
 * 現在の列幅・行高を測る
 * @param table - 表
 * @returns レイアウト
 */
export function measureTableLayout(table: HTMLTableElement): TableLayout {
	// 描画上の列数。幅配列の長さ
	const columnCount = getRenderedColumnCount(table);
	// いまの列幅と行高。ドラッグ開始の基準
	return {
		// 結合を割った列幅
		widths: computeColumnWidths(collectTableCellBoxes(table), columnCount),
		// 各行の高さ。下限を適用する
		heights: [...table.rows].map((row) => clampRowHeight(row.getBoundingClientRect().height))
	};
}

/**
 * 描画済みセルの列位置と幅を集める
 * @param table - 表
 * @returns 描画済みセルの列位置と幅を集める
 */
export function collectTableCellBoxes(table: HTMLTableElement): TableCellBox[] {
	// 表の画面矩形。セル位置を表の左端からの値にする
	const tableRect = table.getBoundingClientRect();
	return [...table.querySelectorAll('th, td')].map((cell) => {
		// セルの画面矩形
		const rect = cell.getBoundingClientRect();
		// 列位置と表内の横幅
		return {
			// 開始列。dataset が無ければ 0
			column: Number((cell as HTMLTableCellElement).dataset.tableColumn) || 0,
			// 占める列数。未設定は 1
			colspan: (cell as HTMLTableCellElement).colSpan || 1,
			// 表の左端からの位置（px）
			left: rect.left - tableRect.left,
			// セルの幅（px）
			width: rect.width
		};
	});
}

/**
 * 各列の右端位置を返す。結合セルでも列境界を出す
 * @param boxes - セル
 * @param columnCount - 列数
 * @returns 各列の右端位置を返す。結合セルでも列境界を出す
 */
export function computeColumnRightEdges(boxes: TableCellBox[], columnCount: number): number[] {
	// 列ごとの右端。初期は 0 で、境界が無い列はハンドルを置かない
	const edges = Array.from({ length: columnCount }, () => 0);
	for (let column = 0; column < columnCount; column += 1) {
		// この列で終わるセル。結合の終端
		const ending = boxes.find((box) => box.column + box.colspan - 1 === column);
		// 終端セルがある列は、その右端を境界にする
		if (ending) {
			edges[column] = ending.left + ending.width;
			continue;
		}

		// この列を覆う結合セル。終端が先の列にある
		const covering = boxes.find((box) => box.column <= column && box.column + box.colspan - 1 >= column);
		// 覆うセルがあるときだけ、列数で割った位置を右端にする
		if (covering) {
			edges[column] = covering.left + covering.width * ((column - covering.column + 1) / covering.colspan);
		}
	}

	return edges;
}

/**
 * 各列の幅を返す。結合セルは幅を列数で割る
 * @param boxes - セル
 * @param columnCount - 列数
 * @returns 各列の幅を返す。結合セルは幅を列数で割る
 */
export function computeColumnWidths(boxes: TableCellBox[], columnCount: number): number[] {
	// 列ごとの幅。初期は 0 で、後で下限を適用する
	const widths = Array.from({ length: columnCount }, () => 0);
	for (let column = 0; column < columnCount; column += 1) {
		// この列から始まり、結合していないセル
		const unmerged = boxes.filter((box) => box.column === column && box.colspan === 1);
		// 非結合セルがある列は、その最大幅を列幅にする
		if (unmerged.length > 0) {
			widths[column] = Math.max(...unmerged.map((box) => box.width));
			continue;
		}

		// この列を覆う結合セル。幅は列数で割る
		const covering = boxes.find((box) => box.column <= column && box.column + box.colspan - 1 >= column);
		// 覆うセルがあるときだけ、その幅を列数で割る
		if (covering) {
			widths[column] = covering.width / covering.colspan;
		}
	}

	return widths.map((width) => clampColumnWidth(width || MIN_COLUMN_WIDTH));
}

/**
 * @param handle - ハンドル
 * @param table - 表
 * @param key - 保存キー
 * @param hit - ヒット
 * @param overlay - オーバーレイ
 */
function bindResizeHandle(handle: HTMLElement, table: HTMLTableElement, key: string, hit: TableResizeHit, overlay: HTMLElement, onPersist?: (layout: TableLayout, hit: TableResizeHit) => void): void {
	// 左ボタンの押下だけ、列または行のドラッグを始める
	handle.addEventListener('pointerdown', (event) => {
		// 左ボタン以外は寸法を変えない
		if (event.button !== 0) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		startTableResize(
			table,
			key,
			hit,
			event,
			() => {
				// ドラッグが終わったあとだけハンドルを置き直す。移動中は追従させない
				if (!table.classList.contains('is-resizing')) {
					syncTableResizeHandles(overlay, table, key, onPersist);
				}
			},
			onPersist
		);
	});
}

/**
 * @param table - 表
 * @param _key - 互換用（ドラッグ中は共有メモリへ書かない）
 * @param hit - ヒット
 * @param event - 開始イベント
 * @param onSync - ハンドル再配置
 */
function startTableResize(table: HTMLTableElement, _key: string, hit: TableResizeHit, event: PointerEvent, onSync: () => void, onPersist?: (layout: TableLayout, hit: TableResizeHit) => void): void {
	// 開始時の列幅と行高。ドラッグ中の基準
	const measured            = measureTableLayout(table);
	// 書き換える列幅。未計測なら空
	const widths              = [...(measured.widths ?? [])];
	// 書き換える行高。未計測なら空
	const heights             = [...(measured.heights ?? [])];
	// 開始時の画面 X
	const startX              = event.clientX;
	// 開始時の画面 Y
	const startY              = event.clientY;
	// 動かす列の開始幅。未設定は下限
	const startW              = widths[hit.index] ?? MIN_COLUMN_WIDTH;
	// 動かす行の開始高さ。未設定は下限
	const startH              = heights[hit.index] ?? MIN_ROW_HEIGHT;
	// 押したハンドル。要素でなければキャプチャしない
	const handle              = event.currentTarget;
	// クリックとドラッグを区別する開始座標
	const start               = {
		// 開始時の画面 X
		x: startX,
		// 開始時の画面 Y
		y: startY
	};
	// ドラッグ前から列幅が固定されていたか
	const hadPersistedWidths  = table.classList.contains('is-resized');
	// どれかの行に高さが入っていたか
	const hadPersistedHeights = [...table.rows].some((row) => row.style.height !== '');

	// しきい値を超えてから true。クリックだけでは確定しない
	let resizing = false;
	// ハンドル要素のときだけ、ポインタをキャプチャする
	if (handle instanceof HTMLElement) {
		handle.setPointerCapture(event.pointerId);
	}

	/**
	 * @param moveEvent - 移動
	 */
	const onMove = (moveEvent: PointerEvent): void => {
		// まだドラッグとみなせず、かつしきい値未満の移動は寸法を変えない。どちらか一方でも return
		if (
			!resizing &&
			!hasTableResizePointerMoved(hit, start, {
				// 移動中の画面 X
				x: moveEvent.clientX,
				// 移動中の画面 Y
				y: moveEvent.clientY
			})
		) {
			return;
		}

		// しきい値を超えた最初の移動だけ、ドラッグ中の印を付ける
		if (!resizing) {
			resizing = true;
			table.classList.add('is-resizing');
			// ハンドル要素のときだけ、操作中の見た目を付ける
			if (handle instanceof HTMLElement) {
				handle.classList.add('is-active');
			}
		}

		// 列境界だけ幅を更新する。行境界は高さ側
		if (hit.kind === 'col') {
			widths[hit.index] = clampColumnWidth(startW + (moveEvent.clientX - startX));
		} else {
			heights[hit.index] = clampRowHeight(startH + (moveEvent.clientY - startY));
		}

		applyTableLayout(
			table,
			resolveActiveTableResizeLayout(
				hit,
				// ドラッグ中の測り直し。動かしていない軸は関数側が落とす
				{
					// いまの列幅
					widths,
					// いまの行高
					heights
				},
				hadPersistedWidths,
				hadPersistedHeights
			)
		);
	};

	/**
	 * @param endEvent - 終了
	 */
	const onUp = (endEvent: PointerEvent): void => {
		// ドラッグになっていたときだけ、移動中の印を外す
		if (resizing) {
			table.classList.remove('is-resizing');
		}
		// ハンドル要素のときだけ、見た目と監視を外す
		if (handle instanceof HTMLElement) {
			// ドラッグになっていたときだけ、操作中の見た目を外す
			if (resizing) {
				handle.classList.remove('is-active');
			}
			// まだキャプチャを持っているときだけ解放する
			if (handle.hasPointerCapture(endEvent.pointerId)) {
				handle.releasePointerCapture(endEvent.pointerId);
			}

			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			handle.removeEventListener('pointercancel', onUp);
		}

		// しきい値を超えたドラッグだけ、ハンドル再配置と保存を行う
		if (resizing) {
			onSync();
			onPersist?.(
				{
					// 確定した列幅
					widths,
					// 確定した行高
					heights
				},
				hit
			);
		}
	};

	// ハンドル要素のときだけ、移動と終了をその要素で受ける
	if (handle instanceof HTMLElement) {
		// 移動のたびに、しきい値を超えてから寸法を更新する
		handle.addEventListener('pointermove', onMove);
		// 離したときに寸法を確定する
		handle.addEventListener('pointerup', onUp);
		// キャンセルでも同じ確定にする
		handle.addEventListener('pointercancel', onUp);
	}
}

/**
 * @param table - 表
 * @param columnCount - 列数
 * @returns colgroup
 */
/**
 * 表の論理列数を返す
 * @param table - 表
 * @returns 表の論理列数
 */
export function getRenderedColumnCount(table: HTMLTableElement): number {
	// dataset の列数。未設定や不正は NaN
	const fromData = Number(table.dataset.columnCount);
	// 正の整数が入っているときだけ、それを論理列数にする。どちらか一方が欠けてもセルから数える
	if (Number.isInteger(fromData) && fromData > 0) {
		return fromData;
	}

	// セルの終端列の最大。セルが無ければ 0
	const fromCells = Math.max(
		0,
		...[...table.querySelectorAll('th, td')].map((cell) => {
			// 開始列。dataset が無ければ 0
			const start = Number((cell as HTMLTableCellElement).dataset.tableColumn) || 0;
			return start + ((cell as HTMLTableCellElement).colSpan || 1);
		})
	);
	return fromCells;
}

/**
 * @param table - 表
 * @param columnCount - 列数
 * @returns colgroup
 */
function ensureColGroup(table: HTMLTableElement, columnCount: number): HTMLTableColElement {
	// 既存の colgroup。無ければ作る
	let group = table.querySelector('colgroup');
	// colgroup が無い表には、先頭へ新しい要素を入れる
	if (!group) {
		group = document.createElement('colgroup');
		table.insertBefore(group, table.firstChild);
	}

	while (group.children.length < columnCount) {
		group.appendChild(document.createElement('col'));
	}

	while (group.children.length > columnCount) {
		group.lastElementChild?.remove();
	}

	return group;
}

/**
 * @param table - 表
 */
function clearColWidths(table: HTMLTableElement): void {
	table.querySelectorAll('col').forEach((column) => {
		column.style.width = '';
	});
}

/**
 * @param table - 表
 */
function clearRowHeights(table: HTMLTableElement): void {
	[...table.rows].forEach((row) => {
		row.style.height = '';
	});
}
