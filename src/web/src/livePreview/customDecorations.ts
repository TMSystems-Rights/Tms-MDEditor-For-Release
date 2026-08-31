import { Decoration } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';
import { Facet, StateEffect, StateField } from '@codemirror/state';
import type { CustomDecorationRule } from '../types/app';
import { isPreviewLineNumber, collectSourceLineNumbers } from './cursorLine';
import { pushHiddenReplace } from './hiddenContent';
import type { DecorationEntry } from './inlineDecorations';

/**
 * コンパイル済みカスタム装飾ルール
 */
export type CompiledCustomDecorationRule = {
	name: string;
	regexp: RegExp;
	hideDelimiters: boolean;
	cssClass: string;
};

/**
 * ルールコンパイル結果
 */
export type CompileCustomDecorationsResult = {
	rules: CompiledCustomDecorationRule[];
	invalidNames: string[];
};

/**
 * ドキュメント絶対座標のカスタム装飾範囲
 */
export type CustomDecorationRange = {
	fullFrom: number;
	fullTo: number;
	from: number;
	to: number;
	cssClass: string;
	hideDelimiters: boolean;
};

const CSS_CLASS_PATTERN = /^[A-Za-z_][\w-]*$/;

/**
 * cssClass が安全な識別子か
 * @param {string} cssClass クラス名
 * @returns {boolean}
 */
export function isSafeCssClassName(cssClass: string): boolean {
	return CSS_CLASS_PATTERN.test(cssClass);
}

/**
 * config のルールをコンパイルする（不正 regex はスキップ）
 * @param {CustomDecorationRule[] | undefined | null} rawRules 生ルール
 * @returns {CompileCustomDecorationsResult}
 */
export function compileCustomDecorationRules(
	rawRules: CustomDecorationRule[] | undefined | null,
): CompileCustomDecorationsResult {
	const rules: CompiledCustomDecorationRule[] = [];
	const invalidNames: string[]                = [];

	if (!Array.isArray(rawRules)) {
		return { rules, invalidNames };
	}

	for (const raw of rawRules) {
		const name  = typeof raw?.name === 'string' ? raw.name.trim() : '';
		const label = name || '(unnamed)';

		if (raw?.enabled === false) {
			continue;
		}

		const pattern  = typeof raw?.pattern === 'string' ? raw.pattern : '';
		const cssClass = typeof raw?.cssClass === 'string' ? raw.cssClass.trim() : '';

		if (!pattern || !cssClass || !isSafeCssClassName(cssClass)) {
			invalidNames.push(label);
			continue;
		}

		let regexp: RegExp;
		try {
			// d: indices（キャプチャ範囲）、g: 行内の複数一致
			regexp = new RegExp(pattern, 'gd');
		} catch {
			invalidNames.push(label);
			continue;
		}

		rules.push({
			name            : label,
			regexp,
			hideDelimiters  : Boolean(raw.hideDelimiters),
			cssClass,
		});
	}

	return { rules, invalidNames };
}

/**
 * 1 テキストに対するカスタム装飾範囲を収集する
 * @param {string} text 対象テキスト
 * @param {CompiledCustomDecorationRule[]} rules ルール
 * @param {number} [baseOffset] ドキュメント先頭からのオフセット
 * @returns {CustomDecorationRange[]}
 */
export function collectCustomDecorationRangesFromText(
	text: string,
	rules: CompiledCustomDecorationRule[],
	baseOffset = 0,
): CustomDecorationRange[] {
	const ranges: CustomDecorationRange[] = [];

	for (const rule of rules) {
		rule.regexp.lastIndex = 0;
		let match             = rule.regexp.exec(text);
		while (match) {
			if (match[0].length === 0) {
				rule.regexp.lastIndex += 1;
				match                  = rule.regexp.exec(text);
				continue;
			}

			const fullFrom = baseOffset + match.index;
			const fullTo   = fullFrom + match[0].length;
			const indices  = match.indices?.[1];
			const from     = indices ? baseOffset + indices[0] : fullFrom;
			const to       = indices ? baseOffset + indices[1] : fullTo;
			if (from < to) {
				ranges.push({
					fullFrom,
					fullTo,
					from,
					to,
					cssClass      : rule.cssClass,
					hideDelimiters: rule.hideDelimiters,
				});
			}

			match = rule.regexp.exec(text);
		}
	}

	return ranges;
}

/**
 * ドキュメント全行からカスタム装飾範囲を収集する
 * @param {{ lines: number; line: (n: number) => { from: number; text: string } }} doc ドキュメント
 * @param {CompiledCustomDecorationRule[]} rules ルール
 * @returns {CustomDecorationRange[]}
 */
export function collectCustomDecorationRangesFromDoc(
	doc: { lines: number; line: (n: number) => { from: number; text: string } },
	rules: CompiledCustomDecorationRule[],
): CustomDecorationRange[] {
	if (rules.length === 0) {
		return [];
	}

	const ranges: CustomDecorationRange[] = [];
	for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
		const line = doc.line(lineNumber);
		ranges.push(...collectCustomDecorationRangesFromText(line.text, rules, line.from));
	}

	return ranges;
}

/**
 * カスタム装飾ルールを更新する Effect
 */
export const setCustomDecorationsEffect = StateEffect.define<CompiledCustomDecorationRule[]>();

/**
 * カスタム装飾ルール Facet
 */
export const customDecorationsFacet = Facet.define<
	CompiledCustomDecorationRule[],
	CompiledCustomDecorationRule[]
>({
	/**
	 * @param {readonly CompiledCustomDecorationRule[][]} values 提供値
	 * @returns {CompiledCustomDecorationRule[]}
	 */
	combine(values) {
		return values.length > 0 ? values[values.length - 1]! : [];
	},
});

/**
 * カスタム装飾ルールを保持する StateField
 */
export const customDecorationsField = StateField.define<CompiledCustomDecorationRule[]>({
	/**
	 * @returns {CompiledCustomDecorationRule[]}
	 */
	create() {
		return [];
	},
	/**
	 * @param {CompiledCustomDecorationRule[]} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {CompiledCustomDecorationRule[]}
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setCustomDecorationsEffect)) {
				return effect.value;
			}
		}

		return value;
	},
	/**
	 * @param {StateField<CompiledCustomDecorationRule[]>} field フィールド
	 * @returns {Extension}
	 */
	provide: (field) => customDecorationsFacet.from(field),
});

/**
 * カスタム装飾拡張を生成する
 * @param {CompiledCustomDecorationRule[]} initial 初期ルール
 * @returns {Extension[]}
 */
export function createCustomDecorationsExtensions(
	initial: CompiledCustomDecorationRule[],
): Extension[] {
	return [
		customDecorationsField.init(() => initial),
	];
}

/**
 * 1 行に対してルールを適用した Decoration エントリを追加する
 * @param {DecorationEntry[]} entries エントリ
 * @param {string} lineText 行テキスト
 * @param {number} lineFrom 行先頭位置
 * @param {CompiledCustomDecorationRule} rule ルール
 * @returns {void}
 */
function pushMatchesForLine(
	entries: DecorationEntry[],
	lineText: string,
	lineFrom: number,
	rule: CompiledCustomDecorationRule,
): void {
	rule.regexp.lastIndex = 0;
	let match             = rule.regexp.exec(lineText);
	while (match) {
		if (match[0].length === 0) {
			rule.regexp.lastIndex += 1;
			match                  = rule.regexp.exec(lineText);
			continue;
		}

		const fullFrom = lineFrom + match.index;
		const fullTo   = fullFrom + match[0].length;
		const indices  = match.indices?.[1];

		if (indices && typeof match[1] === 'string') {
			const groupFrom = lineFrom + indices[0];
			const groupTo   = lineFrom + indices[1];

			if (rule.hideDelimiters) {
				pushHiddenReplace(entries, fullFrom, groupFrom);
				pushHiddenReplace(entries, groupTo, fullTo);
			}

			if (groupFrom < groupTo) {
				entries.push({
					from      : groupFrom,
					to        : groupTo,
					decoration: Decoration.mark({ class: rule.cssClass }),
				});
			}
		} else {
			entries.push({
				from      : fullFrom,
				to        : fullTo,
				decoration: Decoration.mark({ class: rule.cssClass }),
			});
		}

		match = rule.regexp.exec(lineText);
	}
}

/**
 * カスタム装飾の Decoration エントリを収集する
 * @param {EditorState} state 状態
 * @param {Set<number>} [sourceLineNumbers] ソース行
 * @param {CompiledCustomDecorationRule[]} [rules] ルール（省略時は Facet）
 * @returns {DecorationEntry[]}
 */
export function collectCustomDecorationEntries(
	state: EditorState,
	sourceLineNumbers: Set<number> = collectSourceLineNumbers(state),
	rules?: CompiledCustomDecorationRule[],
): DecorationEntry[] {
	const activeRules = rules
		?? state.facet(customDecorationsFacet)
		?? state.field(customDecorationsField, false)
		?? [];

	if (activeRules.length === 0) {
		return [];
	}

	const entries: DecorationEntry[] = [];

	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
			continue;
		}

		const line = state.doc.line(lineNumber);
		for (const rule of activeRules) {
			pushMatchesForLine(entries, line.text, line.from, rule);
		}
	}

	return entries;
}
