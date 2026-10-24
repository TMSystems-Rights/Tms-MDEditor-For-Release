<#
.SYNOPSIS
    本体の発行成果物からポータブル ZIP と SHA-256 を作る

.DESCRIPTION
    完成ツリーをステージしてから ZIP を作る
    既存の発行ディレクトリは削除しない
    出力 ZIP と .sha256 は上書きする。今回作ったステージディレクトリだけ、完了後に削除する

.PARAMETER ProjectRoot
    リポジトリのルート。未指定時は、このスクリプトの親ディレクトリ

.PARAMETER Version
    成果物のバージョン。未指定または空文字のときは Directory.Build.props の Version

.PARAMETER PublishDir
    本体の発行済みディレクトリ。未指定または空文字のときは dist\publish\win-x64

.PARAMETER OutputDir
    ZIP と SHA-256 の出力先。未指定または空文字のときは dist

.PARAMETER StageDir
    ZIP 化前のステージ先。未指定または空文字のときは dist\zip-stage-portable

.PARAMETER LauncherPublishDir
    ポータブル起動用 exe の発行先。未指定または空文字のときは dist\publish-portable-launcher\win-x64

.OUTPUTS
    なし。ZIP と .sha256 を OutputDir へファイルとして書く

.EXAMPLE
    pwsh -NoProfile -File scripts/package-portable.ps1

.NOTES
    例外:
    - Directory.Build.props から Version を読めない場合は throw する
    - publish 成果物、icon.ico、portable-mode.json、README-PORTABLE.txt が無い場合は throw する
    - ステージ先または起動用の発行先が既にある場合は throw する。既存の配布物は削除しない
    - 起動用プロジェクトが無い、または発行に失敗した場合は throw する
    - 起動用 exe の表示名が TMS-MDEditor.portable でない場合は throw する
    - ZIP の構成が仕様と違う場合は throw する
#>
param(
	[string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
	[string]$Version = '',
	[string]$PublishDir = '',
	[string]$OutputDir = '',
	[string]$StageDir = '',
	[string]$LauncherPublishDir = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ----------------------------------------------
# バージョン
# ----------------------------------------------

<#
.SYNOPSIS
    Directory.Build.props から Version を読む

.DESCRIPTION
    ProjectRoot 配下の Directory.Build.props を XML として読む
    ファイルは変更しない

.PARAMETER Root
    Directory.Build.props があるリポジトリルート。相対パスの解決はしない

.OUTPUTS
    System.String
    Version 要素の文字列

.EXAMPLE
    $version = Get-ProjectVersion -Root $ProjectRoot

.NOTES
    例外:
    - Version が無い、または空白だけのときは throw する
#>
function Get-ProjectVersion {
	param([string]$Root)

	$propsPath = Join-Path $Root 'Directory.Build.props'
	[xml]$props = Get-Content -LiteralPath $propsPath
	$version = $props.Project.PropertyGroup.Version
	if ([string]::IsNullOrWhiteSpace($version)) {
		throw 'Directory.Build.props から Version を取得できません。'
	}

	return [string]$version
}

# ----------------------------------------------
# ZIP に入れないファイル
# ----------------------------------------------

<#
.SYNOPSIS
    ポータブル ZIP に含めない発行ファイルかを返す

.DESCRIPTION
    利用者データ、クラッシュダンプ、文書化用 XML を除外する
    portable-mode.json は XML でも除外しない。ファイルは変更しない

.PARAMETER RelativePath
    発行ディレクトリからの相対パス。区切りは \ でも / でもよい
    空文字は除外しない

.OUTPUTS
    System.Boolean
    除外するとき true。ZIP に含めるとき false

.EXAMPLE
    Test-ExcludedPortableSource -RelativePath 'data\session.json'
#>
function Test-ExcludedPortableSource {
	param([string]$RelativePath)

	$normalized = $RelativePath.Replace('\', '/')

	if ($normalized -eq 'data' -or $normalized.StartsWith('data/')) {
		return $true
	}

	$fileName = [System.IO.Path]::GetFileName($normalized)
	if ($fileName -eq 'createdump.exe') {
		return $true
	}

	if ($fileName.EndsWith('.xml', [StringComparison]::OrdinalIgnoreCase) -and $fileName -ne 'portable-mode.json') {
		return $true
	}

	return $false
}

<#
.SYNOPSIS
    ステージ内の相対パスを ZIP エントリ名にする

.DESCRIPTION
    区切りを / にそろえ、Prefix の下に連結する
    ファイルは変更しない

.PARAMETER Prefix
    ZIP 内の親フォルダ名。空文字にはしない

.PARAMETER RelativePath
    Prefix の下に置く相対パス。空または空白だけのときは Prefix だけを返す

.OUTPUTS
    System.String
    / 区切りのエントリ名

.EXAMPLE
    Convert-ToZipEntryName -Prefix 'TMS-MDEditor/app' -RelativePath 'icon.ico'
#>
function Convert-ToZipEntryName {
	param(
		[string]$Prefix,
		[string]$RelativePath
	)

	$normalized = $RelativePath.Replace('\', '/')

	if ([string]::IsNullOrWhiteSpace($normalized)) {
		return $Prefix
	}

	return "$Prefix/$normalized"
}

<#
.SYNOPSIS
    開いている ZIP にファイルを 1 件追加する

.DESCRIPTION
    Optimal でエントリを作り、SourcePath の内容をコピーする
    Archive は Dispose しない。既存エントリは消さない

.PARAMETER Archive
    Create モードで開いている ZipArchive

.PARAMETER EntryName
    ZIP 内のエントリ名。/ 区切り

.PARAMETER SourcePath
    読むファイルのパス

.OUTPUTS
    なし

.EXAMPLE
    Add-ZipFileEntry -Archive $archive -EntryName $entryName -SourcePath $file.FullName

.NOTES
    例外:
    - ファイルを開けない、またはコピーに失敗したときは、その例外をそのまま送出する
#>
function Add-ZipFileEntry {
	param(
		[System.IO.Compression.ZipArchive]$Archive,
		[string]$EntryName,
		[string]$SourcePath
	)

	$entry = $Archive.CreateEntry($EntryName, [System.IO.Compression.CompressionLevel]::Optimal)
	$sourceStream = [System.IO.File]::OpenRead($SourcePath)
	try {
		$entryStream = $entry.Open()
		try {
			$sourceStream.CopyTo($entryStream)
		} finally {
			$entryStream.Dispose()
		}
	} finally {
		$sourceStream.Dispose()
	}
}

# ----------------------------------------------
# 外部ツール
# ----------------------------------------------

<#
.SYNOPSIS
    Native AOT に必要な C++ リンカがあるかを返す

.DESCRIPTION
    Visual Studio の vswhere で VC Tools のインストール先を探す
    見つからなければ false を返し、発行方法の選択は呼び出し側が行う
    ファイルは変更しない

.OUTPUTS
    System.Boolean
    VC Tools があるとき true。Program Files (x86) または vswhere が無いとき false
#>
function Test-NativeAotLinker {
	$programFilesX86 = (Get-Item -LiteralPath 'Env:ProgramFiles(x86)' -ErrorAction SilentlyContinue)?.Value
	if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
		return $false
	}

	$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
	if (-not (Test-Path -LiteralPath $vswhere)) {
		return $false
	}

	$installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
	return -not [string]::IsNullOrWhiteSpace($installPath)
}

<#
.SYNOPSIS
    最初に見つかった 7z.exe のパスを返す

.DESCRIPTION
    PATH、D:\Program Files\7-Zip、Program Files の順に探す
    見つからなければ空の結果を返し、ZIP は ZipArchive で作る
    ファイルは変更しない

.OUTPUTS
    System.String
    存在する 7z.exe のパス。見つからないときは空
#>
function Get-SevenZipPath {
	$candidates = @(
		(Get-Command 7z.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
		'D:\Program Files\7-Zip\7z.exe'
	)
	foreach ($sevenZipRoot in @(
			(Get-Item -LiteralPath Env:ProgramFiles -ErrorAction SilentlyContinue)?.Value,
			(Get-Item -LiteralPath 'Env:ProgramFiles(x86)' -ErrorAction SilentlyContinue)?.Value
		)) {
		if (-not [string]::IsNullOrWhiteSpace($sevenZipRoot)) {
			$candidates += Join-Path $sevenZipRoot '7-Zip\7z.exe'
		}
	}

	return @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

# ----------------------------------------------
# 起動用 exe の発行
# ----------------------------------------------

<#
.SYNOPSIS
    ポータブル起動用 exe を発行する

.DESCRIPTION
    C++ リンカがあるときは Native AOT、無いときはトリムした単一ファイルで発行する
    OutputDir の既存ファイルは削除しない。dotnet が出力する

.PARAMETER Root
    リポジトリルート。起動用 csproj はこの直下の src を基準にする

.PARAMETER OutputDir
    起動用 exe の発行先。未作成でもよい。この関数は中身を消さない

.OUTPUTS
    なし。TmsMdEditor.Portable.exe を OutputDir へ書く

.EXAMPLE
    Publish-PortableLauncher -Root $ProjectRoot -OutputDir $launcherPublishFull

.NOTES
    例外:
    - 起動用 csproj が無いときは throw する
    - dotnet publish が失敗したときは throw する
#>
function Publish-PortableLauncher {
	param(
		[string]$Root,
		[string]$OutputDir
	)

	$projectPath = Join-Path $Root 'src\TmsMdEditor.PortableLauncher\TmsMdEditor.PortableLauncher.csproj'
	if (-not (Test-Path -LiteralPath $projectPath)) {
		throw "起動用プロジェクトがありません: $projectPath"
	}

	$publishArgs = @(
		$projectPath,
		'-c', 'Release',
		'-r', 'win-x64',
		'--self-contained', 'true',
		'-p:DebugType=None',
		'-p:DebugSymbols=false',
		'-o', $OutputDir
	)

	if (Test-NativeAotLinker) {
		Write-Host '==> publishing portable launcher (Native AOT)'
		& dotnet publish @publishArgs '-p:PublishAot=true' '-p:IlcOptimizationPreference=Size'
		if ($LASTEXITCODE -ne 0) {
			throw '起動用 exe の Native AOT 発行に失敗しました。'
		}

		return
	}

	Write-Host '==> publishing portable launcher (trimmed single-file; C++ linker not found)'
	& dotnet publish @publishArgs '-p:PublishSingleFile=true' '-p:PublishTrimmed=true' '-p:EnableCompressionInSingleFile=true'
	if ($LASTEXITCODE -ne 0) {
		throw '起動用 exe の発行に失敗しました。'
	}
}

# ----------------------------------------------
# ステージと ZIP
# ----------------------------------------------

<#
.SYNOPSIS
    本体の発行ツリーを app ディレクトリへコピーする

.DESCRIPTION
    除外対象以外のファイルを相対パスのままコピーする
    無いサブディレクトリは作る。コピー先の同名ファイルは上書きする
    発行元は削除しない

.PARAMETER PublishFull
    本体発行ディレクトリのフルパス。末尾に区切り文字は付けない

.PARAMETER AppDir
    コピー先。ZIP 内の app ディレクトリに対応する

.OUTPUTS
    なし

.EXAMPLE
    Copy-PublishTreeToAppDir -PublishFull $publishFull -AppDir $appDir

.NOTES
    例外:
    - 発行ディレクトリを読めない、またはコピーに失敗したときは、その例外をそのまま送出する
#>
function Copy-PublishTreeToAppDir {
	param(
		[string]$PublishFull,
		[string]$AppDir
	)

	$files = Get-ChildItem -LiteralPath $PublishFull -Recurse -File
	foreach ($file in $files) {
		$relative = $file.FullName.Substring($PublishFull.Length).TrimStart('\', '/')
		if (Test-ExcludedPortableSource -RelativePath $relative) {
			continue
		}

		$destination = Join-Path $AppDir $relative
		$destinationDir = Split-Path -Parent $destination
		if (-not (Test-Path -LiteralPath $destinationDir)) {
			New-Item -ItemType Directory -Path $destinationDir | Out-Null
		}

		Copy-Item -LiteralPath $file.FullName -Destination $destination
	}
}

<#
.SYNOPSIS
    ステージしたフォルダからポータブル ZIP を作る

.DESCRIPTION
    7-Zip があるときは 7-Zip、無いときは ZipArchive で ZIP を作る
    作業ファイル portable-out.zip は StageDir に作り、完成後に ZipPath へ上書きコピーする
    ステージの中身は削除しない

.PARAMETER StageDir
    ステージのルート。直下に作業 ZIP を作る

.PARAMETER LayoutFolderName
    StageDir 直下の、ZIP へ含めるフォルダ名

.PARAMETER ZipPath
    完成 ZIP の出力パス。既存ファイルは上書きする

.OUTPUTS
    なし

.EXAMPLE
    New-PortableZipFromStage -StageDir $stageFull -LayoutFolderName $zipRoot -ZipPath $zipPath

.NOTES
    例外:
    - 7-Zip が 0 以外で終わったときは throw する
    - ZIP の作成またはコピーに失敗したときは、その例外をそのまま送出する
#>
function New-PortableZipFromStage {
	param(
		[string]$StageDir,
		[string]$LayoutFolderName,
		[string]$ZipPath
	)

	$sevenZip = Get-SevenZipPath
	$builtZip = Join-Path $StageDir 'portable-out.zip'
	if (-not [string]::IsNullOrWhiteSpace($sevenZip)) {
		Write-Host "==> 7-Zip: $sevenZip"
		$previous = Get-Location
		try {
			Set-Location -LiteralPath $StageDir
			& $sevenZip a -tzip -mx=9 $builtZip $LayoutFolderName
			if ($LASTEXITCODE -ne 0) {
				throw "7-Zip による ZIP 生成に失敗しました: $LASTEXITCODE"
			}
		} finally {
			Set-Location -LiteralPath $previous.Path
		}
	} else {
		Write-Host '==> ZipArchive (7-Zip なし)'
		$layoutRoot = Join-Path $StageDir $LayoutFolderName
		$layoutFull = [System.IO.Path]::GetFullPath($layoutRoot)
		$zipStream = [System.IO.File]::Create($builtZip)
		$archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
		try {
			$files = Get-ChildItem -LiteralPath $layoutFull -Recurse -File
			foreach ($file in $files) {
				$relative = $file.FullName.Substring($layoutFull.Length).TrimStart('\', '/')
				$entryName = Convert-ToZipEntryName -Prefix $LayoutFolderName -RelativePath $relative
				Add-ZipFileEntry -Archive $archive -EntryName $entryName -SourcePath $file.FullName
			}
		} finally {
			$archive.Dispose()
			$zipStream.Dispose()
		}
	}

	Copy-Item -LiteralPath $builtZip -Destination $ZipPath -Force
}

# ----------------------------------------------
# パスの解決
# ----------------------------------------------

if ([string]::IsNullOrWhiteSpace($Version)) {
	$Version = Get-ProjectVersion -Root $ProjectRoot
}

if ([string]::IsNullOrWhiteSpace($PublishDir)) {
	$PublishDir = Join-Path $ProjectRoot 'dist\publish\win-x64'
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
	$OutputDir = Join-Path $ProjectRoot 'dist'
}

if ([string]::IsNullOrWhiteSpace($StageDir)) {
	$StageDir = Join-Path $ProjectRoot 'dist\zip-stage-portable'
}

if ([string]::IsNullOrWhiteSpace($LauncherPublishDir)) {
	$LauncherPublishDir = Join-Path $ProjectRoot 'dist\publish-portable-launcher\win-x64'
}

$publishFull = [System.IO.Path]::GetFullPath($PublishDir)
$outputFull = [System.IO.Path]::GetFullPath($OutputDir)
$stageFull = [System.IO.Path]::GetFullPath($StageDir)
$launcherPublishFull = [System.IO.Path]::GetFullPath($LauncherPublishDir)
$exePath = Join-Path $publishFull 'TmsMdEditor.exe'
$iconPath = Join-Path $publishFull 'icon.ico'
$markerSource = Join-Path $ProjectRoot 'resources\portable-mode.json'
$readmeSource = Join-Path $ProjectRoot 'resources\README-PORTABLE.txt'
$zipName = "TMS-MDEditor-$Version-portable-x64.zip"
$hashName = "$zipName.sha256"
$zipPath = Join-Path $outputFull $zipName
$hashPath = Join-Path $outputFull $hashName
$zipRoot = 'TMS-MDEditor'
$zipAppPrefix = "$zipRoot/app"
$layoutRoot = Join-Path $stageFull $zipRoot
$appDir = Join-Path $layoutRoot 'app'
$createdStage = $false

# ----------------------------------------------
# 事前確認
# ----------------------------------------------

if (-not (Test-Path -LiteralPath $exePath)) {
	throw "publish 成果物が見つかりません: $exePath`nscripts/dist.ps1 の後に実行してください。"
}

if (-not (Test-Path -LiteralPath $iconPath)) {
	throw "publish 成果物に icon.ico がありません: $iconPath"
}

if (-not (Test-Path -LiteralPath $markerSource)) {
	throw "portable-mode.json がありません: $markerSource"
}

if (-not (Test-Path -LiteralPath $readmeSource)) {
	throw "README-PORTABLE.txt がありません: $readmeSource"
}

if (Test-Path -LiteralPath $stageFull) {
	throw "ステージ先が既に存在します: $stageFull`n既存の配布成果物を保護するため、自動削除は行いません。別の -StageDir を指定してください。"
}

if (Test-Path -LiteralPath $launcherPublishFull) {
	throw "起動用発行先が既に存在します: $launcherPublishFull`n既存の配布成果物を保護するため、自動削除は行いません。別の -LauncherPublishDir を指定してください。"
}

if (-not (Test-Path -LiteralPath $outputFull)) {
	New-Item -ItemType Directory -Path $outputFull | Out-Null
}

# ----------------------------------------------
# 発行とステージ
# ----------------------------------------------

try {
	Publish-PortableLauncher -Root $ProjectRoot -OutputDir $launcherPublishFull
	$launcherExe = Join-Path $launcherPublishFull 'TmsMdEditor.Portable.exe'
	if (-not (Test-Path -LiteralPath $launcherExe)) {
		throw "起動用 exe が見つかりません: $launcherExe"
	}

	$launcherInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($launcherExe)
	$expectedDisplayName = 'TMS-MDEditor.portable'
	if ($launcherInfo.FileDescription -ne $expectedDisplayName) {
		throw "起動用 exe の FileDescription が $expectedDisplayName ではありません: $($launcherInfo.FileDescription)"
	}
	if ($launcherInfo.ProductName -ne $expectedDisplayName) {
		throw "起動用 exe の ProductName が $expectedDisplayName ではありません: $($launcherInfo.ProductName)"
	}

	New-Item -ItemType Directory -Path $appDir | Out-Null
	$createdStage = $true
	Copy-PublishTreeToAppDir -PublishFull $publishFull -AppDir $appDir
	Copy-Item -LiteralPath $markerSource -Destination (Join-Path $appDir 'portable-mode.json')
	Copy-Item -LiteralPath $readmeSource -Destination (Join-Path $layoutRoot 'README-PORTABLE.txt')
	Copy-Item -LiteralPath $launcherExe -Destination (Join-Path $layoutRoot 'TmsMdEditor.exe')

	if (-not (Test-Path -LiteralPath (Join-Path $appDir 'TmsMdEditor.exe'))) {
		throw 'ステージの app\TmsMdEditor.exe がありません。'
	}

	New-PortableZipFromStage -StageDir $stageFull -LayoutFolderName $zipRoot -ZipPath $zipPath
} finally {
	if ($createdStage -and (Test-Path -LiteralPath $stageFull)) {
		Remove-Item -LiteralPath $stageFull -Recurse -Force -ErrorAction SilentlyContinue
	}
}

# ----------------------------------------------
# ハッシュ
# ----------------------------------------------

$sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$hashLine = "$sha256  $zipName`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($hashPath, $hashLine, $utf8NoBom)

# ----------------------------------------------
# ZIP の検証
# ----------------------------------------------

$verify = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
	$names = @($verify.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })

	if ($names -notcontains "$zipRoot/TmsMdEditor.exe") {
		throw "ZIP に起動用 $zipRoot/TmsMdEditor.exe がありません。"
	}

	if ($names -notcontains "$zipAppPrefix/TmsMdEditor.exe") {
		throw "ZIP に $zipAppPrefix/TmsMdEditor.exe がありません。"
	}

	if ($names -notcontains "$zipAppPrefix/icon.ico") {
		throw "ZIP に $zipAppPrefix/icon.ico がありません。"
	}

	if ($names -notcontains "$zipAppPrefix/portable-mode.json") {
		throw "ZIP に app/portable-mode.json がありません。"
	}

	if ($names -notcontains "$zipRoot/README-PORTABLE.txt") {
		throw "ZIP に README-PORTABLE.txt がありません。"
	}

	if ($names -contains "$zipRoot/TmsMdEditor.exe.lnk" -or ($names | Where-Object { $_.EndsWith('.lnk', [StringComparison]::OrdinalIgnoreCase) })) {
		throw 'ZIP に .lnk が含まれています。起動用は stub exe にしてください。'
	}

	if ($names -contains "$zipRoot/TmsMdEditor.ico") {
		throw 'ZIP 直下に TmsMdEditor.ico があります。アイコンは app\icon.ico のみにしてください。'
	}

	if ($names | Where-Object { $_ -eq "$zipRoot/data" -or $_.StartsWith("$zipRoot/data/") -or $_ -eq "$zipAppPrefix/data" -or $_.StartsWith("$zipAppPrefix/data/") }) {
		throw 'ZIP に利用者データ data/ が含まれています。'
	}

	$rootExe = $verify.GetEntry("$zipRoot/TmsMdEditor.exe")
	$appExe = $verify.GetEntry("$zipAppPrefix/TmsMdEditor.exe")
	if ($null -eq $rootExe -or $null -eq $appExe) {
		throw 'ZIP の起動用 exe または本体 exe を読めません。'
	}

	if ($rootExe.Length -eq $appExe.Length) {
		throw '直下の TmsMdEditor.exe と app\TmsMdEditor.exe のサイズが同じです。起動用 stub と本体が入れ替わっている可能性があります。'
	}
} finally {
	$verify.Dispose()
}

Write-Host "portable zip: $zipPath"
Write-Host "sha256: $sha256"
