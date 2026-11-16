/**
 * 発行済みの本体ディレクトリへ、同梱したサードパーティ製ソフトウェアのライセンス表示 THIRD_PARTY_NOTICES.txt を書く
 * 読むのは、発行先の *.deps.json、NuGet パッケージキャッシュの各パッケージ直下のライセンス系ファイルと nuspec、
 * Web のビルドが出力した webdist/THIRD_PARTY_NOTICES.txt である
 * 書くのは発行先直下の THIRD_PARTY_NOTICES.txt だけで、既にあれば上書きする。webdist 側のファイルと NuGet キャッシュは変更も削除もしない
 * 改行は CRLF、文字コードは BOM なしの UTF-8 で書く
 * 終了コード 0 は成功、1 は入力のファイルやライセンス文が見つからないこと、2 は引数の誤り
 * @file
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** 発行先直下に書くファイル名。インストーラとポータブル ZIP はこの名前で同梱する */
const NOTICES_FILE_NAME = 'THIRD_PARTY_NOTICES.txt';

/** Web のビルドが出力したライセンス表示。発行先からの相対パス */
const WEB_NOTICES_RELATIVE_PATH = join('webdist', 'THIRD_PARTY_NOTICES.txt');

/** 各パッケージの見出しを囲む区切り線。半角 80 文字で、Web 側の表示とそろえる */
const SECTION_RULE = '='.repeat(80);

/** パッケージ内で、ファイルごとの境目に置く区切り線。半角 80 文字で、Web 側の表示とそろえる */
const FILE_RULE = '-'.repeat(80);

/** NuGet パッケージ直下で、ライセンス系とみなすファイル名。.NET ランタイムの THIRD-PARTY-NOTICES も含む */
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice|third[-_]party[-_]notices)(?:[-._].*)?$/i;

/** deps.json の libraries のうち、ライセンス表示の対象にする type。project と reference は対象外 */
const TARGET_LIBRARY_TYPES = new Set(['package', 'runtimepack']);

/** deps.json の runtimepack が名前の前に付ける接頭辞。NuGet のパッケージ名には含まれない */
const RUNTIME_PACK_PREFIX = 'runtimepack.';

/**
 * 入力の欠落を表す例外
 * main が受け取ると、メッセージを出して終了コード 1 で終わる
 */
class MissingInputError extends Error {
	/**
	 * 欠落した入力を説明するメッセージで例外を作る
	 * @param message - 標準エラーへ出す説明。欠けているパスを含める
	 */
	constructor(message) {
		super(message);
		/** 例外の種類名。スタックトレースに出る */
		this.name = 'MissingInputError';
	}
}

/**
 * テキストの改行を LF にそろえ、先頭の BOM と末尾の空白行を落とす
 * @param {string} text - ファイルから読んだ本文
 * @returns {string} LF 区切りで末尾に改行を含まない本文
 */
function normalizeText(text) {
	return text
		.replace(/^﻿/, '') // UTF-8 の BOM は本文に含めない
		.replace(/\r\n?/g, '\n') // CRLF と CR を LF にそろえる
		.replace(/\s+$/, ''); // 末尾の空白と空行を落とす
}

/**
 * NuGet パッケージキャッシュのルートを返す
 * 環境変数 NUGET_PACKAGES があればそれを、無ければ利用者のホームの .nuget\packages を使う
 * @returns {string} キャッシュのルートの絶対パス
 */
function resolveNuGetRoot() {
	// dotnet restore と同じ優先順位で決めたキャッシュの場所。空文字の環境変数は未設定とみなす
	const fromEnv = process.env.NUGET_PACKAGES;
	return fromEnv && fromEnv.length > 0 ? resolve(fromEnv) : join(homedir(), '.nuget', 'packages');
}

/**
 * 発行先の deps.json から、ライセンス表示の対象にする NuGet パッケージを集める
 * runtimepack は接頭辞を外して NuGet のパッケージ名に戻す
 * @param {string} publishDir - 発行先の絶対パス
 * @returns {{ name: string, version: string }[]} パッケージ名と版。名前順
 * @throws {MissingInputError} 発行先に deps.json が無い、または 2 つ以上ある
 */
function readDotnetPackages(publishDir) {
	// 発行先直下の deps.json。本体 1 つ分だけがある前提
	const depsFiles = readdirSync(publishDir).filter((fileName) => fileName.endsWith('.deps.json'));
	// 0 件では対象が分からず、2 件以上ではどれが本体か決められない
	if (depsFiles.length !== 1) {
		throw new MissingInputError(`発行先の deps.json が 1 つではありません（${depsFiles.length} 件）: ${publishDir}`);
	}

	// deps.json の中身。libraries に名前/版と type が並ぶ
	const deps     = JSON.parse(readFileSync(join(publishDir, depsFiles[0]), 'utf8'));
	// 対象にするパッケージ。runtimepack は NuGet 名へ戻した値
	const packages = [];
	for (const [key, library] of Object.entries(deps.libraries ?? {})) {
		// アプリ自身（project）とパッケージ内の参照（reference）は、別の行で数えるので飛ばす
		if (!TARGET_LIBRARY_TYPES.has(library.type)) {
			continue;
		}

		// 名前/版 の区切り位置。名前に / は入らないので最後の / で分ける
		const slash   = key.lastIndexOf('/');
		// deps.json 上の名前。runtimepack は接頭辞付き
		const rawName = key.slice(0, slash);
		packages.push({
			// NuGet のパッケージ名。runtimepack の接頭辞は外す
			name: rawName.startsWith(RUNTIME_PACK_PREFIX) ? rawName.slice(RUNTIME_PACK_PREFIX.length) : rawName,
			// NuGet の版
			version: key.slice(slash + 1)
		});
	}

	return packages.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/**
 * nuspec から、一覧に出すライセンス名と取得元の URL を読む
 * @param {string} packageDir - NuGet キャッシュ内のパッケージのディレクトリ
 * @param {string} name - パッケージ名。nuspec のファイル名に使う
 * @returns {{ license: string, source: string }} license は SPDX 式か「同梱のライセンス文」。source は無いとき空文字
 */
function readNuspecInfo(packageDir, name) {
	// nuspec のパス。NuGet はパッケージ名を小文字にして置く
	const nuspecPath = join(packageDir, `${name.toLowerCase()}.nuspec`);
	// nuspec の本文。無いパッケージでは空文字にし、ライセンス文だけで表示する
	const nuspec     = existsSync(nuspecPath) ? readFileSync(nuspecPath, 'utf8') : '';
	// SPDX 式で宣言したライセンス。無いときは null
	const expression = /<license\s+type="expression"\s*>([^<]+)<\/license>/i.exec(nuspec);
	// repository の URL。無いときは projectUrl を使う
	const repository = /<repository\b[^>]*\burl="([^"]+)"/i.exec(nuspec);
	// 製品ページの URL。repository も無いときの取得元
	const projectUrl = /<projectUrl>([^<]+)<\/projectUrl>/i.exec(nuspec);
	// 一覧に出す値。宣言が無いときは同梱ファイルが正であることを書く
	return {
		// SPDX 式。ファイルで宣言しているパッケージは、その本文を正とする
		license: expression ? expression[1].trim() : '同梱のライセンス文のとおり',
		// 取得元。repository、projectUrl の順に使い、どちらも無ければ空文字
		source: repository ? repository[1] : projectUrl ? projectUrl[1].trim() : ''
	};
}

/**
 * NuGet パッケージ直下のライセンス系ファイルを名前順に読む
 * @param {string} packageDir - NuGet キャッシュ内のパッケージのディレクトリ
 * @returns {{ fileName: string, text: string }[]} 読めたファイル。中身の無いファイルは含めない
 */
function readLicenseFiles(packageDir) {
	// パッケージ直下のライセンス系ファイル名。名前順で、大文字小文字は区別しない
	const fileNames = readdirSync(packageDir)
		.filter((fileName) => LICENSE_FILE_PATTERN.test(fileName))
		.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
	// 読めたファイルの本文
	const files     = [];
	for (const fileName of fileNames) {
		// ライセンス系ファイルの絶対パス
		const filePath = join(packageDir, fileName);
		// 同じ名前のディレクトリはファイルとして読まない
		if (!statSync(filePath).isFile()) {
			continue;
		}

		// 改行と末尾をそろえた本文。空ならこのファイルは載せない
		const text = normalizeText(readFileSync(filePath, 'utf8'));
		// 中身の無いファイルは表示しても意味が無いので飛ばす
		if (text.length > 0) {
			files.push({ fileName, text });
		}
	}

	return files;
}

/**
 * .NET ランタイムと NuGet パッケージの節をテキストにする
 * 先頭に一覧、続けてパッケージごとのライセンス文を並べる。改行は LF
 * @param {{ name: string, version: string }[]} packages - readDotnetPackages が返したパッケージ
 * @param {string} nugetRoot - NuGet パッケージキャッシュのルート
 * @returns {string} 節の本文。末尾に改行を含まない
 * @throws {MissingInputError} キャッシュにパッケージが無い、またはライセンス文のファイルが 1 つも無い
 */
function formatDotnetSection(packages, nugetRoot) {
	// 一覧の行。本文より先に並べる
	const indexLines = [];
	// パッケージごとのライセンス文の行
	const bodyLines  = [];
	for (const pkg of packages) {
		// NuGet キャッシュ内の置き場所。名前は小文字
		const packageDir = join(nugetRoot, pkg.name.toLowerCase(), pkg.version);
		// 復元していないパッケージは、ライセンス文を読めないので止める
		if (!existsSync(packageDir)) {
			throw new MissingInputError(`NuGet キャッシュに ${pkg.name} ${pkg.version} がありません: ${packageDir}`);
		}

		// 一覧と見出しに出すライセンス名と取得元
		const info  = readNuspecInfo(packageDir, pkg.name);
		// 同梱するライセンス文。1 つも無ければ表示義務を満たせないので止める
		const files = readLicenseFiles(packageDir);
		// ライセンス文の無いパッケージを黙って載せない
		if (files.length === 0) {
			throw new MissingInputError(`${pkg.name} ${pkg.version} にライセンス文のファイルがありません: ${packageDir}`);
		}

		// 見出しに使う「名前 版」
		const title = `${pkg.name} ${pkg.version}`;
		indexLines.push(`  - ${title}  [${info.license}]`);
		bodyLines.push('', '', SECTION_RULE, title, SECTION_RULE, `License: ${info.license}`);
		// 取得元が分かるパッケージだけ、URL を載せる
		if (info.source.length > 0) {
			bodyLines.push(`Source: ${info.source}`);
		}

		for (const file of files) {
			bodyLines.push('', FILE_RULE, file.fileName, FILE_RULE, '', file.text);
		}
	}

	return ['.NET ランタイムと NuGet パッケージ（アプリ本体に同梱）', '', ...indexLines, ...bodyLines].join('\n');
}

/**
 * 発行先へ THIRD_PARTY_NOTICES.txt を書く
 * 先頭に説明、続けて .NET の節、最後に Web のビルドが出力した npm の節をそのまま並べる
 * @param {string} publishDir - 発行先の絶対パス
 * @param {string} version - 先頭に出すアプリの版。空文字なら版を出さない
 * @returns {string} 書いたファイルの絶対パス
 * @throws {MissingInputError} deps.json、NuGet のライセンス文、Web のライセンス表示のどれかが無い
 */
function writeNotices(publishDir, version) {
	// ----------------------------------------------
	// 読み取り
	// ----------------------------------------------

	// Web のビルドが出力した npm の節。発行時に webdist へコピーされている
	const webNoticesPath = join(publishDir, WEB_NOTICES_RELATIVE_PATH);
	// Web のビルドがプラグイン無しで行われたときは、npm の節が作れないので止める
	if (!existsSync(webNoticesPath)) {
		throw new MissingInputError(`Web のライセンス表示がありません。src/web を npm run build してから発行してください: ${webNoticesPath}`);
	}

	// npm の節の本文。改行は LF にそろえる
	const webSection    = normalizeText(readFileSync(webNoticesPath, 'utf8'));
	// .NET の節の本文
	const dotnetSection = formatDotnetSection(readDotnetPackages(publishDir), resolveNuGetRoot());

	// ----------------------------------------------
	// 書き出し
	// ----------------------------------------------

	// 先頭に出すアプリ名。版が分かるときだけ付ける
	const appTitle   = version.length > 0 ? `TMS-MDEditor ${version}` : 'TMS-MDEditor';
	// ファイル全体の本文。節と節の間は空行 3 つで区切る
	const text       = [
		`${appTitle} サードパーティ ソフトウェアのライセンス表示`, // 日本語の題名
		'Third-party software notices', // 英語の題名
		'', // 題名と説明の間の空行
		'このソフトウェアには、次のサードパーティ製ソフトウェアが含まれています。', // 何を掲載しているか
		'各ソフトウェアの著作権表示とライセンス条件を、以下に掲載します。', // 掲載している内容
		'ポータブル版の起動用 exe にも、下記の .NET ランタイムと同じライセンスのランタイムが含まれています。', // 起動用 exe の扱い
		'', // 説明と .NET の節の間の空行
		'', // 同上
		dotnetSection, // .NET ランタイムと NuGet パッケージ
		'', // .NET の節と npm の節の間の空行
		'', // 同上
		'', // 同上
		webSection // Web 画面に同梱した npm パッケージ
	].join('\n');
	// 書き出すパス。既にあれば上書きする
	const outputPath = join(publishDir, NOTICES_FILE_NAME);
	writeFileSync(outputPath, `${text.replace(/\n/g, '\r\n')}\r\n`, 'utf8');
	return outputPath;
}

/**
 * 引数を読み、発行先へライセンス表示を書く
 * 終了コード:
 * - 0: 書き出しに成功した
 * - 1: deps.json、NuGet のライセンス文、Web のライセンス表示のどれかが無い
 * - 2: --publish-dir が無い、知らない引数がある、または発行先がディレクトリでない
 * @returns {number} プロセスの終了コード
 */
function main() {
	// コマンドラインの値。知らない引数は parseArgs が例外にする
	let values;
	try {
		({ values } = parseArgs({
			// 受け付ける引数
			options: {
				// 発行先。相対パスはカレントディレクトリが基準
				'publish-dir': { type: 'string' },
				// 先頭に出すアプリの版。省略時は版を出さない
				version: { type: 'string', default: '' }
			}
		}));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}

	// 発行先の指定。無いと書き出し先が決まらない
	const publishDirArg = values['publish-dir'];
	// 発行先が無いときは使い方を出して止める
	if (!publishDirArg) {
		console.error('使い方: node scripts/generate-third-party-notices.mjs --publish-dir <発行先> [--version <版>]');
		return 2;
	}

	// 発行先の絶対パス
	const publishDir = resolve(publishDirArg);
	// 発行先がディレクトリでないときは、発行が済んでいないので止める
	if (!existsSync(publishDir) || !statSync(publishDir).isDirectory()) {
		console.error(`発行先がディレクトリではありません: ${publishDir}`);
		return 2;
	}

	try {
		// 書き出したファイルのパス
		const outputPath = writeNotices(publishDir, values.version);
		console.log(`ライセンス表示を書きました: ${outputPath}`);
		return 0;
	} catch (error) {
		// 入力の欠落は、原因のパスだけを出して終了コード 1 にする
		if (error instanceof MissingInputError) {
			console.error(error.message);
			return 1;
		}

		throw error;
	}
}

process.exitCode = main();
