<#
.SYNOPSIS
    ローカルとリモートのリリースタグが同じコミットを指すか検証する

.DESCRIPTION
    v<Version> のローカル SHA と origin のタグ SHA を比べる
    タグの作成や上書きはしない

.PARAMETER Version
    検証する版。未指定時は Directory.Build.props の Version。先頭の v は付けない

.OUTPUTS
    なし。一致したときは終了コード 0 で SHA を表示する

.EXAMPLE
    pwsh -NoProfile -File scripts/verify-release-tag.ps1 -Version 1.7.2

.NOTES
    例外:
    - ローカルまたはリモートにタグが無いとき、または SHA が違うときは Write-Error のあと終了コード 1 で終了する
#>
param(
	[string]$Version
)

# コマンドレットの失敗を停止例外にする。タグの欠落は Write-Error のあと終了コード 1
$ErrorActionPreference = 'Stop'
# このスクリプトの親。Directory.Build.props を読む基準
$repoRoot = Resolve-Path "$PSScriptRoot\.."

# 版の指定が空のときだけ props から読む。指定済みなら上書きしない
if (-not $Version) {
	# Version 要素がある props。リポジトリルート直下
	$propsPath = Join-Path $repoRoot 'Directory.Build.props'
	# Version を読む XML。ファイルは変更しない
	[xml]$props = Get-Content $propsPath
	# タグの v を除いた版。要素が空なら後続のタグ名が v だけになる
	$Version = $props.Project.PropertyGroup.Version
}

# 照合するタグ。版の先頭に v を付ける
$tag = "v$Version"

Push-Location $repoRoot
try {
	# ローカルタグが指すコミット。タグが無いときは空で、比較しない
	$local = git rev-parse $tag 2>$null
	# ローカルにタグが無いときはリモートを見ず 1 で終わる
	if (-not $local) {
		Write-Error "ローカルにタグ $tag がありません。Release 公開後にタグを取得したか確認してください。"
		exit 1
	}

	# origin のタグ行。無いときは空
	$remoteLine = git ls-remote origin "refs/tags/$tag"
	# リモートにタグが無いときは SHA を比べず 1 で終わる
	if (-not $remoteLine) {
		Write-Error "リモートにタグ $tag がありません。GitHub Release 公開が失敗した可能性があります。"
		exit 1
	}
	# リモートタグの SHA。行の先頭フィールド。空行ではここまで来ない
	$remote = ($remoteLine -split '\s+')[0]

	# 両方のタグがあるときだけ不一致を見る。どちらか欠ける場合は上の分岐で終わっている
	if ($local -ne $remote) {
		Write-Error @"
タグ $tag がローカルとリモートで不一致です。
  ローカル: $local
  リモート: $remote
"@
		exit 1
	}

	Write-Host "OK: $tag -> $local"
	Write-Host 'OK: ローカルとリモートのタグ SHA が一致しています。'
	exit 0
} finally {
	Pop-Location
}
