# Release 公開後に、ローカルとリモートのリリースタグが一致しているか検証する。
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
}
finally {
	Pop-Location
}
