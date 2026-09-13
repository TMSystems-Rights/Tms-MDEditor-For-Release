export type TableResizeHit = {
	kind: 'col' | 'row';
	index: number;
};

export type TableLayout = {
	widths?: number[];
	heights?: number[];
};

export type TableCellBox = {
	column: number;
	colspan: number;
	left: number;
	width: number;
};

export type TableResizeOptions = {
	layout?: TableLayout;
	onPersist?: (layout: TableLayout, hit: TableResizeHit) => void;
};

const MIN_COLUMN_WIDTH = 32;
const MIN_ROW_HEIGHT   = 24;

/** 列・行ハンドルのヒット幅（px） */
export const TABLE_RESIZE_HANDLE_PX = 14;

const layouts = new Map<string, TableLayout>();

/**
 * 表レイアウトの保存キーを返す。
 * @param {number} tableFrom 表の開始位置
 * @param {number} columnCount 列数
 * @returns {string} キー
 */
export function getTableLayoutKey(tableFrom: number, columnCount: number): string {
	return `${tableFrom}:${columnCount}`;
}

/**
 * ドラッグで決めた列幅・行高を覚える。
 * @param {string} key 保存キー
 * @param {TableLayout} layout レイアウト
 * @returns {void}
 */
export function rememberTableLayout(key: string, layout: TableLayout): void {
	layouts.set(key, {
		widths : layout.widths ? [...layout.widths] : undefined,
		heights: layout.heights ? [...layout.heights] : undefined,
	});
}

/**
 * 1 表の保存レイアウトを消す。
 * @param {string} key 保存キー
 * @returns {void}
 */
export function forgetTableLayout(key: string): void {
	layouts.delete(key);
}

/**
 * 保存した列幅・行高を返す。
 * @param {string} key 保存キー
 * @returns {TableLayout | undefined} レイアウト
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
 * 試験用に保存レイアウトを消す。
 * @returns {void}
 */
export function clearTableLayouts(): void {
	layouts.clear();
}

/**
 * 列ヒットと行ヒットのうち近い方を返す。
 * @param {{ index: number; distance: number } | null} columnHit 列
 * @param {{ index: number; distance: number } | null} rowHit 行
 * @returns {TableResizeHit | null} ヒット
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
 * 列幅の下限を適用する。
 * @param {number} width 幅
 * @returns {number} クランプ後
 */
export function clampColumnWidth(width: number): number {
	return Math.max(MIN_COLUMN_WIDTH, Math.round(width));
}

/**
 * 行高の下限を適用する。
 * @param {number} height 高さ
 * @returns {number} クランプ後
 */
export function clampRowHeight(height: number): number {
	return Math.max(MIN_ROW_HEIGHT, Math.round(height));
}

/**
 * 保存した列幅・行高を表へ適用する。
 * @param {HTMLTableElement} table 表
 * @param {TableLayout | undefined} layout レイアウト
 * @returns {void}
 */
export function applyTableLayout(table: HTMLTableElement, layout: TableLayout | undefined): void {
	const columnCount = getRenderedColumnCount(table);
	if (!layout || (!layout.widths?.length && !layout.heights?.length) || columnCount === 0) {
		table.classList.remove('is-resized');
		table.style.tableLayout = '';
		table.style.width       = '';
		clearColWidths(table);
		clearRowHeights(table);
		return;
	}

	table.classList.add('is-resized');
	table.style.tableLayout = 'fixed';
	const columns           = ensureColGroup(table, columnCount);
	if (layout.widths && layout.widths.length > 0) {
		let total = 0;
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
	}

	if (layout.heights && layout.heights.length > 0) {
		[...table.rows].forEach((row, index) => {
			const height     = layout.heights?.[index];
			row.style.height = height && height > 0
				? `${clampRowHeight(height)}px`
				: '';
		});
	}
}

/**
 * 罫線ドラッグで列幅・行高を変えられるようにする。
 * @param {HTMLElement} wrap 表ラッパー
 * @param {HTMLTableElement} table 表
 * @param {string} key 保存キー
 * @param {TableResizeOptions} [options] ソースのレイアウトと確定時の書き戻し
 * @returns {void}
 */
export function attachTableResize(
	wrap: HTMLElement,
	table: HTMLTableElement,
	key: string,
	options: TableResizeOptions = {},
): void {
	applyTableLayout(table, options.layout);

	const overlay     = document.createElement('div');
	overlay.className = 'cm-md-table-resize-overlay';
	overlay.setAttribute('aria-hidden', 'true');
	wrap.appendChild(overlay);

	/**
	 * ハンドル位置を表の実寸に合わせる。
	 * @returns {void}
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
}

/**
 * 列・行のドラッグハンドルを罫線上へ置く。
 * @param {HTMLElement} overlay オーバーレイ
 * @param {HTMLTableElement} table 表
 * @param {string} key 保存キー
 * @param {(layout: TableLayout, hit: TableResizeHit) => void} [onPersist] 確定時
 * @returns {void}
 */
export function syncTableResizeHandles(
	overlay: HTMLElement,
	table: HTMLTableElement,
	key: string,
	onPersist?: (layout: TableLayout, hit: TableResizeHit) => void,
): void {
	overlay.replaceChildren();
	overlay.style.left   = `${table.offsetLeft}px`;
	overlay.style.top    = `${table.offsetTop}px`;
	overlay.style.width  = `${table.offsetWidth}px`;
	overlay.style.height = `${table.offsetHeight}px`;

	const rows = [...table.rows];
	if (rows.length === 0) {
		return;
	}

	const tableRect   = table.getBoundingClientRect();
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
 * 現在の列幅・行高を測る。
 * @param {HTMLTableElement} table 表
 * @returns {TableLayout} レイアウト
 */
export function measureTableLayout(table: HTMLTableElement): TableLayout {
	const columnCount = getRenderedColumnCount(table);
	return {
		widths : computeColumnWidths(collectTableCellBoxes(table), columnCount),
		heights: [...table.rows].map((row) => clampRowHeight(row.getBoundingClientRect().height)),
	};
}

/**
 * 描画済みセルの列位置と幅を集める。
 * @param {HTMLTableElement} table 表
 * @returns {TableCellBox[]}
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
 * 各列の右端位置を返す。結合セルでも列境界を出す。
 * @param {TableCellBox[]} boxes セル
 * @param {number} columnCount 列数
 * @returns {number[]}
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
 * 各列の幅を返す。結合セルは幅を列数で割る。
 * @param {TableCellBox[]} boxes セル
 * @param {number} columnCount 列数
 * @returns {number[]}
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
 * @param {HTMLElement} handle ハンドル
 * @param {HTMLTableElement} table 表
 * @param {string} key 保存キー
 * @param {TableResizeHit} hit ヒット
 * @param {HTMLElement} overlay オーバーレイ
 * @returns {void}
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
 * @param {HTMLTableElement} table 表
 * @param {string} _key 互換用（ドラッグ中は共有メモリへ書かない）
 * @param {TableResizeHit} hit ヒット
 * @param {PointerEvent} event 開始イベント
 * @param {() => void} onSync ハンドル再配置
 * @returns {void}
 */
function startTableResize(
	table: HTMLTableElement,
	_key: string,
	hit: TableResizeHit,
	event: PointerEvent,
	onSync: () => void,
	onPersist?: (layout: TableLayout, hit: TableResizeHit) => void,
): void {
	const measured = measureTableLayout(table);
	const widths   = [...(measured.widths ?? [])];
	const heights  = [...(measured.heights ?? [])];
	const startX   = event.clientX;
	const startY   = event.clientY;
	const startW   = widths[hit.index] ?? MIN_COLUMN_WIDTH;
	const startH   = heights[hit.index] ?? MIN_ROW_HEIGHT;
	const handle   = event.currentTarget;

	if (document.activeElement instanceof HTMLElement && table.contains(document.activeElement)) {
		document.activeElement.blur();
	}

	applyTableLayout(table, { widths, heights });
	table.classList.add('is-resizing');
	if (handle instanceof HTMLElement) {
		handle.classList.add('is-active');
		handle.setPointerCapture(event.pointerId);
	}

	/**
	 * @param {PointerEvent} moveEvent 移動
	 * @returns {void}
	 */
	const onMove = (moveEvent: PointerEvent): void => {
		if (hit.kind === 'col') {
			widths[hit.index] = clampColumnWidth(startW + (moveEvent.clientX - startX));
		} else {
			heights[hit.index] = clampRowHeight(startH + (moveEvent.clientY - startY));
		}

		applyTableLayout(table, { widths, heights });
	};

	/**
	 * @param {PointerEvent} endEvent 終了
	 * @returns {void}
	 */
	const onUp = (endEvent: PointerEvent): void => {
		table.classList.remove('is-resizing');
		if (handle instanceof HTMLElement) {
			handle.classList.remove('is-active');
			if (handle.hasPointerCapture(endEvent.pointerId)) {
				handle.releasePointerCapture(endEvent.pointerId);
			}

			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			handle.removeEventListener('pointercancel', onUp);
		}

		onSync();
		onPersist?.({ widths, heights }, hit);
	};

	if (handle instanceof HTMLElement) {
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
		handle.addEventListener('pointercancel', onUp);
	}
}

/**
 * @param {HTMLTableElement} table 表
 * @param {number} columnCount 列数
 * @returns {HTMLTableColElement} colgroup
 */
/**
 * 表の論理列数を返す。
 * @param {HTMLTableElement} table 表
 * @returns {number}
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
 * @param {HTMLTableElement} table 表
 * @param {number} columnCount 列数
 * @returns {HTMLTableColElement} colgroup
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
 * @param {HTMLTableElement} table 表
 * @returns {void}
 */
function clearColWidths(table: HTMLTableElement): void {
	table.querySelectorAll('col').forEach((column) => {
		column.style.width = '';
	});
}

/**
 * @param {HTMLTableElement} table 表
 * @returns {void}
 */
function clearRowHeights(table: HTMLTableElement): void {
	[...table.rows].forEach((row) => {
		row.style.height = '';
	});
}
