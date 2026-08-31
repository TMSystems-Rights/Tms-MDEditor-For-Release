import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import {
	type EditorState,
	type Extension,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from '@codemirror/state';
import type { EolKind } from '../types/app';

/**
 * 行単位 EOL マップをエディタ状態へ反映する Effect
 */
export const setLineEolsEffect = StateEffect.define<Array<EolKind | null>>();

/**
 * エディタ状態に保持する行単位 EOL マップ
 */
export const lineEolsField = StateField.define<Array<EolKind | null>>({
	/**
	 * 初期値を生成する
	 * @returns {Array<EolKind | null>}
	 */
	create() {
		return [];
	},
	/**
	 * Effect に応じて更新する
	 * @param {Array<EolKind | null>} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {Array<EolKind | null>}
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setLineEolsEffect)) {
				return effect.value;
			}
		}

		return value;
	},
});

/**
 * EOL 種別を表示用記号へ変換する
 * @param {EolKind} eol EOL 種別
 * @returns {string}
 */
function eolToMarker(eol: EolKind): string {
	switch (eol) {
		case 'crlf':
			return '↲';
		case 'cr':
			return '←';
		case 'lf':
		default:
			return '↓';
	}
}

/**
 * 改行コード表示用ウィジェット
 */
class EolMarkerWidget extends WidgetType {
	private readonly marker: string;

	/**
	 * @param {EolKind} eol EOL 種別
	 */
	constructor(eol: EolKind) {
		super();
		this.marker = eolToMarker(eol);
	}

	/**
	 * 同一ウィジェットか判定する
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof EolMarkerWidget && other.marker === this.marker;
	}

	/**
	 * DOM を生成する
	 * @returns {HTMLElement}
	 */
	toDOM(): HTMLElement {
		const span       = document.createElement('span');
		span.className   = 'cm-eol-marker';
		span.textContent = this.marker;
		span.setAttribute('aria-hidden', 'true');
		return span;
	}

	/**
	 * イベントを無視する
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * 行末に改行コードマーカー Decoration を構築する
 * @param {EditorState} state エディタ状態
 * @returns {DecorationSet}
 */
function buildEolDecorations(state: EditorState): DecorationSet {
	const lineEols  = state.field(lineEolsField, false) ?? [];
	const builder   = new RangeSetBuilder<Decoration>();
	const lineCount = state.doc.lines;

	for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
		const eol = lineEols[lineNumber - 1] ?? null;
		if (!eol) {
			continue;
		}

		const line = state.doc.line(lineNumber);
		builder.add(
			line.to,
			line.to,
			Decoration.widget({
				widget: new EolMarkerWidget(eol),
				side  : 1,
				atomic: false,
			}),
		);
	}

	return builder.finish();
}

/**
 * 改行コード表示用 StateField
 */
const eolMarkersField = StateField.define<DecorationSet>({
	/**
	 * 初期 Decoration を生成する
	 * @param {EditorState} state エディタ状態
	 * @returns {DecorationSet}
	 */
	create(state) {
		return buildEolDecorations(state);
	},
	/**
	 * ドキュメントまたは EOL マップ更新時に再構築する
	 * @param {DecorationSet} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {DecorationSet}
	 */
	update(value, transaction) {
		const lineEolsChanged = transaction.effects.some((effect) => effect.is(setLineEolsEffect));
		if (transaction.docChanged || lineEolsChanged) {
			return buildEolDecorations(transaction.state);
		}

		return value.map(transaction.changes);
	},
	/**
	 * エディタへ Decoration を提供する
	 * @param {StateField<DecorationSet>} field フィールド
	 * @returns {Extension}
	 */
	provide: (field) => EditorView.decorations.from(field),
});

/**
 * 改行コード表示拡張を生成する
 * @param {Array<EolKind | null>} initialLineEols 初期行単位 EOL
 * @returns {Extension[]}
 */
export function createEolMarkerExtensions(initialLineEols: Array<EolKind | null>): Extension[] {
	return [
		lineEolsField.init(() => [...initialLineEols]),
		eolMarkersField,
	];
}
