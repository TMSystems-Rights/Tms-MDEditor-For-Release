/**
 * 利用者が定義した正規表現をコンパイルし、プレビュー行の mark と区切り隠しへ変える
 * ルールの保存は持たず、Facet に載った配列を読む
 * @file
 */
import { Decoration } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';
import { Facet, StateEffect, StateField } from '@codemirror/state';
import type { CustomDecorationRule } from '../types/app';
import { isPreviewLineNumber, collectSourceLineNumbers } from './cursorLine';
import { pushHiddenReplace } from './hiddenContent';
import type { DecorationEntry } from './inlineDecorations';

// ----------------------------------------------
// コンパイル済みルール
// ----------------------------------------------
/**
 * コンパイル済みカスタム装飾ルール
 */
export type CompiledCustomDecorationRule = {
	/** 設定上のルール名。空のときは (unnamed) */
	name: string;
	/** d と g を付けた正規表現。行ごとに lastIndex を戻して使う */
	regexp: RegExp;
	/** 最初のキャプチャの外側を隠すなら true */
	hideDelimiters: boolean;
	/** mark に付けるクラス。安全な識別子だけ */
	cssClass: string;
};

/**
 * ルールコンパイル結果
 */
export type CompileCustomDecorationsResult = {
	/** コンパイルできたルール。不正なパターンは含めない */
	rules: CompiledCustomDecorationRule[];
	/** スキップしたルール名。無名は (unnamed) */
	invalidNames: string[];
};

/**
 * ドキュメント絶対座標のカスタム装飾範囲
 */
export type CustomDecorationRange = {
	/** 一致全体の開始。文書上の文字位置 */
	fullFrom: number;
	/** 一致全体の終端。文書上の文字位置 */
	fullTo: number;
	/** 装飾する範囲の開始。キャプチャが無ければ fullFrom */
	from: number;
	/** 装飾する範囲の終端 */
	to: number;
	/** その範囲に付けるクラス */
	cssClass: string;
	/** キャプチャの外側を隠すか。ルールから写す */
	hideDelimiters: boolean;
};

/** クラス名として許す文字。英字か _ で始まり、以降は英数字と _ と -。実行中は変えない */
const CSS_CLASS_PATTERN = /^[A-Za-z_][\w-]*$/;

/**
 * cssClass が安全な識別子か
 * @param cssClass - クラス名
 * @returns cssClass が安全な識別子かなら true
 */
export function isSafeCssClassName(cssClass: string): boolean {
	return CSS_CLASS_PATTERN.test(cssClass);
}

/**
 * config のルールをコンパイルする（不正 regex はスキップ）
 * @param rawRules - 生ルール
 * @returns config のルールをコンパイルする（不正 regex はスキップ）
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
 * @param text - 対象テキスト
 * @param rules - ルール
 * @param baseOffset - ドキュメント先頭からのオフセット。省略可
 * @returns 集めた1 テキストに対するカスタム装飾範囲。該当が無ければ空
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
 * @param doc - ドキュメント
 * @param rules - ルール
 * @returns 集めたドキュメント全行からカスタム装飾範囲。該当が無ければ空
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

// ----------------------------------------------
// エディタ状態
// ----------------------------------------------
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
	 * 提供されたルールのうち、最後の1件を現在値にする
	 * @param values - この Facet へ提供されたルール。空ならルール無し
	 * @returns 最後のルール配列。提供が無ければ空
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
	 * ルールの無い初期値を返す
	 * @returns 空のルール配列
	 */
	create() {
		return [];
	},
	/**
	 * setCustomDecorationsEffect があれば、そのルールで置き換える
	 * @param value - 更新前のルール
	 * @param transaction - ルール更新 Effect を含み得るトランザクション
	 * @returns 置き換えたルール。Effect が無ければ value
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
	 * @param field - フィールド
	 * @returns エディタへ渡す拡張
	 */
	provide: (field) => customDecorationsFacet.from(field),
});

/**
 * カスタム装飾拡張を生成する
 * @param initial - 初期ルール
 * @returns カスタム装飾拡張
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
 * @param entries - エントリ
 * @param lineText - 行テキスト
 * @param lineFrom - 行先頭位置
 * @param rule - ルール
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

// ----------------------------------------------
// 装飾の収集
// ----------------------------------------------
/**
 * カスタム装飾の Decoration エントリを収集する
 * @param state - 状態
 * @param sourceLineNumbers - ソース行。省略可
 * @param rules - ルール（省略時は Facet）
 * @returns 集めたカスタム装飾の Decoration エントリ。該当が無ければ空
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
