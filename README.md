# TMS-MDEditor

Windows 11 向けの軽量 Markdown エディタ。C# / .NET 8 / WinForms + WebView2 + CodeMirror 6 で構築しています。

リポジトリ: [TMSystems-Rights/Tms-MDEditor-For-Release](https://github.com/TMSystems-Rights/Tms-MDEditor-For-Release)

最新リリース: [v1.3.2](https://github.com/TMSystems-Rights/Tms-MDEditor-For-Release/releases/tag/v1.3.2)

## v1.3.2 の主な変更

- すでに開いているタブでも、最近使ったファイル・タブ切替・`Ctrl+Tab` で表示したファイルを MRU の先頭へ移す

## v1.3.1 の主な変更

- ポータブル ZIP の既定アプリ表示名を `TMS-MDEditor.portable` にする（インストーラ版は `TMS-MDEditor`）
- ポータブル ZIP でファイルをダブルクリックしたときに、そのファイルを開く

## v1.3.0 の主な変更

- タブバーの空白をダブルクリックすると無題の新規タブを開く（サクラエディタ準拠）

## v1.2.0 の主な変更

- 設定 > 外観にコードブロックフォントを追加（フェンス付きコードブロック・インラインコード、HTML / PDF エクスポート）

## v1.1.0 の主な変更

- インストール不要のポータブル ZIP 版
- 開発ポータル URL を環境変数 `TMS_PORTAL_DEVELOPMENT_URL` へ移し、ソースから開発用ホスト名を外す

## v1.0.0 の主な機能

- ソースモードと Obsidian 準拠のライブプレビュー
- タブ、再帰的なペイン分割、ウィンドウ間移動
- アウトライン（見出し一覧、左右配置、ツリー開閉）
- カスタム装飾ルールと CSS スニペット
- HTML / PDF エクスポートと印刷
- `.md` / `.mdc` のファイル関連付け
- GitHub Releases からの自動更新（公開リポジトリのためトークン不要）

## 必要条件

- Windows 11（64bit）
- 開発時: .NET 8 SDK、Node.js 20 以上、Inno Setup 6（インストーラ生成時）

## セットアップ

```powershell
npm install
npm install --prefix src/web
```

## 開発起動

```powershell
pwsh scripts/build-all.ps1
dotnet run --project src/TmsMdEditor/TmsMdEditor.csproj

# 別プロセス起動（ターミナルを占有しない）
pwsh scripts/run-app.ps1
pwsh scripts/run-app.ps1 -Build

# 起動引数でファイルを開く
dotnet run --project src/TmsMdEditor/TmsMdEditor.csproj -- "C:\path\to\file.md"
```

開発時の設定は `%APPDATA%\tms-mdeditor-dev\` に保存されます（インストール版とは別です）。

## ビルド

Web 層と C# をまとめてビルドします。

```powershell
pwsh scripts/build-all.ps1
pwsh scripts/build-all.ps1 -Configuration Release
```

## Lint

```powershell
npm run lint
npm run lint:fix
```

`npm run lint` は ESLint に加えて、Web 層の HTML/CSS が所定フォーマット済みかも検査します。

AI（Cursor 等）が `src/web/**/*.html` または `src/web/**/*.css` を編集した場合は、次のどちらかで整形してください。

```powershell
node scripts/format-web-assets.mjs
# または JS の自動修正もまとめて行う場合:
npm run lint:fix
```

## テスト

```powershell
npm run test
```

C#（xUnit）と Web 層（Vitest）を実行します。

## 配布パッケージ作成（Windows インストーラ / ポータブル ZIP）

```powershell
pwsh scripts/dist.ps1
```

既存の publish 成果物は自動削除しません。再実行時は別の `-PublishDir` を指定してください。

出力先:

- インストーラ: `dist/TMS-MDEditor-<version>-setup.exe`
- ポータブル ZIP: `dist/TMS-MDEditor-<version>-portable-x64.zip`
- ZIP の SHA-256: `dist/TMS-MDEditor-<version>-portable-x64.zip.sha256`

`scripts/dist.ps1` は Release ビルド、`win-x64` self-contained + ReadyToRun publish、Inno Setup によるインストーラ生成、続けて `scripts/package-portable.ps1` によるポータブル ZIP 生成を一括実行します。publish 済みなら ZIP だけ作り直せます。

```powershell
pwsh scripts/package-portable.ps1
```

ポータブル ZIP は親フォルダ `TMS-MDEditor/` 直下に起動用 `TmsMdEditor.exe` と `README-PORTABLE.txt` を置き、本体（`app/TmsMdEditor.exe` と `portable-mode.json`）は `app/` に入れます。`app/portable-mode.json` を削除するとインストーラ版として `%APPDATA%` へ書き込みます。

### リリース手順

GitHub Release 公開は、必ず **コミットと push の後**に実行します。

AI（Cursor 等）がリリース作業を行う場合は、`.cursor/rules/release_workflow.mdc` も必ず参照すること。

#### バージョンアップして配布する場合（必須順序）

1. `Directory.Build.props` の `<Version>` を更新する
2. 動作確認する
3. `pwsh scripts/build-all.ps1 -Configuration Release` / `npm run lint` / `npm run test` で検証する
4. テスト・動作確認で起動した `TmsMdEditor.exe` が残っていないことを確認する
5. 変更を **git commit** する（バージョン更新を含むすべての変更）
6. **git push origin main** する
7. `git status` が clean で、`HEAD` と `origin/main` が一致していることを確認する
8. **`pwsh scripts/dist.ps1`** でインストーラとポータブル ZIP を生成する
9. GitHub Release にインストーラとポータブル ZIP（および ZIP の SHA-256）を公開する
10. `scripts/verify-release-tag.ps1` でタグ一致を確認する

> **重要**: `scripts/dist.ps1` は **commit と push の後**に実行すること。未コミットの作業ツリーからビルドすると、インストーラは新内容でも Git タグが古いコミットを指し、ソースと Release の対応がずれる。

#### dist 前の確認

- `git status` が clean（未コミットの version 変更がない）
- `git rev-parse HEAD` と `git rev-parse origin/main` が一致している
- テスト・動作確認で起動した `TmsMdEditor.exe` が残っていない
- **コミット済み**の `Directory.Build.props` の `<Version>` が今回のリリース番号と一致している

#### テスト後のプロセス終了確認

```powershell
Get-Process -Name TmsMdEditor -ErrorAction SilentlyContinue
```

結果が出た場合は、まず該当ウィンドウを閉じます。閉じられない場合のみ、対象 PID を確認してから `Stop-Process -Id <PID>` で終了します。

#### GitHub Release 公開

`gh` で Release に成果物をアップロードします。公開リポジトリでは自動更新用の GitHub Release 取得にトークンは不要です。

AppsLauncher / GREP と同じく、通常の `GH_TOKEN` は読み取り専用、`GITHUB_RELEASE_TOKEN` は Release 作成・asset アップロード用の読み書きトークンとして使い分けます。Release 操作中だけ `GITHUB_RELEASE_TOKEN` を `GH_TOKEN` に割り当て、処理後は必ず元の値へ復元します。

```powershell
$props = [xml](Get-Content Directory.Build.props)
$version = $props.Project.PropertyGroup.Version
$tag = "v$version"
$repo = "TMSystems-Rights/Tms-MDEditor-For-Release"
$installer = "dist\TMS-MDEditor-$version-setup.exe"
$portable = "dist\TMS-MDEditor-$version-portable-x64.zip"
$portableHashFile = "$portable.sha256"
$target = git rev-parse HEAD
$originalGhToken = $env:GH_TOKEN
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
$portableHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $portable).Hash.ToLowerInvariant()

try {
	if ([string]::IsNullOrWhiteSpace($env:GITHUB_RELEASE_TOKEN)) {
		throw "GITHUB_RELEASE_TOKEN が設定されていません。"
	}

	$env:GH_TOKEN = $env:GITHUB_RELEASE_TOKEN
	gh auth status --hostname github.com
	if ($LASTEXITCODE -ne 0) { throw "GitHub CLI の認証確認に失敗しました。" }

	gh release view $tag --repo $repo *> $null
	if ($LASTEXITCODE -eq 0) {
		gh release upload $tag $installer $portable $portableHashFile --repo $repo --clobber
	} else {
		gh release create $tag $installer $portable $portableHashFile `
			--repo $repo `
			--target $target `
			--title $tag `
			--notes "TMS-MDEditor $tag`n`nInstaller SHA-256: ``$hash``nPortable ZIP SHA-256: ``$portableHash``"
	}
	if ($LASTEXITCODE -ne 0) { throw "GitHub Release の作成または更新に失敗しました。" }

	gh release view $tag --repo $repo --json assets,url,tagName
} finally {
	if ($null -eq $originalGhToken) {
		Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
	} else {
		$env:GH_TOKEN = $originalGhToken
	}
}
```

#### 公開後の確認（必須）

```powershell
git fetch origin tag v<version>
pwsh -NoProfile -File scripts/verify-release-tag.ps1
```

#### バージョンを上げない軽微な修正

README 等の変更で、既存ユーザーに新インストーラを配布する必要がない場合は Release 公開は不要です。**git commit → git push** だけでよい。

### 自動更新

インストーラ版は起動時に公開 GitHub Releases を確認し、新しい版があれば Toast で通知します。メニュー「ヘルプ > 更新を確認」から手動確認もできます。公開リポジトリのため、利用者が `GH_TOKEN` を設定する必要はありません。

ダウンロード後、「今すぐ更新」を選ぶとアプリを終了してインストーラを起動します。サイレントインストールは行いません。

ポータブル ZIP 版はインストーラをダウンロードしません。新しい版があれば公式ページへ案内します。更新はアプリを終了し、新しい ZIP を別フォルダへ展開して、旧版の `data` をコピーします。

### インストーラの仕様

| 項目           | 内容                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| 形式           | Inno Setup（`.exe`）                                                                         |
| インストール先 | 現在ユーザー: `%LOCALAPPDATA%\Programs\TMS-MDEditor` / 全ユーザー: `C:\Program Files\TMS-MDEditor` |
| ショートカット | スタートメニュー（常時）、デスクトップ（既定 ON）                                            |
| 関連付け       | `.md` / `.mdc` を個別に選択可能（既定 ON）                                                   |
| 対象           | Windows 11 64bit                                                                             |

インストール後、データは `%APPDATA%\tms-mdeditor\` に保存されます（開発版の `tms-mdeditor-dev` とは別です）。初回インストールではデータ保存先を指定でき、未指定時の既定値は `%APPDATA%\tms-mdeditor\data` です。

### ポータブル ZIP の仕様

| 項目     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 判定     | `app\TmsMdEditor.exe` と同じフォルダの `portable-mode.json`（削除禁止） |
| 起動     | 展開フォルダ直下の `TmsMdEditor.exe`（起動用 stub。本体は `app\TmsMdEditor.exe`。起動引数は本体へ転送する） |
| 表示名   | Windows の既定アプリ表示は `TMS-MDEditor.portable`（インストーラ版は `TMS-MDEditor`） |
| 保存先   | `<exeDir>\data`（通常は `app\data`。`%APPDATA%` へは書かない）        |
| 更新     | 公式ページへ誘導。自動ダウンロードしない                             |
| 関連付け | 登録しない。手動で既定アプリにする場合は直下の `TmsMdEditor.exe` を選ぶ |

`portable-mode.json` を削除するとインストーラ版として `%APPDATA%\tms-mdeditor` へ書きます。

## プロジェクト構成

```text
src/TmsMdEditor/                   … C# シェル（WinForms + WebView2）
src/TmsMdEditor.PortableLauncher/  … ポータブル ZIP 直下の起動用 stub
src/web/                           … Web 層（TypeScript + Vite）
tests/             … xUnit
scripts/           … ビルド・検証スクリプト
installer/         … Inno Setup スクリプト
css_snipets_sample/                … CSSスニペットの参考例（アプリ本体には同梱しません）
```

CSSスニペットの書き方の例は `css_snipets_sample/sample.css` を参照してください。`dataDir` の `snippets` フォルダへコピーし、設定画面で有効にして再読み込みします。

## データ保存先

| 種別                 | パス                                         |
| -------------------- | -------------------------------------------- |
| ブートストラップ設定 | `%APPDATA%\tms-mdeditor\app-config.json`     |
| 実データ             | `<dataDir>\config.json` など                 |
| ログ                 | `%APPDATA%\tms-mdeditor\logs\`               |

開発時は `%APPDATA%\tms-mdeditor-dev\` を使用します。既定の `dataDir` は `userData\data` です。ポータブル版は `<exeDir>\data` に平坦化し、ログと WebView2 もその配下へ置きます。

## 仕様書

`設計ドキュメント/0080_マークダウンエディタ（TMS-MDEditor）/020_仕様書/マークダウンエディタ（TMS-MDEditor）仕様書.md`

## ライセンス

UNLICENSED（現時点では利用許諾なし）

このリポジトリのソースコードには、現時点でオープンソースライセンスを付与していません。
