import { type Extension, Facet, StateEffect, StateField } from '@codemirror/state';

/**
 * 画像解決などに使うドキュメント文脈
 */
export type DocumentContext = {
	/** 開いている Markdown ファイルの絶対パス（未保存は null） */
	filePath: string | null;
	/** リモート画像を読み込むか */
	loadRemoteImages: boolean;
};

const DEFAULT_DOCUMENT_CONTEXT: DocumentContext = {
	filePath         : null,
	loadRemoteImages : true,
};

/**
 * ドキュメント文脈を更新する Effect
 */
export const setDocumentContextEffect = StateEffect.define<DocumentContext>();

/**
 * ドキュメント文脈 Facet（読み取り用）
 */
export const documentContextFacet = Facet.define<DocumentContext, DocumentContext>({
	/**
	 * @param {readonly DocumentContext[]} values 提供値
	 * @returns {DocumentContext}
	 */
	combine(values) {
		return values.length > 0 ? values[values.length - 1]! : DEFAULT_DOCUMENT_CONTEXT;
	},
});

/**
 * ドキュメント文脈を保持する StateField
 */
export const documentContextField = StateField.define<DocumentContext>({
	/**
	 * @returns {DocumentContext}
	 */
	create() {
		return DEFAULT_DOCUMENT_CONTEXT;
	},
	/**
	 * @param {DocumentContext} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {DocumentContext}
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setDocumentContextEffect)) {
				return effect.value;
			}
		}

		return value;
	},
	/**
	 * @param {StateField<DocumentContext>} field フィールド
	 * @returns {Extension}
	 */
	provide: (field) => documentContextFacet.from(field),
});

/**
 * ドキュメント文脈拡張を生成する
 * @param {DocumentContext} initial 初期値
 * @returns {Extension[]}
 */
export function createDocumentContextExtensions(initial: DocumentContext): Extension[] {
	return [
		documentContextField.init(() => initial),
	];
}

/**
 * 既定のドキュメント文脈を返す
 * @returns {DocumentContext}
 */
export function getDefaultDocumentContext(): DocumentContext {
	return { ...DEFAULT_DOCUMENT_CONTEXT };
}
