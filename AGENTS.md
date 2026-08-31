# リポジトリ作業ルール

## HTML/CSS のフォーマット

- `src/web/**/*.html` または `src/web/**/*.css` を編集した場合は、最終確認前に必ず `node scripts/format-web-assets.mjs` を実行する。
- JavaScript/TypeScript の自動修正と Web 層 HTML/CSS フォーマットをまとめて適用したい場合は、ルートで `npm run lint:fix` を使う。
- `npm run lint` には HTML/CSS フォーマットチェックが含まれる。

## コミットコメント

- コミットコメントは原則、日本語で記載する（技術用語は英語可）。

## GitHub Release 公開時のトークン

- AppsLauncher / GREP と同じく、`GH_TOKEN` は読み取り専用、`GITHUB_RELEASE_TOKEN` は Release 作成・asset アップロード用の読み書きトークンとして使い分ける。
- `gh release create` / `gh release upload` / `gh release view` の実行前に、`GITHUB_RELEASE_TOKEN` が設定済みであることを確認し、そのコマンドを実行するプロセス内だけ `$env:GH_TOKEN = $env:GITHUB_RELEASE_TOKEN` とする。
- 作業前の `GH_TOKEN` を保存し、Release 操作の終了時に `finally` で元の値へ復元する。元々未設定だった場合だけ `Remove-Item Env:GH_TOKEN` を使う。
- トークン値をコンソール、ログ、README、設定ファイル、コミット履歴、配布物へ出力・保存しない。

## リリース前のプロセス終了確認

- 検証後に `TmsMdEditor.exe` の残留を確認し、commit / push / dist の前に終了する。

## ビルド失敗時のプロセス処理

- `scripts/build-all.ps1` は dotnet ビルド失敗時に `TmsMdEditor` プロセス残留を確認し、存在すれば終了してから dotnet ビルドを **必ず 1 回再実行** する。
- エージェントがビルドする場合も `scripts/build-all.ps1` を使う。失敗したらプロセス終了と再ビルドはスクリプトに任せ、それでも失敗する場合のみ手動調査する。
- `dotnet build` だけを直接実行して exe ロックで失敗した場合も、`Get-Process -Name TmsMdEditor` で残留を確認し、終了後に `pwsh scripts/build-all.ps1` で再ビルドする。
