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
 * 設定の生ルールを、行ごとに使い回す正規表現とクラスへ変えたもの
 * 不正なパターンはここに入らない。実行中に regexp の lastIndex だけ進む
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
 * コンパイルできたルールと、スキップした名前
 * 装飾には rules だけを使い、invalidNames は設定の警告用
 */
export type CompileCustomDecorationsResult = {
	/** コンパイルできたルール。不正なパターンは含めない */
	rules: CompiledCustomDecorationRule[];
	/** スキップしたルール名。無名は (unnamed) */
	invalidNames: string[];
};

/**
 * 文書上の1一致。装飾する範囲と、区切りを隠す範囲を分けて持つ
 * 行内の相対位置ではなく、文書先頭からの文字位置
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
export function compileCustomDecorationRules(rawRules: CustomDecorationRule[] | undefined | null): CompileCustomDecorationsResult {
	// コンパイルできたルール。不正なパターンは含めない
	const rules: CompiledCustomDecorationRule[] = [];
	// スキップしたルール名。無名は (unnamed)。配列でなければ空
	const invalidNames: string[]                = [];

	// 配列でなければルールも不正名も空のまま返す
	if (!Array.isArray(rawRules)) {
		// 入力が配列でないときの結果。両方空
		return {
			// 採用したルール。入力が配列でないので空
			rules,
			// スキップした名前。配列でない入力は名前を残さない
			invalidNames
		};
	}

	for (const raw of rawRules) {
		// 設定上の表示名。文字列でなければ空文字
		const name  = typeof raw?.name === 'string' ? raw.name.trim() : '';
		// 不正時に残す名前。空なら (unnamed)
		const label = name || '(unnamed)';

		// 無効なルールはコンパイルも不正一覧もせず飛ばす
		if (raw?.enabled === false) {
			continue;
		}

		// 正規表現の元文字列。文字列でなければ空
		const pattern  = typeof raw?.pattern === 'string' ? raw.pattern : '';
		// 前後の空白を除いたクラス。文字列でなければ空
		const cssClass = typeof raw?.cssClass === 'string' ? raw.cssClass.trim() : '';

		// パターンかクラスが空、またはクラスが識別子でないときは不正名へ積む。どれか一つが欠けても採用しない
		if (!pattern || !cssClass || !isSafeCssClassName(cssClass)) {
			invalidNames.push(label);
			continue;
		}

		// d と g を付けた正規表現。パターンが構文エラーなら代入しない
		let regexp: RegExp;
		try {
			// d: indices（キャプチャ範囲）、g: 行内の複数一致
			regexp = new RegExp(pattern, 'gd');
		} catch {
			invalidNames.push(label);
			continue;
		}

		// 行の走査に使うコンパイル済みルール
		rules.push({
			// 表示名。空なら (unnamed)
			name: label,
			// 行ごとに lastIndex を戻して使う正規表現
			regexp,
			// 最初のキャプチャの外側を隠すか。未設定は false
			hideDelimiters: Boolean(raw.hideDelimiters),
			// mark に付けるクラス。安全な識別子だけがここまで来る
			cssClass
		});
	}

	// 採用とスキップを分けた結果
	return {
		// コンパイルできたルール。不正なパターンは含まない
		rules,
		// スキップしたルール名。無名は (unnamed)
		invalidNames
	};
}

/**
 * 1 テキストに対するカスタム装飾範囲を収集する
 * @param text - 対象テキスト
 * @param rules - ルール
 * @param baseOffset - ドキュメント先頭からのオフセット。省略可
 * @returns 集めた1 テキストに対するカスタム装飾範囲。該当が無ければ空
 */
export function collectCustomDecorationRangesFromText(text: string, rules: CompiledCustomDecorationRule[], baseOffset = 0): CustomDecorationRange[] {
	// 文書座標の一致範囲。該当が無ければ空
	const ranges: CustomDecorationRange[] = [];

	for (const rule of rules) {
		rule.regexp.lastIndex = 0;
		// テキスト内の次の一致。無ければ null。ルールごとに先頭から探す
		let match             = rule.regexp.exec(text);
		while (match) {
			// 空一致は同じ位置で止まらないよう 1 文字進めて読み直す
			if (match[0].length === 0) {
				rule.regexp.lastIndex += 1;
				match                  = rule.regexp.exec(text);
				continue;
			}

			// 一致全体の開始。文書上の文字位置
			const fullFrom = baseOffset + match.index;
			// 一致全体の終端。文書上の文字位置
			const fullTo   = fullFrom + match[0].length;
			// 最初のキャプチャの開始と終端。キャプチャが無ければ undefined
			const indices  = match.indices?.[1];
			// 装飾する開始。キャプチャが無ければ一致全体の開始
			const from     = indices ? baseOffset + indices[0] : fullFrom;
			// 装飾する終端。キャプチャが無ければ一致全体の終端
			const to       = indices ? baseOffset + indices[1] : fullTo;
			// 装飾範囲が空でなければ積む。空の範囲は mark にしない
			if (from < to) {
				// 区切り隠しと mark に使う1一致
				ranges.push({
					// 一致全体の開始。区切りを隠すときの外側
					fullFrom,
					// 一致全体の終端。区切りを隠すときの外側
					fullTo,
					// 装飾する開始。キャプチャが無ければ fullFrom
					from,
					// 装飾する終端。キャプチャが無ければ fullTo
					to,
					// mark に付けるクラス。ルールから写す
					cssClass: rule.cssClass,
					// キャプチャの外側を隠すか。ルールから写す
					hideDelimiters: rule.hideDelimiters
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
export function collectCustomDecorationRangesFromDoc(doc: { lines: number; line: (n: number) => { from: number; text: string } }, rules: CompiledCustomDecorationRule[]): CustomDecorationRange[] {
	// ルールが無いときは行を読まない
	if (rules.length === 0) {
		return [];
	}

	// 全行の一致。無ければ空
	const ranges: CustomDecorationRange[] = [];
	for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
		// その行。from は文書上の開始位置
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
export const customDecorationsFacet = Facet.define<CompiledCustomDecorationRule[], CompiledCustomDecorationRule[]>({
	/**
	 * 提供されたルールのうち、最後の1件を現在値にする
	 * @param values - この Facet へ提供されたルール。空ならルール無し
	 * @returns 最後のルール配列。提供が無ければ空
	 */
	combine(values) {
		return values.length > 0 ? values[values.length - 1]! : [];
	}
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
			// ルール更新が見つかった時点で、その配列で置き換える。他の Effect では値を変えない
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
	provide: (field) => customDecorationsFacet.from(field)
});

/**
 * カスタム装飾拡張を生成する
 * @param initial - 初期ルール
 * @returns カスタム装飾拡張
 */
export function createCustomDecorationsExtensions(initial: CompiledCustomDecorationRule[]): Extension[] {
	return [customDecorationsField.init(() => initial)];
}

/**
 * 1 行に対してルールを適用した Decoration エントリを追加する
 * @param entries - エントリ
 * @param lineText - 行テキスト
 * @param lineFrom - 行先頭位置
 * @param rule - ルール
 */
function pushMatchesForLine(entries: DecorationEntry[], lineText: string, lineFrom: number, rule: CompiledCustomDecorationRule): void {
	rule.regexp.lastIndex = 0;
	// 行内の次の一致。無ければ null
	let match             = rule.regexp.exec(lineText);
	while (match) {
		// 空一致は同じ位置で止まらないよう 1 文字進めて読み直す
		if (match[0].length === 0) {
			rule.regexp.lastIndex += 1;
			match                  = rule.regexp.exec(lineText);
			continue;
		}

		// 一致全体の開始。文書上の文字位置
		const fullFrom = lineFrom + match.index;
		// 一致全体の終端。文書上の文字位置
		const fullTo   = fullFrom + match[0].length;
		// 最初のキャプチャの開始と終端。キャプチャが無ければ undefined
		const indices  = match.indices?.[1];

		// キャプチャ範囲とキャプチャ文字列が両方あるときだけ区切りを分ける。どちらか一方が欠けても一致全体を mark する
		if (indices && typeof match[1] === 'string') {
			// キャプチャ本文の開始。文書上の文字位置
			const groupFrom = lineFrom + indices[0];
			// キャプチャ本文の終端。文書上の文字位置
			const groupTo   = lineFrom + indices[1];

			// 区切りを隠すルールのときだけ、キャプチャの外側をレイアウトから外す
			if (rule.hideDelimiters) {
				pushHiddenReplace(entries, fullFrom, groupFrom);
				pushHiddenReplace(entries, groupTo, fullTo);
			}

			// キャプチャ本文が空でなければ mark を足す
			if (groupFrom < groupTo) {
				// キャプチャ本文だけの mark。区切りは別の隠し装飾
				entries.push({
					// 本文の開始。文書上の文字位置
					from: groupFrom,
					// 本文の終端。文書上の文字位置
					to: groupTo,
					// ルールのクラスを付けた mark。本文の文字は残す
					decoration: Decoration.mark({ class: rule.cssClass })
				});
			}
		} else {
			// キャプチャが無い一致全体の mark
			entries.push({
				// 一致全体の開始。文書上の文字位置
				from: fullFrom,
				// 一致全体の終端。文書上の文字位置
				to: fullTo,
				// ルールのクラスを付けた mark。一致した文字は残す
				decoration: Decoration.mark({ class: rule.cssClass })
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
export function collectCustomDecorationEntries(state: EditorState, sourceLineNumbers: Set<number> = collectSourceLineNumbers(state), rules?: CompiledCustomDecorationRule[]): DecorationEntry[] {
	// 使うルール。引数が無ければ Facet、それも無ければフィールド。どれも無ければ空配列
	const activeRules = rules ?? state.facet(customDecorationsFacet) ?? state.field(customDecorationsField, false) ?? [];

	// ルールが無いときは行を走査しない
	if (activeRules.length === 0) {
		return [];
	}

	// 返す mark と隠し装飾。該当が無ければ空
	const entries: DecorationEntry[] = [];

	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		// ソース表示の行はカスタム装飾を足さない
		if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
			continue;
		}

		// プレビュー行。from は一致位置へ足す文書上の開始
		const line = state.doc.line(lineNumber);
		for (const rule of activeRules) {
			pushMatchesForLine(entries, line.text, line.from, rule);
		}
	}

	return entries;
}
