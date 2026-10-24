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

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path "$PSScriptRoot\.."

if (-not $Version) {
	$propsPath = Join-Path $repoRoot 'Directory.Build.props'
	[xml]$props = Get-Content $propsPath
	$Version = $props.Project.PropertyGroup.Version
}

$tag = "v$Version"

Push-Location $repoRoot
try {
	$local = git rev-parse $tag 2>$null
	if (-not $local) {
		Write-Error "ローカルにタグ $tag がありません。Release 公開後にタグを取得したか確認してください。"
		exit 1
	}

	$remoteLine = git ls-remote origin "refs/tags/$tag"
	if (-not $remoteLine) {
		Write-Error "リモートにタグ $tag がありません。GitHub Release 公開が失敗した可能性があります。"
		exit 1
	}
	$remote = ($remoteLine -split '\s+')[0]

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
