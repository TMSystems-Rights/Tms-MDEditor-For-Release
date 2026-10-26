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

# コマンドレットの失敗を停止例外にする。存在確認の失敗は throw で止める
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

	# Directory.Build.props のパス。Root からの相対は結合しない
	$propsPath = Join-Path $Root 'Directory.Build.props'
	# Version を読む XML。ファイルは書き換えない
	[xml]$props = Get-Content -LiteralPath $propsPath
	# 成果物名に使う版。空白だけなら下で止める
	$version = $props.Project.PropertyGroup.Version
	# 版が空だと ZIP 名が決まらないので、ここで止める
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

	# 比較用に区切りを / にした相対パス。空のままでは除外しない
	$normalized = $RelativePath.Replace('\', '/')

	# 利用者データそのものと配下を ZIP に入れない。ファイル名だけの一致では除外しない
	if ($normalized -eq 'data' -or $normalized.StartsWith('data/')) {
		return $true
	}

	# パス末尾の名前。ディレクトリ部分ではダンプを判定しない
	$fileName = [System.IO.Path]::GetFileName($normalized)
	# クラッシュ時のダンプ採取用なので、配布物に含めない
	if ($fileName -eq 'createdump.exe') {
		return $true
	}

	# 文書化用の XML だけ除外する。portable-mode.json は拡張子が xml でも残す。一方だけでは除外しない
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

	# 区切りを / にした相対パス。空なら親フォルダ名だけを返す
	$normalized = $RelativePath.Replace('\', '/')

	# 相対パスが空のときは親フォルダ名だけにする。空のエントリ名にしない
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

	# Optimal で追加したエントリ。同名の既存エントリは消さない
	$entry = $Archive.CreateEntry($EntryName, [System.IO.Compression.CompressionLevel]::Optimal)
	# 読む側。finally で閉じる
	$sourceStream = [System.IO.File]::OpenRead($SourcePath)
	try {
		# エントリへ書く側。コピー後に閉じる
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
	# 32bit 側の Program Files。環境変数が無いときは空で、vswhere を探さない
	$programFilesX86 = (Get-Item -LiteralPath 'Env:ProgramFiles(x86)' -ErrorAction SilentlyContinue)?.Value
	# 環境変数が無い環境ではリンカ無しとする。PATH にはフォールバックしない
	if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
		return $false
	}

	# Visual Studio Installer の vswhere。Program Files (x86) 基準
	$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
	# インストーラが無いときは VC Tools を問い合わせない
	if (-not (Test-Path -LiteralPath $vswhere)) {
		return $false
	}

	# VC Tools のインストール先。要件を満たす製品が無いときは空
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
	# 探す順の候補。PATH、固定パス、その後 Program Files
	$candidates = @(
		(Get-Command 7z.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
		'D:\Program Files\7-Zip\7z.exe'
	)
	foreach ($sevenZipRoot in @(
			(Get-Item -LiteralPath Env:ProgramFiles -ErrorAction SilentlyContinue)?.Value,
			(Get-Item -LiteralPath 'Env:ProgramFiles(x86)' -ErrorAction SilentlyContinue)?.Value
		)) {
		# 環境変数が空のルートは候補に足さない
		if (-not [string]::IsNullOrWhiteSpace($sevenZipRoot)) {
			# Program Files 配下の 7-Zip。実在確認は戻り値の絞り込みで行う
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

	# 起動用 csproj。Root の src 直下を基準にし、相対のままでは発行しない
	$projectPath = Join-Path $Root 'src\TmsMdEditor.PortableLauncher\TmsMdEditor.PortableLauncher.csproj'
	# プロジェクトが無いときは発行方法を選ばず止める。OutputDir は作らない
	if (-not (Test-Path -LiteralPath $projectPath)) {
		throw "起動用プロジェクトがありません: $projectPath"
	}

	# AOT と単一ファイルで共有する publish 引数。出力先の中身は消さない
	$publishArgs = @(
		$projectPath,
		'-c', 'Release',
		'-r', 'win-x64',
		'--self-contained', 'true',
		'-p:DebugType=None',
		'-p:DebugSymbols=false',
		'-o', $OutputDir
	)

	# リンカがあるときだけ Native AOT。無いときは下の単一ファイルへ落とす
	if (Test-NativeAotLinker) {
		Write-Host '==> publishing portable launcher (Native AOT)'
		& dotnet publish @publishArgs '-p:PublishAot=true' '-p:IlcOptimizationPreference=Size'
		# AOT の失敗は ZIP を作らず止める。発行先に残ったファイルは消さない
		if ($LASTEXITCODE -ne 0) {
			throw '起動用 exe の Native AOT 発行に失敗しました。'
		}

		return
	}

	Write-Host '==> publishing portable launcher (trimmed single-file; C++ linker not found)'
	& dotnet publish @publishArgs '-p:PublishSingleFile=true' '-p:PublishTrimmed=true' '-p:EnableCompressionInSingleFile=true'
	# 単一ファイル発行の失敗も止める。AOT へは戻らない
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

	# 発行ツリーのファイルだけ。ディレクトリエントリはコピーしない
	$files = Get-ChildItem -LiteralPath $PublishFull -Recurse -File
	foreach ($file in $files) {
		# 発行ディレクトリからの相対パス。先頭の区切りは外す
		$relative = $file.FullName.Substring($PublishFull.Length).TrimStart('\', '/')
		# 利用者データ、ダンプ、文書 XML はステージへ置かない
		if (Test-ExcludedPortableSource -RelativePath $relative) {
			continue
		}

		# ステージ側のコピー先。相対構造は保つ
		$destination = Join-Path $AppDir $relative
		# コピー先の親。ファイルが直下なら AppDir 自身
		$destinationDir = Split-Path -Parent $destination
		# 親が無いときだけ作る。あるときは作り直さない
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

	# 最初に見つかった 7z。空なら ZipArchive で作る
	$sevenZip = Get-SevenZipPath
	# ステージ内の作業 ZIP。完成後に ZipPath へ上書きコピーする
	$builtZip = Join-Path $StageDir 'portable-out.zip'
	# 7-Zip があるときだけ外部圧縮。無いときは .NET の ZipArchive
	if (-not [string]::IsNullOrWhiteSpace($sevenZip)) {
		Write-Host "==> 7-Zip: $sevenZip"
		# 作業ディレクトリを戻すための現在位置
		$previous = Get-Location
		try {
			Set-Location -LiteralPath $StageDir
			& $sevenZip a -tzip -mx=9 $builtZip $LayoutFolderName
			# 7-Zip が 0 以外なら作業 ZIP を完成扱いにしない
			if ($LASTEXITCODE -ne 0) {
				throw "7-Zip による ZIP 生成に失敗しました: $LASTEXITCODE"
			}
		} finally {
			Set-Location -LiteralPath $previous.Path
		}
	} else {
		Write-Host '==> ZipArchive (7-Zip なし)'
		# ZIP に含めるフォルダ
		$layoutRoot = Join-Path $StageDir $LayoutFolderName
		# 相対パス算出の基準にするフルパス
		$layoutFull = [System.IO.Path]::GetFullPath($layoutRoot)
		# 作業 ZIP の新規ストリーム。finally で閉じる
		$zipStream = [System.IO.File]::Create($builtZip)
		# Create モード。既存の ZIP は開かない
		$archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
		try {
			# レイアウト配下のファイル。ディレクトリはエントリにしない
			$files = Get-ChildItem -LiteralPath $layoutFull -Recurse -File
			foreach ($file in $files) {
				# レイアウトフォルダからの相対パス。先頭の区切りは外す
				$relative = $file.FullName.Substring($layoutFull.Length).TrimStart('\', '/')
				# レイアウトフォルダ名を親にしたエントリ名
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

# 版が空のときだけ props から読む。指定済みなら上書きしない
if ([string]::IsNullOrWhiteSpace($Version)) {
	$Version = Get-ProjectVersion -Root $ProjectRoot
}

# 発行先が空のときだけ既定の dist 配下にする
if ([string]::IsNullOrWhiteSpace($PublishDir)) {
	$PublishDir = Join-Path $ProjectRoot 'dist\publish\win-x64'
}

# ZIP の出力先が空のときだけ dist にする
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
	$OutputDir = Join-Path $ProjectRoot 'dist'
}

# ステージ先が空のときだけ既定にする。指定済みの既存ディレクトリは消さない
if ([string]::IsNullOrWhiteSpace($StageDir)) {
	$StageDir = Join-Path $ProjectRoot 'dist\zip-stage-portable'
}

# 起動用発行先が空のときだけ既定にする
if ([string]::IsNullOrWhiteSpace($LauncherPublishDir)) {
	$LauncherPublishDir = Join-Path $ProjectRoot 'dist\publish-portable-launcher\win-x64'
}

# 本体発行ディレクトリのフルパス。相対のままコピーしない
$publishFull = [System.IO.Path]::GetFullPath($PublishDir)
# ZIP と SHA-256 を書くディレクトリ
$outputFull = [System.IO.Path]::GetFullPath($OutputDir)
# 今回だけ作るステージ。完了後に消す対象
$stageFull = [System.IO.Path]::GetFullPath($StageDir)
# 起動用 exe の発行先。既存なら後で止める
$launcherPublishFull = [System.IO.Path]::GetFullPath($LauncherPublishDir)
# 配布に必須の本体 exe。無いときは ZIP を作らない
$exePath = Join-Path $publishFull 'TmsMdEditor.exe'
# 発行物に同梱されるアイコン。無いときは止める
$iconPath = Join-Path $publishFull 'icon.ico'
# ポータブル動作の印。リポジトリの resources からステージへコピーする
$markerSource = Join-Path $ProjectRoot 'resources\portable-mode.json'
# ZIP 直下に置く説明。発行物の中には無い
$readmeSource = Join-Path $ProjectRoot 'resources\README-PORTABLE.txt'
# 出力 ZIP のファイル名。版を含む
$zipName = "TMS-MDEditor-$Version-portable-x64.zip"
# SHA-256 ファイル名。ZIP 名に .sha256 を足す
$hashName = "$zipName.sha256"
# 完成 ZIP のパス。既存ファイルは上書きする
$zipPath = Join-Path $outputFull $zipName
# ハッシュファイルのパス。ZIP と同じディレクトリ
$hashPath = Join-Path $outputFull $hashName
# ZIP 内のルートフォルダ名
$zipRoot = 'TMS-MDEditor'
# 本体を置く ZIP 内プレフィックス。起動用 exe とは別
$zipAppPrefix = "$zipRoot/app"
# ステージ上のルートフォルダ
$layoutRoot = Join-Path $stageFull $zipRoot
# 本体ツリーのコピー先。ZIP 内の app に対応する
$appDir = Join-Path $layoutRoot 'app'
# 今回ステージを作ったか。false のまま失敗したときは既存ディレクトリを消さない
$createdStage = $false

# ----------------------------------------------
# 事前確認
# ----------------------------------------------

# 本体 exe が無いときはステージを作らず止める
if (-not (Test-Path -LiteralPath $exePath)) {
	throw "publish 成果物が見つかりません: $exePath`nscripts/dist.ps1 の後に実行してください。"
}

# アイコンが無い発行物は ZIP にしない
if (-not (Test-Path -LiteralPath $iconPath)) {
	throw "publish 成果物に icon.ico がありません: $iconPath"
}

# ポータブル印がリポジトリに無いときは止める
if (-not (Test-Path -LiteralPath $markerSource)) {
	throw "portable-mode.json がありません: $markerSource"
}

# 説明文が無いときは ZIP を作らない
if (-not (Test-Path -LiteralPath $readmeSource)) {
	throw "README-PORTABLE.txt がありません: $readmeSource"
}

# ステージ先が既にあるときは消さず止める。別の -StageDir で再実行する
if (Test-Path -LiteralPath $stageFull) {
	throw "ステージ先が既に存在します: $stageFull`n既存の配布成果物を保護するため、自動削除は行いません。別の -StageDir を指定してください。"
}

# 起動用発行先が既にあるときは消さず止める
if (Test-Path -LiteralPath $launcherPublishFull) {
	throw "起動用発行先が既に存在します: $launcherPublishFull`n既存の配布成果物を保護するため、自動削除は行いません。別の -LauncherPublishDir を指定してください。"
}

# 出力先ディレクトリが無いときだけ作る。ZIP 自体は後で上書きする
if (-not (Test-Path -LiteralPath $outputFull)) {
	New-Item -ItemType Directory -Path $outputFull | Out-Null
}

# ----------------------------------------------
# 発行とステージ
# ----------------------------------------------

try {
	Publish-PortableLauncher -Root $ProjectRoot -OutputDir $launcherPublishFull
	# 発行された起動用 exe。本体の TmsMdEditor.exe とは別ファイル
	$launcherExe = Join-Path $launcherPublishFull 'TmsMdEditor.Portable.exe'
	# 発行が成功扱いになっても exe が無いときはステージへ進まない
	if (-not (Test-Path -LiteralPath $launcherExe)) {
		throw "起動用 exe が見つかりません: $launcherExe"
	}

	# バージョン情報。表示名が stub であることを確認する
	$launcherInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($launcherExe)
	# 起動用と本体を区別する表示名。一致しない exe は ZIP に入れない
	$expectedDisplayName = 'TMS-MDEditor.portable'
	# ファイルの説明が stub でないときは、本体と取り違えている
	if ($launcherInfo.FileDescription -ne $expectedDisplayName) {
		throw "起動用 exe の FileDescription が $expectedDisplayName ではありません: $($launcherInfo.FileDescription)"
	}
	# 製品名も同じ表示名であるときだけ続ける。説明だけ一致しても不十分
	if ($launcherInfo.ProductName -ne $expectedDisplayName) {
		throw "起動用 exe の ProductName が $expectedDisplayName ではありません: $($launcherInfo.ProductName)"
	}

	New-Item -ItemType Directory -Path $appDir | Out-Null
	# ステージを作った印。finally がこのディレクトリだけを消す
	$createdStage = $true
	Copy-PublishTreeToAppDir -PublishFull $publishFull -AppDir $appDir
	Copy-Item -LiteralPath $markerSource -Destination (Join-Path $appDir 'portable-mode.json')
	Copy-Item -LiteralPath $readmeSource -Destination (Join-Path $layoutRoot 'README-PORTABLE.txt')
	Copy-Item -LiteralPath $launcherExe -Destination (Join-Path $layoutRoot 'TmsMdEditor.exe')

	# 本体 exe が app に無いときは ZIP を作らない。起動用だけが直下に残る構成を避ける
	if (-not (Test-Path -LiteralPath (Join-Path $appDir 'TmsMdEditor.exe'))) {
		throw 'ステージの app\TmsMdEditor.exe がありません。'
	}

	New-PortableZipFromStage -StageDir $stageFull -LayoutFolderName $zipRoot -ZipPath $zipPath
} finally {
	# 今回作ったステージが残っているときだけ消す。どちらか一方では既存の配布物を消さない
	if ($createdStage -and (Test-Path -LiteralPath $stageFull)) {
		Remove-Item -LiteralPath $stageFull -Recurse -Force -ErrorAction SilentlyContinue
	}
}

# ----------------------------------------------
# ハッシュ
# ----------------------------------------------

# ZIP の SHA-256。比較しやすいよう小文字にする
$sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
# ハッシュ、空白 2 つ、ファイル名、改行。sha256sum の並び
$hashLine = "$sha256  $zipName`n"
# BOM 無し UTF-8。先頭に BOM があるとハッシュ照合がずれる
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($hashPath, $hashLine, $utf8NoBom)

# ----------------------------------------------
# ZIP の検証
# ----------------------------------------------

# 検証のため開いた ZIP。finally で閉じる
$verify = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
	# エントリ名。区切りを / にそろえる。空アーカイブなら空配列
	$names = @($verify.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })

	# 直下の起動用 exe が無い ZIP は配布しない
	if ($names -notcontains "$zipRoot/TmsMdEditor.exe") {
		throw "ZIP に起動用 $zipRoot/TmsMdEditor.exe がありません。"
	}

	# app 配下の本体 exe が無いときは、起動用だけが残っている
	if ($names -notcontains "$zipAppPrefix/TmsMdEditor.exe") {
		throw "ZIP に $zipAppPrefix/TmsMdEditor.exe がありません。"
	}

	# アイコンが app に無いときはショートカットの資源が欠ける
	if ($names -notcontains "$zipAppPrefix/icon.ico") {
		throw "ZIP に $zipAppPrefix/icon.ico がありません。"
	}

	# ポータブル印が無いと、インストール版と同じデータ場所を見てしまう
	if ($names -notcontains "$zipAppPrefix/portable-mode.json") {
		throw "ZIP に app/portable-mode.json がありません。"
	}

	# 説明文が直下に無い ZIP は仕様と違う
	if ($names -notcontains "$zipRoot/README-PORTABLE.txt") {
		throw "ZIP に README-PORTABLE.txt がありません。"
	}

	# 直下の lnk か、どこかのショートカットがあるときは stub exe になっていない。どちらか一方でも配布しない
	if ($names -contains "$zipRoot/TmsMdEditor.exe.lnk" -or ($names | Where-Object { $_.EndsWith('.lnk', [StringComparison]::OrdinalIgnoreCase) })) {
		throw 'ZIP に .lnk が含まれています。起動用は stub exe にしてください。'
	}

	# アイコンが直下にあるときは、app だけに置く仕様と違う
	if ($names -contains "$zipRoot/TmsMdEditor.ico") {
		throw 'ZIP 直下に TmsMdEditor.ico があります。アイコンは app\icon.ico のみにしてください。'
	}

	# 利用者データがルートか app にあるときは、除外が漏れている
	if ($names | Where-Object { $_ -eq "$zipRoot/data" -or $_.StartsWith("$zipRoot/data/") -or $_ -eq "$zipAppPrefix/data" -or $_.StartsWith("$zipAppPrefix/data/") }) {
		throw 'ZIP に利用者データ data/ が含まれています。'
	}

	# 直下の起動用エントリ。名前一覧にあっても読めないことがある
	$rootExe = $verify.GetEntry("$zipRoot/TmsMdEditor.exe")
	# app 配下の本体エントリ。サイズ比較に使う
	$appExe = $verify.GetEntry("$zipAppPrefix/TmsMdEditor.exe")
	# どちらかを読めないときはサイズ比較をせず止める。一方だけでは入れ替わりを判定できない
	if ($null -eq $rootExe -or $null -eq $appExe) {
		throw 'ZIP の起動用 exe または本体 exe を読めません。'
	}

	# サイズが同じときは stub と本体が入れ替わっている
	if ($rootExe.Length -eq $appExe.Length) {
		throw '直下の TmsMdEditor.exe と app\TmsMdEditor.exe のサイズが同じです。起動用 stub と本体が入れ替わっている可能性があります。'
	}
} finally {
	$verify.Dispose()
}

Write-Host "portable zip: $zipPath"
Write-Host "sha256: $sha256"
