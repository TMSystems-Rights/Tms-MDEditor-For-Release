/**
 * 開いているノートのパスと、リモート画像を読むかをエディタ状態へ保持する
 * ファイルの読み書きは持たず、Effect と初期値で渡された文脈を Facet から公開する
 * @file
 */
import { type Extension, Facet, StateEffect, StateField } from '@codemirror/state';

/**
 * 画像解決などに使う、開いているドキュメントの文脈
 * 未保存ノートは filePath が null。設定の保存先とは別の、エディタ内の値
 */
export type DocumentContext = {
	/** 開いている Markdown ファイルの絶対パス。未保存は null */
	filePath: string | null;
	/** リモート画像を読み込むか。false のときはリモート URL を解決しない */
	loadRemoteImages: boolean;
};

/**
 * 文脈が未設定のときの値
 * filePath は null、リモート画像の読み込みは許可。実行中は置き換えず、コピーして返す
 */
const DEFAULT_DOCUMENT_CONTEXT: DocumentContext = {
	filePath         : null,
	loadRemoteImages : true,
};

/**
 * ドキュメント文脈を丸ごと置き換える StateEffect
 * 部分更新はせず、渡した DocumentContext が次の値になる
 */
export const setDocumentContextEffect = StateEffect.define<DocumentContext>();

/**
 * ドキュメント文脈の読み取り口
 * 複数提供されたときは最後の値を採用し、無ければ既定値を返す
 */
export const documentContextFacet = Facet.define<DocumentContext, DocumentContext>({
	/**
	 * 提供された文脈のうち、最後の1件を現在値にする
	 * @param values - この Facet へ提供された文脈。空なら既定値
	 * @returns 最後の文脈。提供が無ければ filePath は null
	 */
	combine(values) {
		return values.length > 0 ? values[values.length - 1]! : DEFAULT_DOCUMENT_CONTEXT;
	},
});

/**
 * ドキュメント文脈を保持し、Facet へ提供する StateField
 * setDocumentContextEffect 以外のトランザクションでは値を変えない
 */
export const documentContextField = StateField.define<DocumentContext>({
	/**
	 * 未設定の文脈を返す
	 * @returns filePath が null で、リモート画像の読み込みを許可する値
	 */
	create() {
		return DEFAULT_DOCUMENT_CONTEXT;
	},
	/**
	 * トランザクション内の setDocumentContextEffect で文脈を置き換える
	 * Effect が無ければ現在値を維持する
	 * @param value - 更新前の文脈
	 * @param transaction - 文脈の置き換え Effect を含み得るトランザクション
	 * @returns 最後に見つかった Effect の値。無ければ value
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
	 * このフィールドの値を documentContextFacet へ提供する
	 * @param field - 文脈を保持する StateField
	 * @returns Facet へ値を流す拡張
	 */
	provide: (field) => documentContextFacet.from(field),
});

/**
 * 初期文脈をフィールドへ載せた拡張を返す
 * 呼び出し側は戻り値をエディタの extensions へ渡す
 * @param initial - エディタ生成時の文脈。未保存なら filePath は null
 * @returns documentContextField を初期化する拡張の配列
 */
export function createDocumentContextExtensions(initial: DocumentContext): Extension[] {
	return [
		documentContextField.init(() => initial),
	];
}

/**
 * 既定のドキュメント文脈のコピーを返す
 * モジュール内の既定オブジェクトは変更しない
 * @returns filePath が null で、リモート画像の読み込みを許可する新しいオブジェクト
 */
export function getDefaultDocumentContext(): DocumentContext {
	return { ...DEFAULT_DOCUMENT_CONTEXT };
}
