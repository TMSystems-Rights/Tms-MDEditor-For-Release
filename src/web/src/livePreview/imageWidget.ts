import { Decoration, WidgetType } from '@codemirror/view';
import { invokeBridge } from '../bridge';
import type { DecorationEntry } from './inlineDecorations';

export type ImageSourceKind = 'url' | 'absolute' | 'relative' | 'embed';

export type ImageSpec = {
	alt: string;
	raw: string;
	kind: ImageSourceKind;
	/** ドキュメントファイルの絶対パス（相対・埋め込み解決用） */
	documentPath: string | null;
	loadRemoteImages: boolean;
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
			&& other.spec.loadRemoteImages === this.spec.loadRemoteImages;
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

		const placeholder       = document.createElement('span');
		placeholder.className   = 'cm-md-image-fallback';
		placeholder.textContent = this.spec.raw;

		/**
		 * 破損プレースホルダを表示する
		 * @param {string} [message] 追加メッセージ
		 * @returns {void}
		 */
		const showFallback = (message?: string): void => {
			img.remove();
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
			wrap.appendChild(img);
			return wrap;
		}

		if ((this.spec.kind === 'relative' || this.spec.kind === 'embed') && !this.spec.documentPath) {
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
		});

		return wrap;
	}

	/**
	 * @returns {number}
	 */
	get estimatedHeight(): number {
		return 120;
	}

	/**
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
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
