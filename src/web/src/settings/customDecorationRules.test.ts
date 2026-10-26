/**
 * カスタム装飾ルールの検証、追加、保存前の正規化を確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { createNewCustomDecorationRule, normalizeCustomDecorationRules, validateCustomDecorationRules } from './customDecorationRules';

describe('customDecorationRules settings helpers', () => {
	it('日本語と記号を含む正規表現ルールを受け入れる', () => {
		// 日本語と中黒を含むルール。エラーは出ない
		const errors = validateCustomDecorationRules([
			{
				// ルール名。空ではない
				name: '重要・要確認',
				// 有効。無効だと検証を緩める
				enabled: true,
				// 全角括弧の中を取る正規表現
				pattern: '【([^】\\n]+)】',
				// 括弧自体は出さない
				hideDelimiters: true,
				// 付与するクラス。空白やセミコロンは含まない
				cssClass: 'tms-important-ja'
			}
		]);

		expect(errors).toEqual([]);
	});

	it('空の名前、不正な正規表現、不正なCSSクラスを項目別に検出する', () => {
		// 名前、正規表現、CSS クラスが同時に不正なルール
		const errors = validateCustomDecorationRules([
			{
				// 空白だけの名前。空として不正
				name: ' ',
				// 閉じていない括弧。正規表現として不正
				pattern: '(',
				// 空白とセミコロンを含むクラス。CSS として不正
				cssClass: 'bad class;'
			}
		]);

		expect(errors.map((error) => error.field)).toEqual(['name', 'pattern', 'cssClass']);
	});

	it('不正な旧ルールでも無効状態なら保存を許可する', () => {
		// 無効なので、中身が不正でも保存を許すルール
		const errors = validateCustomDecorationRules([
			{
				// 空の名前。有効なら不正
				name: '',
				// 無効。このとき中身の不正はエラーにしない
				enabled: false,
				// 閉じていない括弧
				pattern: '(',
				// 空白とセミコロンを含むクラス
				cssClass: 'bad class;'
			}
		]);

		expect(errors).toEqual([]);
	});

	it('追加ルールは既存CSSクラスと重複せず区切り記号を隠す状態で作成する', () => {
		// 既存クラス tms-custom-2 の次番号を採るためのルール
		const rule = createNewCustomDecorationRule([
			{
				// 既存ルールの名前。採番には使わない
				name: '既存',
				// 既存の正規表現。採番には使わない
				pattern: '(既存)',
				// 既存クラス。次の追加は tms-custom-3 になる
				cssClass: 'tms-custom-2'
			}
		]);

		expect(rule).toEqual({
			// 追加時の名前。連番 3
			name: '新しい装飾ルール 3',
			// 追加直後は無効
			enabled: false,
			// 区切り付きの既定パターン
			pattern: '_v(.+?)_v',
			// 区切りは隠す
			hideDelimiters: true,
			// 既存と重ならないクラス
			cssClass: 'tms-custom-3'
		});
	});

	it('保存前に名前とCSSクラスだけをトリムしてbooleanを補完する', () => {
		// 前後の空白と、省略された boolean を補完するルール
		const normalized = normalizeCustomDecorationRules([
			{
				// 前後に空白がある名前。保存前にトリムする
				name: '  TODO強調  ',
				// 正規表現。トリムしない
				pattern: '(TODO: )',
				// 前後に空白があるクラス。保存前にトリムする
				cssClass: '  tms-todo  '
			}
		]);

		expect(normalized[0]).toEqual({
			// トリム後の名前
			name: 'TODO強調',
			// 省略時は有効
			enabled: true,
			// 正規表現はそのまま
			pattern: '(TODO: )',
			// 省略時は区切りを隠さない
			hideDelimiters: false,
			// トリム後のクラス
			cssClass: 'tms-todo'
		});
	});
});
