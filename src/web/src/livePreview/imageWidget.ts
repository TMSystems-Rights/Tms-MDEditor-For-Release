/**
 * プレビューの画像をウィジェットで描き、読み込んだ Data URL をプロセス内にキャッシュする
 * 幅のノートへの保存は imageResize へ渡し、このファイルは表示と読み込みの境界を持つ
 * @file
 */
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { BRIDGE_METHOD, invokeBridge } from '../bridge';
import type { DecorationEntry } from './inlineDecorations';
import { rememberCellImageWidth, recallCellImageWidth } from './cellImageWidthMemory';
import { applyImageDisplayWidth, applyImageWidthByPath, applyImageWidthOnDocumentLine } from './imageResize';

// ----------------------------------------------
// ラッパに束縛する参照
// ----------------------------------------------
/** 画像ラッパからパスへの対応。要素が捨てられると消える */
const imageWrapPaths      = new WeakMap<HTMLElement, string>();
/** 表セルなど、DOM から EditorView を引けないときの束縛 */
const imageWrapViews      = new WeakMap<HTMLElement, EditorView>();
/** 表セル専用の幅の書き戻し。無ければ imageResize の通常経路 */
const imageWrapPersisters = new WeakMap<HTMLElement, (width: number) => boolean>();

/**
 * 画像ラッパに保持したパスを返す
 * @param wrap - ラッパ
 * @returns 画像ラッパに保持したパス
 */
export function getImageWrapPath(wrap: HTMLElement): string {
	return imageWrapPaths.get(wrap) ?? wrap.dataset.imagePath ?? '';
}

/**
 * 表セルなど findFromDOM が使えない場所へ EditorView を束縛する
 * @param wrap - ラッパ
 * @param view - エディタ
 */
export function bindImageWrapEditorView(wrap: HTMLElement, view: EditorView): void {
	imageWrapViews.set(wrap, view);
}

/**
 * 表セル専用の幅書き戻しを束縛する
 * @param wrap - ラッパ
 * @param persist - 書き戻し
 */
export function bindImageResizePersister(wrap: HTMLElement, persist: (width: number) => boolean): void {
	imageWrapPersisters.set(wrap, persist);
}

/** 画像参照の種類。URL、絶対パス、ノート相対、Wiki 埋め込み */
export type ImageSourceKind = 'url' | 'absolute' | 'relative' | 'embed';

/** 1枚の画像を描くための参照と表示サイズ。幅の保存前の値 */
export type ImageSpec = {
	/** サイズ指定を除いた alt。空でもよい */
	alt: string;
	/** 記法に書かれたパスまたは URL。解決前 */
	raw: string;
	/** 参照の種類。読み込み方を決める */
	kind: ImageSourceKind;
	/** ドキュメントファイルの絶対パス（相対・埋め込み解決用） */
	documentPath: string | null;
	/** リモート URL を読むか。false のときは読み込まない */
	loadRemoteImages: boolean;
	/** 表示幅（px）。指定が無ければ null */
	width: number | null;
	/** 表示高さ（px）。幅だけなら null */
	height: number | null;
	/** 表セル内など、posAtDOM が使えないときのソース位置 */
	sourceFrom?: number;
	/** 記法の終了位置 */
	sourceTo?: number;
};

/** ホストが返した画像読み込み結果。失敗時は ok が false */
type ReadImageResult = {
	/** Data URL を返せたら true */
	ok: boolean;
	/** 読み込んだ Data URL。失敗時は未設定 */
	dataUrl?: string;
	/** 解決したファイルパス。失敗時は未設定 */
	resolvedPath?: string;
	/** 失敗理由。成功時は未設定 */
	error?: string;
};

/** キャッシュキーから Data URL。失敗は入れない。実行中だけ持つ */
const imageCache = new Map<string, string>();

/**
 * 画像ソースの種別を判定する
 * @param raw - 生のパス / URL
 * @returns 画像ソースの種別を判定する
 */
export function classifyImageSource(raw: string): ImageSourceKind {
	const trimmed = raw.trim();
	if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
		return 'url';
	}

	// Windows 絶対パス / UNC / ルート相対（/foo）以外の drive 付き
	if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
		return 'absolute';
	}

	return 'relative';
}

/**
 * キャッシュキーを生成する
 * @param spec - 画像仕様
 * @returns キャッシュキー
 */
function cacheKeyFor(spec: ImageSpec): string {
	return `${spec.kind}|${spec.documentPath ?? ''}|${spec.raw}`;
}

/**
 * ローカル画像を Data URL として読み込む
 * @param spec - 画像仕様
 * @returns ローカル画像を Data URL として読み込む。無ければ null
 */
async function loadLocalImageDataUrl(spec: ImageSpec): Promise<string | null> {
	const key    = cacheKeyFor(spec);
	const cached = imageCache.get(key);
	if (cached) {
		return cached;
	}

	try {
		const result = await invokeBridge<ReadImageResult>(BRIDGE_METHOD.fileReadImageAsDataUrl, {
			path         : spec.kind === 'embed' ? undefined : spec.raw,
			embed        : spec.kind === 'embed' ? spec.raw : undefined,
			documentPath : spec.documentPath ?? undefined,
		});
		if (!result.ok || !result.dataUrl) {
			return null;
		}

		imageCache.set(key, result.dataUrl);
		return result.dataUrl;
	} catch {
		return null;
	}
}

/**
 * 絶対パスの埋め込みは未保存でも解決できる
 * @param spec - 画像仕様
 * @returns 絶対パスの埋め込みは未保存でも解決できるなら true
 */
function needsDocumentPath(spec: ImageSpec): boolean {
	if (spec.kind === 'relative') {
		return true;
	}

	if (spec.kind === 'embed' && classifyImageSource(spec.raw) !== 'absolute') {
		return true;
	}

	return false;
}

// ----------------------------------------------
// 画像の描画
// ----------------------------------------------
/**
 * 画像ウィジェット
 */
export class ImageWidget extends WidgetType {
	/** 描く画像の参照とサイズ。生成後は別インスタンスへ作り直す */
	readonly spec: ImageSpec;

	/**
	 * @param spec - 画像仕様
	 */
	constructor(spec: ImageSpec) {
		super();
		this.spec = spec;
	}

	/**
	 * @param other - 比較対象
	 * @returns 同一なら true
	 */
	eq(other: WidgetType): boolean {
		if (!(other instanceof ImageWidget)) {
			return false;
		}

		return other.spec.alt === this.spec.alt
			&& other.spec.raw === this.spec.raw
			&& other.spec.kind === this.spec.kind
			&& other.spec.documentPath === this.spec.documentPath
			&& other.spec.loadRemoteImages === this.spec.loadRemoteImages
			&& other.spec.width === this.spec.width
			&& other.spec.height === this.spec.height
			&& other.spec.sourceFrom === this.spec.sourceFrom
			&& other.spec.sourceTo === this.spec.sourceTo;
	}

	/**
	 * @param view - エディタ（表セルから渡す／CodeMirror が渡す）。省略可
	 * @returns 生成した要素
	 */
	toDOM(view?: EditorView): HTMLElement {
		const wrap     = document.createElement('span');
		wrap.className = 'cm-md-image-wrap';
		wrap.setAttribute('contenteditable', 'false');
		if (this.spec.sourceFrom !== undefined) {
			wrap.dataset.sourceFrom = String(this.spec.sourceFrom);
		}

		if (this.spec.sourceTo !== undefined) {
			wrap.dataset.sourceTo = String(this.spec.sourceTo);
		}

		wrap.dataset.imagePath = this.spec.raw.replaceAll('\\', '/');
		imageWrapPaths.set(wrap, this.spec.raw);
		if (view) {
			imageWrapViews.set(wrap, view);
		}

		const img     = document.createElement('img');
		img.className = 'cm-md-image';
		img.alt       = this.spec.alt || this.spec.raw;
		img.title     = this.spec.raw;
		img.draggable = false;
		applyImageDisplayStyle(img, this.spec);

		const placeholder       = document.createElement('span');
		placeholder.className   = 'cm-md-image-fallback';
		placeholder.textContent = this.spec.raw;

		const handle     = document.createElement('span');
		handle.className = 'cm-md-image-resize';
		handle.title     = 'ドラッグしてサイズを変更';
		handle.setAttribute('aria-hidden', 'true');
		bindImageResizeHandle(wrap, img, handle);

		/**
		 * 破損プレースホルダを表示する
		 * @param message - 追加メッセージ。省略可
		 */
		const showFallback = (message?: string): void => {
			img.remove();
			handle.remove();
			placeholder.textContent = message
				? `${this.spec.raw}（${message}）`
				: this.spec.raw;
			if (!placeholder.isConnected) {
				wrap.appendChild(placeholder);
			}
		};

		if (this.spec.kind === 'url') {
			if (!this.spec.loadRemoteImages) {
				showFallback('リモート画像オフ');
				return wrap;
			}

			img.src = this.spec.raw;
			img.addEventListener('error', () => showFallback('読み込み失敗'));
			wrap.append(img, handle);
			return wrap;
		}

		if (needsDocumentPath(this.spec) && !this.spec.documentPath) {
			showFallback('未保存のため解決不可');
			return wrap;
		}

		wrap.appendChild(placeholder);
		void loadLocalImageDataUrl(this.spec).then((dataUrl) => {
			if (!dataUrl) {
				showFallback('見つかりません');
				return;
			}

			img.src = dataUrl;
			applyImageDisplayStyle(img, this.spec);
			img.addEventListener('load', () => applyImageDisplayStyle(img, this.spec));
			img.addEventListener('error', () => showFallback('読み込み失敗'));
			placeholder.replaceWith(img);
			wrap.appendChild(handle);
		});

		return wrap;
	}

	/**
	 * @returns 見積もった高さ
	 */
	get estimatedHeight(): number {
		return this.spec.width ? Math.max(80, Math.round(this.spec.width * 0.6)) : 120;
	}

	/**
	 * クリックでキャレットを記法上へ置かない（ソース展開でハンドルが消えるのを防ぐ）
	 * @returns クリックでキャレットを記法上へ置かない（ソース展開でハンドルが消えるのを防ぐ）なら true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * 指定幅があれば適用し、未指定なら既定キャップを使う
 * @param img - 画像
 * @param spec - 仕様
 */
function applyImageDisplayStyle(img: HTMLImageElement, spec: ImageSpec): void {
	const width = spec.width && spec.width > 0
		? spec.width
		: recallCellImageWidth(spec.raw);
	if (width && width > 0) {
		img.classList.add('is-sized');
		img.style.width     = `${width}px`;
		img.style.height    = spec.height && spec.height > 0 ? `${spec.height}px` : 'auto';
		img.style.maxWidth  = '100%';
		img.style.maxHeight = 'none';
		return;
	}

	img.classList.remove('is-sized');
	img.style.width     = '';
	img.style.height    = '';
	img.style.maxWidth  = '';
	img.style.maxHeight = '';
}

/**
 * 右下ハンドルのドラッグで幅を変え、mouseup でソースへ書き戻す
 * @param wrap - ラッパ
 * @param img - 画像
 * @param handle - ハンドル
 */
function bindImageResizeHandle(wrap: HTMLElement, img: HTMLImageElement, handle: HTMLElement): void {
	let dragging = false;

	/**
	 * ハンドルのドラッグを開始する
	 * @param clientX - 開始 X
	 * @param pointerId - Pointer Capture 用 ID。省略可
	 */
	const startDrag = (clientX: number, pointerId?: number): void => {
		if (dragging) {
			return;
		}

		dragging         = true;
		const startX     = clientX;
		const startWidth = img.getBoundingClientRect().width || img.naturalWidth || 120;
		const maxWidth   = Math.max(80, wrap.closest('.cm-content')?.clientWidth ?? 720);
		let lastWidth    = startWidth;
		let moved        = false;
		let finished     = false;

		if (pointerId !== undefined) {
			try {
				handle.setPointerCapture(pointerId);
			} catch {
				// Pointer Capture 非対応環境では document 追跡に落とす
			}
		}

		/**
		 * ドラッグ中の幅を更新する
		 * @param moveX - ポインタ X
		 */
		const applyMove = (moveX: number): void => {
			const next = Math.min(maxWidth, Math.max(24, startWidth + (moveX - startX)));
			if (Math.abs(next - startWidth) >= 2) {
				moved = true;
			}

			lastWidth = next;
			img.classList.add('is-sized');
			img.style.width     = `${next}px`;
			img.style.height    = 'auto';
			img.style.maxWidth  = '100%';
			img.style.maxHeight = 'none';
		};

		/**
		 * ドラッグ終了時にソースへ書き戻す
		 */
		const finish = (): void => {
			if (finished) {
				return;
			}

			finished = true;
			dragging = false;
			window.removeEventListener('pointermove', onPointerMove, true);
			window.removeEventListener('pointerup', finish, true);
			window.removeEventListener('pointercancel', finish, true);
			window.removeEventListener('mousemove', onMouseMove, true);
			window.removeEventListener('mouseup', finish, true);
			document.removeEventListener('pointerup', finish, true);
			document.removeEventListener('mouseup', finish, true);
			handle.removeEventListener('lostpointercapture', finish);
			if (pointerId !== undefined) {
				try {
					if (handle.hasPointerCapture(pointerId)) {
						handle.releasePointerCapture(pointerId);
					}
				} catch {
					// Pointer Capture 非対応環境では解放不要
				}
			}

			if (!moved) {
				return;
			}

			persistImageResizeWidth(wrap, lastWidth);
		};

		/**
		 * @param moveEvent - ポインタ移動
		 */
		const onPointerMove = (moveEvent: PointerEvent): void => {
			applyMove(moveEvent.clientX);
		};

		/**
		 * @param moveEvent - マウス移動
		 */
		const onMouseMove = (moveEvent: MouseEvent): void => {
			applyMove(moveEvent.clientX);
		};

		window.addEventListener('pointermove', onPointerMove, true);
		window.addEventListener('pointerup', finish, true);
		window.addEventListener('pointercancel', finish, true);
		window.addEventListener('mousemove', onMouseMove, true);
		window.addEventListener('mouseup', finish, true);
		document.addEventListener('pointerup', finish, true);
		document.addEventListener('mouseup', finish, true);
		handle.addEventListener('lostpointercapture', finish);
	};

	handle.addEventListener('pointerdown', (event) => {
		if (event.button !== 0) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		startDrag(event.clientX, event.pointerId);
	});
	handle.addEventListener('mousedown', (event) => {
		if (event.button !== 0) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		startDrag(event.clientX);
	});
}

/**
 * ドラッグ結果を Markdown へ書き戻す
 * 表セルでは findFromDOM が失敗しても、束縛した view / 書き戻しでソースへ残す
 * @param wrap - 画像ラッパ
 * @param width - 幅
 * @returns 更新したか
 */
export function persistImageResizeWidth(wrap: HTMLElement, width: number): boolean {
	const path      = getImageWrapPath(wrap);
	const tableCell = wrap.closest<HTMLElement>('[data-table-row]');
	const row       = Number(tableCell?.dataset.tableRow);
	const column    = Number(tableCell?.dataset.tableColumn);
	rememberCellImageWidth(
		path,
		width,
		Number.isInteger(row) && Number.isInteger(column) ? { row, column } : undefined,
	);

	const persist = imageWrapPersisters.get(wrap);
	let   wrote   = persist?.(width) ?? false;
	const view    = imageWrapViews.get(wrap) ?? EditorView.findFromDOM(wrap);
	if (!wrote && view) {
		const sourceFrom = wrap.dataset.sourceFrom;
		const sourceTo   = wrap.dataset.sourceTo;
		let pos          = sourceFrom !== undefined && sourceFrom !== ''
			? Number(sourceFrom)
			: NaN;
		if (!Number.isFinite(pos)) {
			try {
				pos = view.posAtDOM(wrap);
			} catch {
				pos = NaN;
			}
		}

		const end = sourceTo !== undefined && sourceTo !== ''
			? Number(sourceTo)
			: undefined;
		wrote     = applyImageWidthByPath(view, path, width, Number.isFinite(pos) ? pos : undefined)
			|| (Number.isFinite(pos) && applyImageWidthOnDocumentLine(view, pos, width))
			|| (Number.isFinite(pos) && applyImageDisplayWidth(
				view,
				pos,
				width,
				Number.isFinite(end) ? end : undefined,
			));
	}

	wrap.dispatchEvent(new CustomEvent('tms-mde-table-image-resized', {
		bubbles: true,
		detail : { width, persisted: wrote },
	}));
	return wrote;
}

/**
 * 画像ノードをウィジェットへ置換する
 * @param entries - エントリ配列
 * @param from - 開始位置
 * @param to - 終了位置
 * @param spec - 画像仕様
 */
export function pushImageReplace(
	entries: DecorationEntry[],
	from: number,
	to: number,
	spec: ImageSpec,
): void {
	if (from >= to) {
		return;
	}

	entries.push({
		from,
		to,
		decoration: Decoration.replace({
			widget: new ImageWidget(spec),
		}),
	});
}
