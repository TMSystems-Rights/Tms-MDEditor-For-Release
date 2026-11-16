/**
 * 本番バンドルへ実際に入った npm パッケージのライセンス文を集め、THIRD_PARTY_NOTICES.txt として出力先へ書く
 * 読むのは各パッケージ直下の package.json とライセンス系ファイルだけで、node_modules は変更しない
 * 開発サーバでは動かない。ライセンス文が見つからないパッケージはビルドを止めず、警告して package.json の宣言だけ載せる
 * @file
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** 出力先へ書くファイル名。webdist の直下に置かれる */
export const NPM_NOTICES_FILE_NAME = 'THIRD_PARTY_NOTICES.txt';

/** 各パッケージの見出しを囲む区切り線。半角 80 文字 */
const SECTION_RULE = '='.repeat(80);

/** パッケージ内で、ファイルごとの境目に置く区切り線。半角 80 文字 */
const FILE_RULE = '-'.repeat(80);

/** ライセンス系とみなすファイル名。LICENSE、LICENCE、COPYING、NOTICE と、その拡張子や接尾辞付き */
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i;

/**
 * パッケージに同梱されたライセンス系ファイル 1 件
 * 本文は改行を LF にそろえ、末尾の空白行を落とした状態で持つ
 */
export type LicenseFile = {
	/** パッケージ直下でのファイル名。大文字小文字は実ファイルのまま */
	fileName: string;
	/** ファイルの本文。LF 区切りで、末尾に改行を含まない */
	text: string;
};

/**
 * バンドルに入った npm パッケージ 1 件分の表示内容
 * 同じ名前と版が複数の場所にあっても 1 件にまとめた後の値
 */
export type BundledPackage = {
	/** package.json の name。スコープ付きなら @scope/name */
	name: string;
	/** package.json の version。無いときは空文字 */
	version: string;
	/** package.json が宣言するライセンス。SPDX 式のまま。宣言が無いときは空文字 */
	license: string;
	/** 取得元の URL。repository が無ければ homepage、どちらも無ければ空文字 */
	source: string;
	/** 同梱されたライセンス系ファイル。名前順。1 件も無いときは空配列 */
	files: LicenseFile[];
};

/**
 * Rollup のモジュール ID から、そのモジュールを含む npm パッケージのディレクトリを返す
 * 入れ子の node_modules では最も内側のパッケージを返す。仮想モジュールと node_modules 外のファイルは null
 * @param moduleId - Rollup のモジュール ID。クエリ文字列や Windows の区切りを含んでよい
 * @returns パッケージのディレクトリ。区切りは / で、node_modules/<name> または node_modules/@scope/<name> まで
 */
export function findPackageRoot(moduleId: string): string | null {
	// 先頭が NUL の ID は Vite や Rollup の仮想モジュールで、ファイルが無い
	if (moduleId.startsWith('\0')) {
		return null;
	}

	// クエリを外し、区切りを / にそろえたパス
	const path   = moduleId.split('?')[0].replaceAll('\\', '/');
	// 最も内側の node_modules の位置。-1 なら npm パッケージではない
	const marker = path.lastIndexOf('/node_modules/');
	// node_modules を通らないモジュールはアプリ自身のソースなので載せない
	if (marker < 0) {
		return null;
	}

	// node_modules 直下からの相対パス。先頭がパッケージ名
	const rest     = path.slice(marker + '/node_modules/'.length);
	// パッケージ名の部分。スコープ付きは 2 段、それ以外は 1 段
	const segments = rest.split('/');
	// スコープ付きパッケージ名を構成する段数
	const depth    = segments[0].startsWith('@') ? 2 : 1;
	// 名前の段が足りない ID はパッケージを特定できない
	if (segments.length < depth || segments.slice(0, depth).some((segment) => segment.length === 0)) {
		return null;
	}

	return `${path.slice(0, marker)}/node_modules/${segments.slice(0, depth).join('/')}`;
}

/**
 * ファイル名がライセンス系か判定する
 * @param fileName - ディレクトリを含まないファイル名
 * @returns LICENSE、LICENCE、COPYING、NOTICE で始まる名前なら true
 */
export function isLicenseFileName(fileName: string): boolean {
	return LICENSE_FILE_PATTERN.test(fileName);
}

/**
 * package.json の license 宣言を文字列にする
 * 古い形式の license オブジェクトと licenses 配列も読む
 * @param manifest - 読み込んだ package.json
 * @returns SPDX 式または型名。宣言が無いときは空文字
 */
export function describeLicense(manifest: Record<string, unknown>): string {
	// 現行の license 宣言。文字列か、古い形式の { type } オブジェクト
	const license = manifest.license;
	// SPDX 式の文字列が書かれているときは、そのまま使う
	if (typeof license === 'string') {
		return license;
	}

	// 古い形式の { type } で書かれているときは type を使う
	if (license && typeof license === 'object' && typeof (license as { type?: unknown }).type === 'string') {
		return (license as { type: string }).type;
	}

	// さらに古い licenses 配列。要素は { type } の形
	const licenses = manifest.licenses;
	// 配列で宣言されているときは、各 type を OR でつなぐ
	if (Array.isArray(licenses)) {
		return licenses
			.map((entry) => (entry && typeof entry === 'object' ? (entry as { type?: unknown }).type : undefined))
			.filter((type): type is string => typeof type === 'string')
			.join(' OR ');
	}

	return '';
}

/**
 * package.json から取得元の URL を取り出す
 * git+ と .git を外し、git:// と ssh 形式は https へ寄せる
 * @param manifest - 読み込んだ package.json
 * @returns 取得元の URL。repository も homepage も無いときは空文字
 */
export function describeSource(manifest: Record<string, unknown>): string {
	// repository 宣言。文字列か { url } オブジェクト
	const repository = manifest.repository;
	// repository の URL。どちらの形でも無ければ空文字
	const rawUrl     =
		typeof repository === 'string'
			? repository
			: repository && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string'
				? (repository as { url: string }).url
				: '';
	// repository が無いときは homepage を取得元にする
	if (rawUrl.length === 0) {
		return typeof manifest.homepage === 'string' ? manifest.homepage : '';
	}

	// github:owner/repo のような短縮形は GitHub の URL へ戻す
	if (/^github:/i.test(rawUrl)) {
		return `https://github.com/${rawUrl.replace(/^github:/i, '')}`;
	}

	// owner/repo だけの短縮形は GitHub の URL へ戻す。スキームを含む URL は対象外
	if (/^[\w.-]+\/[\w.-]+$/.test(rawUrl)) {
		return `https://github.com/${rawUrl}`;
	}

	return rawUrl
		.replace(/^git\+/, '') // npm が付ける git+ を外す
		.replace(/^git:\/\//, 'https://') // git プロトコルはブラウザで開けないので https にする
		.replace(/^ssh:\/\/git@/, 'https://') // ssh 形式も同じく https にする
		.replace(/\.git$/, ''); // 末尾の .git はリポジトリのページでは不要
}

/**
 * テキストの改行を LF にそろえ、末尾の空白行を落とす
 * @param text - ファイルから読んだ本文
 * @returns LF 区切りで末尾に改行を含まない本文
 */
function normalizeText(text: string): string {
	return text
		.replace(/^﻿/, '') // UTF-8 の BOM は本文に含めない
		.replace(/\r\n?/g, '\n') // CRLF と CR を LF にそろえる
		.replace(/\s+$/, ''); // 末尾の空白と空行を落とす
}

/**
 * パッケージ直下のライセンス系ファイルを名前順に読む
 * サブディレクトリは見ない。読めないファイルは飛ばす
 * @param packageDir - パッケージのディレクトリ
 * @returns 読めたライセンス系ファイル。無いときは空配列
 */
export function readLicenseFiles(packageDir: string): LicenseFile[] {
	// パッケージ直下のライセンス系ファイル名。名前順で、大文字小文字は区別しない
	const fileNames            = readdirSync(packageDir)
		.filter(isLicenseFileName)
		.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
	// 読めたファイルの本文。空のファイルは載せない
	const files: LicenseFile[] = [];
	for (const fileName of fileNames) {
		// ライセンス系ファイルの絶対パス
		const filePath = join(packageDir, fileName);
		// LICENSE という名前のディレクトリはファイルとして読まない
		if (!statSync(filePath).isFile()) {
			continue;
		}

		// 改行と末尾をそろえた本文。空ならこのファイルは載せない
		const text = normalizeText(readFileSync(filePath, 'utf8'));
		// 中身の無いファイルは表示しても意味が無いので飛ばす
		if (text.length === 0) {
			continue;
		}

		files.push({ fileName, text });
	}

	return files;
}

/**
 * パッケージのディレクトリから表示内容を作る
 * @param packageDir - findPackageRoot が返したディレクトリ
 * @returns 表示内容。package.json に name が無いときは null
 * @throws {Error} package.json を読めない、または JSON として壊れている
 */
export function readBundledPackage(packageDir: string): BundledPackage | null {
	// パッケージ直下の package.json。無ければ readFileSync が例外を投げる
	const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
	// name の無い package.json はパッケージとして名乗れないので載せない
	if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
		return null;
	}

	// 表示する 1 件分の内容。ライセンス文が無くても宣言だけは残す
	return {
		// 表示名。スコープ付きならスコープも含む
		name: manifest.name,
		// 版。宣言が無いパッケージは空文字
		version: typeof manifest.version === 'string' ? manifest.version : '',
		// package.json が宣言するライセンス。無ければ空文字
		license: describeLicense(manifest),
		// 取得元の URL。無ければ空文字
		source: describeSource(manifest),
		// 同梱されたライセンス文。無いときは空配列
		files: readLicenseFiles(packageDir)
	};
}

/**
 * モジュール ID の一覧から、バンドルに入った npm パッケージを名前順で集める
 * 同じ名前と版のパッケージが複数の場所にあるときは、最初に読めたものを使う
 * @param moduleIds - 出力チャンクに含まれるモジュール ID
 * @param readPackage - パッケージのディレクトリから表示内容を作る関数。テストでは差し替える
 * @returns 名前、版の順に並べたパッケージ
 */
export function collectBundledPackages(moduleIds: Iterable<string>, readPackage: (packageDir: string) => BundledPackage | null = readBundledPackage): BundledPackage[] {
	// 読んだパッケージのディレクトリ。同じディレクトリを二度読まない
	const seenDirs = new Set<string>();
	// name@version ごとの表示内容。同じ版が入れ子で重複しても 1 件にする
	const packages = new Map<string, BundledPackage>();
	for (const moduleId of moduleIds) {
		// このモジュールを含むパッケージのディレクトリ。アプリ自身と仮想モジュールは null
		const packageDir = findPackageRoot(moduleId);
		// npm パッケージでないか、読み終えたディレクトリなら次へ
		if (packageDir === null || seenDirs.has(packageDir)) {
			continue;
		}

		seenDirs.add(packageDir);
		// このディレクトリの表示内容。name の無いパッケージは null
		const bundled = readPackage(packageDir);
		// 名乗れないパッケージは載せない
		if (bundled === null) {
			continue;
		}

		// 重複を判定するキー。名前と版の組
		const key = `${bundled.name}@${bundled.version}`;
		// 同じ名前と版を先に読んでいれば、そちらを残す
		if (!packages.has(key)) {
			packages.set(key, bundled);
		}
	}

	return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
}

/**
 * パッケージの見出しに使う「名前 版」の文字列
 * @param bundled - 表示するパッケージ
 * @returns 版が無いときは名前だけ
 */
function formatTitle(bundled: BundledPackage): string {
	return bundled.version.length > 0 ? `${bundled.name} ${bundled.version}` : bundled.name;
}

/**
 * 一覧と見出しに出すライセンス宣言の文字列
 * package.json に宣言が無いパッケージでも、同梱のライセンス文が正なので、宣言が無いことだけを書く
 * @param bundled - 表示するパッケージ
 * @returns SPDX 式。宣言が無いときは「package.json に宣言なし」
 */
function formatLicense(bundled: BundledPackage): string {
	return bundled.license.length > 0 ? bundled.license : 'package.json に宣言なし';
}

/**
 * npm パッケージのライセンス表示をテキストにする
 * 先頭に一覧、続けてパッケージごとのライセンス文を並べる。改行は LF
 * @param packages - collectBundledPackages が返したパッケージ
 * @returns THIRD_PARTY_NOTICES.txt の本文。末尾は改行 1 つ
 */
export function formatNpmNotices(packages: readonly BundledPackage[]): string {
	// 出力する行。最後に LF でつなぐ
	const lines: string[] = [
		'npm パッケージ（Web 画面の JavaScript に同梱）', // この節が何を対象にしているか
		'', // 見出しと一覧の間の空行
		...packages.map((bundled) => `  - ${formatTitle(bundled)}  [${formatLicense(bundled)}]`) // 1 行 1 パッケージの一覧。SPDX 式の丸括弧と重ならないよう角括弧で囲む
	];
	for (const bundled of packages) {
		lines.push('', '', SECTION_RULE, formatTitle(bundled), SECTION_RULE);
		lines.push(`License: ${formatLicense(bundled)}`);
		// 取得元が分かるパッケージだけ、URL を載せる
		if (bundled.source.length > 0) {
			lines.push(`Source: ${bundled.source}`);
		}

		// ライセンス文が同梱されていないパッケージは、その旨だけ書く
		if (bundled.files.length === 0) {
			lines.push('', 'このパッケージにはライセンス文のファイルが同梱されていません。上記の License 宣言に従います。');
			continue;
		}

		for (const file of bundled.files) {
			lines.push('', FILE_RULE, file.fileName, FILE_RULE, '', file.text);
		}
	}

	return `${lines.join('\n')}\n`;
}

/**
 * 本番ビルドの最後に、バンドルへ入った npm パッケージのライセンス表示を出力へ加える Vite プラグイン
 * 出力チャンクに含まれるモジュールだけを対象にし、ツリーシェイクで消えたパッケージは載せない
 * ライセンス文が無いパッケージは警告を出し、ビルドは止めない
 * @returns vite.config.ts の plugins へ渡すプラグイン
 */
export function thirdPartyNoticesPlugin(): Plugin {
	// Vite へ渡すプラグイン定義。build のときだけ動く
	return {
		// 警告やエラーに出るプラグイン名
		name: 'tms-third-party-notices',
		// 開発サーバでは出力ファイルが無いので動かさない
		apply: 'build',
		/**
		 * 出力チャンクのモジュールからパッケージを集め、ライセンス表示を出力へ加える
		 * @param _options - 出力設定。使わない
		 * @param bundle - これから書き出すチャンクとアセット
		 */
		generateBundle(_options, bundle) {
			// 出力チャンクに含まれるモジュール ID。アセットはモジュールを持たない
			const moduleIds: string[] = [];
			for (const output of Object.values(bundle)) {
				// JS チャンクだけがモジュールの一覧を持つ
				if (output.type === 'chunk') {
					moduleIds.push(...Object.keys(output.modules));
				}
			}

			// バンドルに入ったパッケージ。名前順
			const packages = collectBundledPackages(moduleIds);
			for (const bundled of packages) {
				// ライセンス文が無いパッケージは、手で確認できるよう警告に出す
				if (bundled.files.length === 0) {
					this.warn(`${formatTitle(bundled)} にライセンス文のファイルがありません。package.json の宣言（${bundled.license || 'なし'}）だけを載せます`);
				}
			}

			this.emitFile({
				// 加工せずに書くアセット
				type: 'asset',
				// ハッシュを付けない固定名。発行時のスクリプトがこの名前で読む
				fileName: NPM_NOTICES_FILE_NAME,
				// 表示する本文
				source: formatNpmNotices(packages)
			});
		}
	};
}
