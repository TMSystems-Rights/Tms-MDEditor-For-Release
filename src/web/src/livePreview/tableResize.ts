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
export function resolveTableRelativeOffset(
	containerStart: number,
	elementStart: number,
	scrollOffset: number,
): number {
	return elementStart - containerStart + scrollOffset;
}

/**
 * 表本体がラッパーの表示幅を実際に超えているかを返す
 * @param tableLeft - 表左端のスクロール領域内座標
 * @param tableWidth - 表の実幅
 * @param viewportWidth - ラッパーの表示幅
 * @returns 横スクロールが必要か
 */
export function isTableHorizontallyOverflowing(
	tableLeft: number,
	tableWidth: number,
	viewportWidth: number,
): boolean {
	return tableLeft + tableWidth > viewportWidth + TABLE_HORIZONTAL_OVERFLOW_TOLERANCE_PX;
}

/**
 * 表本体の実幅に応じて横スクロールの有無を切り替える
 * 絶対配置のヘッダー・リサイズ要素やサブピクセル丸めは判定対象にしない
 * @param wrap - 表ラッパー
 * @param table - 表
 * @returns 表位置・幅が変わったときの再同期処理
 */
export function attachTableHorizontalOverflow(
	wrap: HTMLElement,
	table: HTMLTableElement,
): () => void {
	/** 現在の表実幅から横スクロール要否を同期する */
	const sync = (): void => {
		const wrapRect  = wrap.getBoundingClientRect();
		const tableRect = table.getBoundingClientRect();
		const tableLeft = resolveTableRelativeOffset(wrapRect.left, tableRect.left, wrap.scrollLeft);
		const overflow  = isTableHorizontallyOverflowing(tableLeft, tableRect.width, wrap.clientWidth);

		wrap.classList.toggle(TABLE_HORIZONTAL_OVERFLOW_CLASS, overflow);
		if (!overflow && wrap.scrollLeft !== 0) {
			wrap.scrollLeft = 0;
		}
	};

	sync();
	requestAnimationFrame(sync);
	const observer = new ResizeObserver(() => {
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
	layouts.set(key, {
		widths : layout.widths ? [...layout.widths] : undefined,
		heights: layout.heights ? [...layout.heights] : undefined,
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
	const layout = layouts.get(key);
	if (!layout) {
		return undefined;
	}

	return {
		widths : layout.widths ? [...layout.widths] : undefined,
		heights: layout.heights ? [...layout.heights] : undefined,
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
export function resolveTableResizeHit(
	columnHit: { index: number; distance: number } | null,
	rowHit: { index: number; distance: number } | null,
): TableResizeHit | null {
	if (columnHit && rowHit) {
		return columnHit.distance <= rowHit.distance
			? { kind: 'col', index: columnHit.index }
			: { kind: 'row', index: rowHit.index };
	}

	if (columnHit) {
		return { kind: 'col', index: columnHit.index };
	}

	if (rowHit) {
		return { kind: 'row', index: rowHit.index };
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
	const columnCount = getRenderedColumnCount(table);
	if (!layout || (!layout.widths?.length && !layout.heights?.length) || columnCount === 0) {
		table.classList.remove('is-resized');
		table.style.tableLayout = '';
		table.style.width       = '';
		clearColWidths(table);
		clearRowHeights(table);
		syncTableCellWrapping(table);
		return;
	}

	const hasWidths = Boolean(layout.widths?.length);
	if (hasWidths) {
		const columns = ensureColGroup(table, columnCount);

		table.classList.add('is-resized');
		table.style.tableLayout = 'fixed';
		let total               = 0;
		[...columns.children].forEach((column, index) => {
			const width = layout.widths?.[index] ?? 0;
			if (width > 0) {
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

	if (layout.heights && layout.heights.length > 0) {
		[...table.rows].forEach((row, index) => {
			const height     = layout.heights?.[index];
			row.style.height = height && height > 0
				? `${clampRowHeight(height)}px`
				: '';
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
export function shouldWrapTableCell(
	contentWidth: number,
	availableWidth: number,
	tolerance = 1,
): boolean {
	return contentWidth > availableWidth + tolerance;
}

/** 固定列幅に収まらないセルだけへ折り返しクラスを付ける */
function syncTableCellWrapping(table: HTMLTableElement, widths?: number[]): void {
	const cells = [...table.querySelectorAll<HTMLElement>('th, td')];
	cells.forEach((cell) => cell.classList.remove(TABLE_CELL_WRAP_CLASS));
	if (!widths?.length) {
		return;
	}

	cells.forEach((cell) => {
		const tableCell      = cell as HTMLTableCellElement;
		const column         = Number(tableCell.dataset.tableColumn) || 0;
		const colspan        = Math.max(1, tableCell.colSpan || 1);
		const fixedWidth     = widths
			.slice(column, column + colspan)
			.reduce((total, width) => total + clampColumnWidth(width), 0);
		const style          = cell.ownerDocument.defaultView?.getComputedStyle(cell);
		const contentWidth   = measureTableCellContentWidth(cell, style);
		const padding        = Number.parseFloat(style?.paddingLeft ?? '0')
			+ Number.parseFloat(style?.paddingRight ?? '0');
		const availableWidth = Math.max(0, fixedWidth - padding);
		cell.classList.toggle(
			TABLE_CELL_WRAP_CLASS,
			shouldWrapTableCell(contentWidth, availableWidth),
		);
	});
}

/** セル文字列を折り返さない状態で測定する。セル内の block 要素幅には依存しない */
function measureTableCellContentWidth(
	cell: HTMLElement,
	style: CSSStyleDeclaration | undefined,
): number {
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
	const width = probe.getBoundingClientRect().width;
	probe.remove();
	return width;
}

/**
 * リサイズ対象の軸で、クリックではなくドラッグとみなす距離を移動したか判定する
 */
export function hasTableResizePointerMoved(
	hit: TableResizeHit,
	start: { x: number; y: number },
	current: { x: number; y: number },
	threshold = TABLE_RESIZE_DRAG_THRESHOLD_PX,
): boolean {
	const delta = hit.kind === 'col' ? current.x - start.x : current.y - start.y;
	return Math.abs(delta) >= threshold;
}

/**
 * 操作対象以外の寸法は、既に保存済みの場合だけドラッグ中の固定値へ含める
 */
export function resolveActiveTableResizeLayout(
	hit: TableResizeHit,
	measured: TableLayout,
	hadPersistedWidths: boolean,
	hadPersistedHeights: boolean,
): TableLayout {
	return {
		widths : hit.kind === 'col' || hadPersistedWidths ? measured.widths : undefined,
		heights: hit.kind === 'row' || hadPersistedHeights ? measured.heights : undefined,
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
export function attachTableResize(
	wrap: HTMLElement,
	table: HTMLTableElement,
	key: string,
	options: TableResizeOptions = {},
): () => void {
	applyTableLayout(table, options.layout);

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

	const observer = new ResizeObserver(() => {
		if (!table.isConnected) {
			observer.disconnect();
			return;
		}

		if (table.classList.contains('is-resizing')) {
			return;
		}

		sync();
	});
	observer.observe(table);
	table.querySelectorAll('img').forEach((image) => {
		if (!image.complete) {
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
export function syncTableResizeHandles(
	overlay: HTMLElement,
	table: HTMLTableElement,
	key: string,
	onPersist?: (layout: TableLayout, hit: TableResizeHit) => void,
): void {
	overlay.replaceChildren();
	const tableRect = table.getBoundingClientRect();
	const wrap      = overlay.parentElement;
	const wrapRect  = wrap?.getBoundingClientRect();
	const tableLeft = wrap && wrapRect
		? resolveTableRelativeOffset(wrapRect.left, tableRect.left, wrap.scrollLeft)
		: table.offsetLeft;
	const tableTop  = wrap && wrapRect
		? resolveTableRelativeOffset(wrapRect.top, tableRect.top, wrap.scrollTop)
		: table.offsetTop;

	overlay.style.left   = `${tableLeft}px`;
	overlay.style.top    = `${tableTop}px`;
	overlay.style.width  = `${tableRect.width}px`;
	overlay.style.height = `${tableRect.height}px`;

	const rows = [...table.rows];
	if (rows.length === 0) {
		return;
	}

	const columnCount = getRenderedColumnCount(table);
	const boxes       = collectTableCellBoxes(table);
	computeColumnRightEdges(boxes, columnCount).forEach((right, index) => {
		if (right <= 0) {
			return;
		}

		const handle        = document.createElement('div');
		handle.className    = 'cm-md-table-col-resizer';
		handle.title        = 'ドラッグして列幅を変更';
		handle.style.left   = `${right - TABLE_RESIZE_HANDLE_PX}px`;
		handle.style.top    = '0';
		handle.style.height = `${tableRect.height}px`;
		bindResizeHandle(handle, table, key, { kind: 'col', index }, overlay, onPersist);
		overlay.appendChild(handle);
	});

	rows.forEach((row, index) => {
		const rowRect      = row.getBoundingClientRect();
		const handle       = document.createElement('div');
		handle.className   = 'cm-md-table-row-resizer';
		handle.title       = 'ドラッグして行高を変更';
		handle.style.left  = '0';
		handle.style.top   = `${rowRect.bottom - tableRect.top - TABLE_RESIZE_HANDLE_PX}px`;
		handle.style.width = `${tableRect.width}px`;
		bindResizeHandle(handle, table, key, { kind: 'row', index }, overlay, onPersist);
		overlay.appendChild(handle);
	});
}

/**
 * 現在の列幅・行高を測る
 * @param table - 表
 * @returns レイアウト
 */
export function measureTableLayout(table: HTMLTableElement): TableLayout {
	const columnCount = getRenderedColumnCount(table);
	return {
		widths : computeColumnWidths(collectTableCellBoxes(table), columnCount),
		heights: [...table.rows].map((row) => clampRowHeight(row.getBoundingClientRect().height)),
	};
}

/**
 * 描画済みセルの列位置と幅を集める
 * @param table - 表
 * @returns 描画済みセルの列位置と幅を集める
 */
export function collectTableCellBoxes(table: HTMLTableElement): TableCellBox[] {
	const tableRect = table.getBoundingClientRect();
	return [...table.querySelectorAll('th, td')].map((cell) => {
		const rect = cell.getBoundingClientRect();
		return {
			column : Number((cell as HTMLTableCellElement).dataset.tableColumn) || 0,
			colspan: (cell as HTMLTableCellElement).colSpan || 1,
			left   : rect.left - tableRect.left,
			width  : rect.width,
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
	const edges = Array.from({ length: columnCount }, () => 0);
	for (let column = 0; column < columnCount; column += 1) {
		const ending = boxes.find((box) => box.column + box.colspan - 1 === column);
		if (ending) {
			edges[column] = ending.left + ending.width;
			continue;
		}

		const covering = boxes.find((box) => box.column <= column && box.column + box.colspan - 1 >= column);
		if (covering) {
			edges[column] = covering.left + (covering.width * ((column - covering.column + 1) / covering.colspan));
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
	const widths = Array.from({ length: columnCount }, () => 0);
	for (let column = 0; column < columnCount; column += 1) {
		const unmerged = boxes.filter((box) => box.column === column && box.colspan === 1);
		if (unmerged.length > 0) {
			widths[column] = Math.max(...unmerged.map((box) => box.width));
			continue;
		}

		const covering = boxes.find((box) => box.column <= column && box.column + box.colspan - 1 >= column);
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
function bindResizeHandle(
	handle: HTMLElement,
	table: HTMLTableElement,
	key: string,
	hit: TableResizeHit,
	overlay: HTMLElement,
	onPersist?: (layout: TableLayout, hit: TableResizeHit) => void,
): void {
	handle.addEventListener('pointerdown', (event) => {
		if (event.button !== 0) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		startTableResize(table, key, hit, event, () => {
			if (!table.classList.contains('is-resizing')) {
				syncTableResizeHandles(overlay, table, key, onPersist);
			}
		}, onPersist);
	});
}

/**
 * @param table - 表
 * @param _key - 互換用（ドラッグ中は共有メモリへ書かない）
 * @param hit - ヒット
 * @param event - 開始イベント
 * @param onSync - ハンドル再配置
 */
function startTableResize(
	table: HTMLTableElement,
	_key: string,
	hit: TableResizeHit,
	event: PointerEvent,
	onSync: () => void,
	onPersist?: (layout: TableLayout, hit: TableResizeHit) => void,
): void {
	const measured            = measureTableLayout(table);
	const widths              = [...(measured.widths ?? [])];
	const heights             = [...(measured.heights ?? [])];
	const startX              = event.clientX;
	const startY              = event.clientY;
	const startW              = widths[hit.index] ?? MIN_COLUMN_WIDTH;
	const startH              = heights[hit.index] ?? MIN_ROW_HEIGHT;
	const handle              = event.currentTarget;
	const start               = { x: startX, y: startY };
	const hadPersistedWidths  = table.classList.contains('is-resized');
	const hadPersistedHeights = [...table.rows].some((row) => row.style.height !== '');

	let resizing = false;
	if (handle instanceof HTMLElement) {
		handle.setPointerCapture(event.pointerId);
	}

	/**
	 * @param moveEvent - 移動
	 */
	const onMove = (moveEvent: PointerEvent): void => {
		if (!resizing && !hasTableResizePointerMoved(hit, start, {
			x: moveEvent.clientX,
			y: moveEvent.clientY,
		})) {
			return;
		}

		if (!resizing) {
			resizing = true;
			table.classList.add('is-resizing');
			if (handle instanceof HTMLElement) {
				handle.classList.add('is-active');
			}
		}

		if (hit.kind === 'col') {
			widths[hit.index] = clampColumnWidth(startW + (moveEvent.clientX - startX));
		} else {
			heights[hit.index] = clampRowHeight(startH + (moveEvent.clientY - startY));
		}

		applyTableLayout(table, resolveActiveTableResizeLayout(
			hit,
			{ widths, heights },
			hadPersistedWidths,
			hadPersistedHeights,
		));
	};

	/**
	 * @param endEvent - 終了
	 */
	const onUp = (endEvent: PointerEvent): void => {
		if (resizing) {
			table.classList.remove('is-resizing');
		}
		if (handle instanceof HTMLElement) {
			if (resizing) {
				handle.classList.remove('is-active');
			}
			if (handle.hasPointerCapture(endEvent.pointerId)) {
				handle.releasePointerCapture(endEvent.pointerId);
			}

			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			handle.removeEventListener('pointercancel', onUp);
		}

		if (resizing) {
			onSync();
			onPersist?.({ widths, heights }, hit);
		}
	};

	if (handle instanceof HTMLElement) {
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
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
	const fromData = Number(table.dataset.columnCount);
	if (Number.isInteger(fromData) && fromData > 0) {
		return fromData;
	}

	const fromCells = Math.max(
		0,
		...[...table.querySelectorAll('th, td')].map((cell) => {
			const start = Number((cell as HTMLTableCellElement).dataset.tableColumn) || 0;
			return start + ((cell as HTMLTableCellElement).colSpan || 1);
		}),
	);
	return fromCells;
}

/**
 * @param table - 表
 * @param columnCount - 列数
 * @returns colgroup
 */
function ensureColGroup(table: HTMLTableElement, columnCount: number): HTMLTableColElement {
	let group = table.querySelector('colgroup');
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
