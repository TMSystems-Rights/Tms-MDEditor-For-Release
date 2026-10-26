// @ts-check

/**
 * src/web の TypeScript と scripts の mjs へ、ESLint の検査規則を当てる
 * このファイルは設定を export するだけで、読み書きも削除もしない
 * 終了コードは ESLint 本体が決める。このモジュールはプロセスを終了させない
 * @file
 */

// ブラウザと Node の組み込み名。languageOptions.globals へ渡す
import globals from 'globals';
// 推奨ルールの土台。TypeScript 用と mjs 用の両方へ広げる
import js from '@eslint/js';
// 関数に JSDoc が無いかを検査するプラグイン
import jsdoc from 'eslint-plugin-jsdoc';
// 代入の縦位置を揃えるプラグイン。カンマ周りの規則はこれと衝突するので切る
import alignAssignments from '@tms/eslint-plugin-align-assignments';
// TypeScript 推奨設定。適用ファイルは src/web の ts に限る
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.RulesRecord} */
// TypeScript と mjs で共有する規則。言語ごとの例外は後のブロックで上書きする
const baseRules = {
	// var は関数スコープになり、const のブロックと再代入の範囲が混ざる
	'no-var': 'error',
	// == は型変換をするため、比較は常に === にする
	eqeqeq: ['error', 'always'],
	// 改行するドットはプロパティ側に置く。オブジェクトの続きと誤読しない
	'dot-location': ['error', 'property'],
	// カンマの位置は強制しない。縦揃えで行頭にも行末にも付く
	'comma-style': 'off',
	// コメント記号の直後に空白が無いと、注釈とコードの境が消える
	'spaced-comment': ['error', 'always'],
	// 文字列をコードとして実行しない。このリポジトリでは使わない
	'no-eval': 'error',
	// setTimeout へ文字列を渡す間接的な実行も禁止する
	'no-implied-eval': 'error',
	// ラベルは制御の行き先を隠す。このリポジトリでは使わない
	'no-labels': 'error',
	// プリミティブをオブジェクトで包むと比較が壊れる
	'no-new-wrappers': 'error',
	// 先頭ドットの小数は、ドットがプロパティアクセスに見える
	'no-floating-decimal': 'error',
	// 関数名への再代入は、宣言と実体がずれる
	'no-func-assign': 'error',
	// 末尾カンマの有無は検査しない。縦揃えが行を増減させる
	'comma-dangle': 'off',
	// ディレクトリ名と文字列連結は区切りを欠く
	'no-path-concat': 'error',
	// プロトタイプ連鎖を直接いじらない
	'no-proto': 'error',
	// 名前付きの関数とクラスに JSDoc を要求する。呼び出し引数の無名関数は対象のまま残す
	'jsdoc/require-jsdoc': [
		'error',
		{
			// どの関数形に Doc を要求するか。false ならその形は欠落を許す
			require: {
				// 名前付き function に JSDoc が無いと、呼び出す側から引数と戻り値が見えない
				FunctionDeclaration: true,
				// メソッドの説明がクラスの外から見えない
				MethodDefinition: true,
				// クラスの役割が宣言に残らない
				ClassDeclaration: true,
				// 変数やプロパティへ代入したアローにも Doc を要求する
				ArrowFunctionExpression: true,
				// 変数へ束縛した function 式にも Doc を要求する
				FunctionExpression: true
			}
		}
	],
	// 文末セミコロンを必須にする。改行だけだと次の行と結合することがある
	semi: ['error', 'always'],
	// セミコロンの直後は空白、直前は詰める。逆だと行末が読みにくい
	'semi-spacing': ['error', { after: true, before: false }],
	// セミコロンは行末に置く。行頭だと空文と次の文が分かれる
	'semi-style': ['error', 'last'],
	// 空のセミコロンは文を増やさず、抜けと見分けが付かない
	'no-extra-semi': 'error',
	// セミコロンを省いた改行が、次の行と一つの文にならないようにする
	'no-unexpected-multiline': 'error',
	// 到達しない文は削除漏れ。残すと後続の修正が死にコードに隠れる
	'no-unreachable': 'error',
	// 見た目が空白の制御文字を禁止する。文字列、コメント、正規表現、テンプレートは対象外
	'no-irregular-whitespace': [
		'error',
		{
			// 文字列リテラル内の空白はデータなので検査しない
			skipStrings: true,
			// コメント内の空白は注釈なので検査しない
			skipComments: true,
			// 正規表現内の空白はパターンなので検査しない
			skipRegExps: true,
			// テンプレート内の空白は出力される文字なので検査しない
			skipTemplates: true
		}
	],
	// 代入の縦位置がずれると、変更行が値の差分に見える
	'align-assignments/align-assignments': 'error',
	// インデントはタブ。switch の case は 1 段だけ下げる
	indent: ['error', 'tab', { SwitchCase: 1 }],
	// 開き波括弧は行末。制御文と本体が離れると抜けが見えにくい
	'brace-style': ['error', '1tbs'],
	// オブジェクト波括弧の内側に空白を置く。キーと括弧がくっつかない
	'object-curly-spacing': ['error', 'always'],
	// 配列括弧の内側に空白を置かない。要素の区切りはカンマだけにする
	'array-bracket-spacing': ['error', 'never'],
	// カンマ前後の空白数は検査しない。縦揃えで空白数が変わる
	'comma-spacing': 'off',
	// キーワードの前後に空白を置く。if( のように詰めない
	'keyword-spacing': ['error', { before: true, after: true }],
	// ブロックの開き波括弧の前に空白を置く
	'space-before-blocks': 'error',
	// 無名関数と async アローは括弧の前に空白、名前付き関数は詰める
	'space-before-function-paren': [
		'error',
		{
			// 無名 function は括弧の前に空白。名前付きと見分けやすくする
			anonymous: 'always',
			// 名前付き関数は名前と括弧を詰める
			named: 'never',
			// async アローは async と括弧の間に空白を置く
			asyncArrow: 'always'
		}
	],
	// 未宣言の名前をエラーにする。mjs には型検査が無い
	'no-undef': 'error',
	// 未使用は警告。先頭がアンダースコアの引数は意図的な未使用として残す
	'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
};

// 無視設定、TypeScript、mjs の順。後のブロックが同じファイルに重なったときは後勝ち
export default [
	{
		// 依存と生成物は検査しない
		ignores: ['**/node_modules/**', '**/dist/**', '**/bin/**', '**/obj/**', 'release/**', '**/*.min.js']
	},
	// 推奨設定の files だけを TypeScript ソースに限る。中身の規則は維持する
	...tseslint.configs.recommended.map((config) => ({
		...config,
		// 推奨設定は src/web の ts だけに当てる。mjs は下のブロック
		files: ['src/web/**/*.ts']
	})),
	{
		// このブロックの対象。Web の TypeScript だけ
		files: ['src/web/**/*.ts'],
		// パーサとグローバル。ブラウザ上で動くスクリプト向け
		languageOptions: {
			// 新しい構文の下限。このリポジトリの TypeScript が使う範囲
			ecmaVersion: 2022,
			// import / export をモジュールとして読む
			sourceType: 'module',
			// window などのブラウザ組み込みを未定義にしない
			globals: globals.browser
		},
		// このブロックで有効にするプラグイン
		plugins: {
			// JSDoc の有無
			jsdoc: jsdoc,
			// 代入の縦位置
			'align-assignments': alignAssignments
		},
		// TypeScript 向けの上書き。共有規則のうち型側と二重になるものだけ切る
		rules: {
			// ESLint 推奨を土台にする
			...js.configs.recommended.rules,
			// 共有規則。この後の行で TypeScript 向けに上書きする
			...baseRules,
			// TypeScript 推奨は require をエラーにする。このブロックではその検査を掛けない
			'@typescript-eslint/no-require-imports': 'off',
			// 未定義名は TypeScript が見る。ESLint 側は二重にしない
			'no-undef': 'off',
			// 未使用は TypeScript 版に任せる。型だけの名前を ESLint が誤検知する
			'no-unused-vars': 'off',
			// 未使用は警告。先頭がアンダースコアの引数は意図的な未使用として残す
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
		}
	},
	{
		// このブロックの対象。scripts 配下の mjs だけ
		files: ['scripts/**/*.mjs'],
		// Node 上で直接実行するスクリプト向け
		languageOptions: {
			// 新しい構文の下限
			ecmaVersion: 2022,
			// import / export をモジュールとして読む
			sourceType: 'module',
			// process などの Node 組み込みを未定義にしない
			globals: globals.node
		},
		// このブロックで有効にするプラグイン。TypeScript 用は載せない
		plugins: {
			// JSDoc の有無
			jsdoc: jsdoc,
			// 代入の縦位置
			'align-assignments': alignAssignments
		},
		// mjs は共有規則のまま。型用の上書きはしない
		rules: {
			// ESLint 推奨を土台にする
			...js.configs.recommended.rules,
			// 共有規則。no-undef は型検査が無いので残す
			...baseRules
		}
	}
];
