import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { invokeBridge } from '../bridge';
import type { DecorationEntry } from './inlineDecorations';
import { applyImageDisplayWidth } from './imageResize';

export type ImageSourceKind = 'url' | 'absolute' | 'relative' | 'embed';

export type ImageSpec = {
	alt: string;
	raw: string;
	kind: ImageSourceKind;
	/** ドキュメントファイルの絶対パス（相対・埋め込み解決用） */
	documentPath: string | null;
	loadRemoteImages: boolean;
	width: number | null;
	height: number | null;
};

type ReadImageResult = {
	ok: boolean;
	dataUrl?: string;
	resolvedPath?: string;
	error?: string;
};

const imageCache = new Map<string, string>();

/**
 * 画像ソースの種別を判定する
 * @param {string} raw 生のパス / URL
 * @returns {ImageSourceKind}
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
 * @param {ImageSpec} spec 画像仕様
 * @returns {string}
 */
function cacheKeyFor(spec: ImageSpec): string {
	return `${spec.kind}|${spec.documentPath ?? ''}|${spec.raw}`;
}

/**
 * ローカル画像を Data URL として読み込む
 * @param {ImageSpec} spec 画像仕様
 * @returns {Promise<string | null>}
 */
async function loadLocalImageDataUrl(spec: ImageSpec): Promise<string | null> {
	const key    = cacheKeyFor(spec);
	const cached = imageCache.get(key);
	if (cached) {
		return cached;
	}

	try {
		const result = await invokeBridge<ReadImageResult>('file:readImageAsDataUrl', {
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
 * @param {ImageSpec} spec 画像仕様
 * @returns {boolean}
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

/**
 * 画像ウィジェット
 */
export class ImageWidget extends WidgetType {
	readonly spec: ImageSpec;

	/**
	 * @param {ImageSpec} spec 画像仕様
	 */
	constructor(spec: ImageSpec) {
		super();
		this.spec = spec;
	}

	/**
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
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
			&& other.spec.height === this.spec.height;
	}

	/**
	 * @returns {HTMLElement}
	 */
	toDOM(): HTMLElement {
		const wrap     = document.createElement('span');
		wrap.className = 'cm-md-image-wrap';
		wrap.setAttribute('contenteditable', 'false');

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
		 * @param {string} [message] 追加メッセージ
		 * @returns {void}
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
			img.addEventListener('error', () => showFallback('読み込み失敗'));
			placeholder.replaceWith(img);
			wrap.appendChild(handle);
		});

		return wrap;
	}

	/**
	 * @returns {number}
	 */
	get estimatedHeight(): number {
		return this.spec.width ? Math.max(80, Math.round(this.spec.width * 0.6)) : 120;
	}

	/**
	 * クリックでキャレットを記法上へ置かない（ソース展開でハンドルが消えるのを防ぐ）
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * 指定幅があれば適用し、未指定なら既定キャップを使う
 * @param {HTMLImageElement} img 画像
 * @param {ImageSpec} spec 仕様
 * @returns {void}
 */
function applyImageDisplayStyle(img: HTMLImageElement, spec: ImageSpec): void {
	if (spec.width && spec.width > 0) {
		img.classList.add('is-sized');
		img.style.width     = `${spec.width}px`;
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
 * @param {HTMLElement} wrap ラッパ
 * @param {HTMLImageElement} img 画像
 * @param {HTMLElement} handle ハンドル
 * @returns {void}
 */
function bindImageResizeHandle(wrap: HTMLElement, img: HTMLImageElement, handle: HTMLElement): void {
	handle.addEventListener('mousedown', (event) => {
		if (event.button !== 0) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		const startX     = event.clientX;
		const startWidth = img.getBoundingClientRect().width;
		const maxWidth   = Math.max(80, wrap.closest('.cm-content')?.clientWidth ?? 720);
		let lastWidth    = startWidth;
		let moved        = false;

		/**
		 * ドラッグ中の幅を更新する
		 * @param {MouseEvent} moveEvent マウス移動
		 * @returns {void}
		 */
		const onMove = (moveEvent: MouseEvent): void => {
			const next = Math.min(maxWidth, Math.max(24, startWidth + (moveEvent.clientX - startX)));
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
		 * @returns {void}
		 */
		const onUp = (): void => {
			window.removeEventListener('mousemove', onMove, true);
			window.removeEventListener('mouseup', onUp, true);
			if (!moved) {
				return;
			}

			const view = EditorView.findFromDOM(wrap);
			if (!view) {
				return;
			}

			const pos = view.posAtDOM(wrap);
			applyImageDisplayWidth(view, pos, lastWidth);
		};

		window.addEventListener('mousemove', onMove, true);
		window.addEventListener('mouseup', onUp, true);
	});
}

/**
 * 画像ノードをウィジェットへ置換する
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} from 開始位置
 * @param {number} to 終了位置
 * @param {ImageSpec} spec 画像仕様
 * @returns {void}
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
