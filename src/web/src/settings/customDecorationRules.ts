/**
 * 設定画面で編集するカスタム装飾ルールを作り、検証し、保存前に正規化する
 * エディタへの適用は持たない
 * @file
 */
import type { CustomDecorationRule } from '../types/app';
import { isSafeCssClassName } from '../livePreview/customDecorations';

/**
 * 検証エラーが指す入力欄
 * 名前、正規表現、CSS クラスのいずれか
 */
export type CustomDecorationRuleField = 'name' | 'pattern' | 'cssClass';

/**
 * 1 件のルール検証エラー
 * 無効なルールは検証しないため、ここには載らない
 */
export type CustomDecorationValidationError = {
	/** ルール配列の位置。0 始まり */
	index: number;
	/** エラーを表示する入力欄 */
	field: CustomDecorationRuleField;
	/** その欄の下に出す説明 */
	message: string;
};

/**
 * 設定画面から追加する新規ルールを生成する
 * CSS クラスは既存と重ならない `tms-custom-N` にし、追加直後は無効
 * @param current - すでに並んでいるルール。クラス名の重複回避に使う
 * @returns 未保存の新規ルール。区切り記号は隠す初期値
 */
export function createNewCustomDecorationRule(current: CustomDecorationRule[]): CustomDecorationRule {
	// クラス名の末尾番号。既存の長さの次から始め、衝突したら増やす
	let suffix = current.length + 1;
	while (current.some((rule) => rule.cssClass === `tms-custom-${suffix}`)) {
		suffix += 1;
	}

	// 追加直後のルール。有効にはせず、区切りは隠す
	return {
		// 画面に出す名前。番号はクラス名の末尾と揃える
		name: `新しい装飾ルール ${suffix}`,
		// 追加直後は無効。検証も適用もしない
		enabled: false,
		// 区切り付きの初期パターン。未編集のまま保存できる
		pattern: '_v(.+?)_v',
		// 区切り文字を表示しない初期値
		hideDelimiters: true,
		// 既存と重ならないクラス。tms-custom- に連番
		cssClass: `tms-custom-${suffix}`
	};
}

/**
 * GUI で編集したカスタム装飾ルールを検証する
 * 無効なルールは不正でも保存できるよう、検証をスキップする
 * @param rules - 画面上のルール一覧。無効なものはエラーにしない
 * @returns 有効なルールの入力エラー。問題が無ければ空配列
 */
export function validateCustomDecorationRules(rules: CustomDecorationRule[]): CustomDecorationValidationError[] {
	// 有効ルールの入力エラー。無効ルールは積まない
	const errors: CustomDecorationValidationError[] = [];

	rules.forEach((rule, index) => {
		// 不正な旧ルールでも、まず無効化して保存できるようにする
		if (rule.enabled === false) {
			return;
		}

		// 空白だけの名前は未入力
		if (!rule.name.trim()) {
			// 名前欄の未入力
			errors.push({
				// ルール配列の位置。0 始まり
				index,
				// 名前欄の下に出す
				field: 'name',
				// 画面に出す未入力の説明
				message: 'ルール名を入力してください。'
			});
		}

		// パターンが空。構文検査の前に未入力とする
		if (!rule.pattern) {
			// パターン欄の未入力
			errors.push({
				// ルール配列の位置。0 始まり
				index,
				// 正規表現欄の下に出す
				field: 'pattern',
				// 画面に出す未入力の説明
				message: '正規表現を入力してください。'
			});
		} else {
			try {
				new RegExp(rule.pattern, 'gd');
			} catch {
				// 構文エラー。未入力とは別の説明にする
				errors.push({
					// ルール配列の位置。0 始まり
					index,
					// 正規表現欄の下に出す
					field: 'pattern',
					// 画面に出す構文エラーの説明
					message: '正規表現の構文が正しくありません。'
				});
			}
		}

		// 前後空白を除いたクラス名。空なら未入力
		const cssClass = rule.cssClass.trim();
		// クラス名が空
		if (!cssClass) {
			// クラス欄の未入力
			errors.push({
				// ルール配列の位置。0 始まり
				index,
				// クラス欄の下に出す
				field: 'cssClass',
				// 画面に出す未入力の説明
				message: 'CSSクラスを入力してください。'
			});
			// 空ではないが、使える文字の並びになっていない
		} else if (!isSafeCssClassName(cssClass)) {
			// 使えない文字を含むクラス名
			errors.push({
				// ルール配列の位置。0 始まり
				index,
				// クラス欄の下に出す
				field: 'cssClass',
				// 画面に出す文字種の説明
				message: 'CSSクラスは英字または _ で始まり、英数字・_・- のみ使用できます。'
			});
		}
	});

	return errors;
}

/**
 * 保存用に文字列項目を正規化する
 * 名前と CSS クラスの前後空白を除き、有効フラグと区切り隠しを boolean に揃える。パターンは変えない
 * @param rules - 画面上のルール一覧
 * @returns 保存へ渡すルール。入力配列は変えない
 */
export function normalizeCustomDecorationRules(rules: CustomDecorationRule[]): CustomDecorationRule[] {
	// 保存へ渡す 1 件。名前とクラスの前後空白だけを除く
	return rules.map((rule) => ({
		// 前後空白を除いた表示名。空文字もありうる
		name: rule.name.trim(),
		// false 以外は有効。未設定は有効として保存する
		enabled: rule.enabled !== false,
		// パターン文字列。空白も含め変えない
		pattern: rule.pattern,
		// 区切りを隠すか。未設定は隠さない
		hideDelimiters: Boolean(rule.hideDelimiters),
		// 前後空白を除いたクラス名
		cssClass: rule.cssClass.trim()
	}));
}
