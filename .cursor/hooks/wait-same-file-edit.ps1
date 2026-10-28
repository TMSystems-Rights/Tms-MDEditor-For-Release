<#
.SYNOPSIS
	同じファイルへの連続した編集を 6 秒空ける
.DESCRIPTION
	Write と StrReplace は開始前に待ち、終了時に時刻を記録する
	シェルは、ファイルを書き換えるコマンドで、対象パスがコマンド文字列から分かるときだけ同じ間隔に入る
	記録は TEMP の JSON に残し、リポジトリのファイルは変更しない
	パスが読めないときと、待ちのロックが取れないときは許可して編集を止めない
.OUTPUTS
	なし。preToolUse は permission allow、postToolUse は空の JSON を標準出力へ書く
.EXAMPLE
	'{"hook_event_name":"preToolUse","tool_name":"Write","tool_input":{"path":"C:\\work\\a.ts"}}' | pwsh -NoProfile -File .cursor/hooks/wait-same-file-edit.ps1
#>

# 編集間隔。検知の約 1.2 秒のあと、大きなファイルの ESLint 保存が終わるまで次の書き込みを遅らせる
$gapMs      = 6000
# ロックを待つ上限。フック全体の timeout より短く、取れなければ許可する
$lockWaitMs = 40000
# 前回時刻の保存先。ワークスペース外なので整形保存の対象にしない
$statePath  = Join-Path $env:TEMP 'tms-mde-format-save-gap.json'
# プロセスをまたいで同じパスの間隔を守る名前付きミューテックス
$mutexName  = 'Local\TmsMdeFormatSaveGap'

<#
.SYNOPSIS
	フック結果の JSON を標準出力へ書く
.DESCRIPTION
	preToolUse は編集を許可する。postToolUse は追加の文脈を返さない
	リポジトリのファイルは変更しない
.PARAMETER IsPost
	postToolUse のとき true。true なら空の JSON、false なら permission allow
.OUTPUTS
	なし。標準出力へ 1 行の JSON を書く
#>
function Write-HookResult {
	param([bool]$IsPost)

	# 終了フックは許可を返さない。追加の文脈も渡さない
	if ($IsPost) {
		Write-Output '{}'
		return
	}

	Write-Output '{"permission":"allow"}'
}

<#
.SYNOPSIS
	tool_input をオブジェクトで返す
.DESCRIPTION
	文字列 JSON はオブジェクトに戻す。tool_input が無いときは null
	リポジトリのファイルは変更しない
.PARAMETER Payload
	preToolUse または postToolUse の JSON オブジェクト
.OUTPUTS
	System.Object。引数が無いときは null
#>
function Get-ToolInput {
	param($Payload)

	# ツールへ渡す引数。文字列 JSON のときはオブジェクトに戻す
	$inputObj = $Payload.tool_input
	# 文字列の引数は、中の path や command を読むためにオブジェクトへ戻す
	if ($inputObj -is [string] -and -not [string]::IsNullOrWhiteSpace($inputObj)) {
		$inputObj = $inputObj | ConvertFrom-Json
	}

	return $inputObj
}

<#
.SYNOPSIS
	Write と StrReplace の編集パスを取り出す
.DESCRIPTION
	path を先に見る。空なら file_path を使う。シェルのコマンドは対象にしない
.PARAMETER InputObj
	tool_input のオブジェクト。null のときは空文字を返す
.OUTPUTS
	System.String。パスが無ければ空文字
#>
function Get-EditPath {
	param($InputObj)

	# 引数の無いツールはパスを持たない
	if ($null -eq $InputObj) {
		return ''
	}

	# path か file_path。どちらも無ければ空
	$path = [string]$InputObj.path
	# path が空のツールは file_path を見る
	if ([string]::IsNullOrWhiteSpace($path)) {
		$path = [string]$InputObj.file_path
	}

	return $path
}

<#
.SYNOPSIS
	シェルの作業ディレクトリを返す
.DESCRIPTION
	tool_input の working_directory、cwd、フック入力の cwd の順に見る
	どれも空なら、このプロセスの現在位置を返す
.PARAMETER Payload
	フック入力。cwd が無いときは tool_input だけを見る
.PARAMETER InputObj
	tool_input。null のときは Payload の cwd だけを見る
.OUTPUTS
	System.String。作業ディレクトリのパス
#>
function Get-WorkingDirectory {
	param($Payload, $InputObj)

	# シェルツールが明示した作業ディレクトリ
	$cwd = ''
	# tool_input があるときだけ、その中の作業ディレクトリを読む
	if ($null -ne $InputObj) {
		$cwd = [string]$InputObj.working_directory
		# working_directory が空のツールは cwd を見る
		if ([string]::IsNullOrWhiteSpace($cwd)) {
			$cwd = [string]$InputObj.cwd
		}
	}

	# ツール引数に無いときは、フック入力の cwd を使う
	if ([string]::IsNullOrWhiteSpace($cwd)) {
		$cwd = [string]$Payload.cwd
	}

	# どれも無いときは、フックプロセスの現在位置を基準にする
	if ([string]::IsNullOrWhiteSpace($cwd)) {
		return (Get-Location).Path
	}

	return $cwd
}

<#
.SYNOPSIS
	シェルコマンドがファイルを書き換える形かを返す
.DESCRIPTION
	eslint --fix、--write、内容を書くコマンドレット、ファイルへのリダイレクトを書き込みとみなす
	パスがコマンドに無い書き込みは、ここでは検知しない
.PARAMETER Command
	シェルのコマンド文字列。空なら書き込みとみなさない
.OUTPUTS
	System.Boolean。書き換える形のとき true
#>
function Test-ShellCommandWritesFile {
	param([string]$Command)

	# コマンドが空のシェルは、ファイルを書き換える対象にしない
	if ([string]::IsNullOrWhiteSpace($Command)) {
		return $false
	}

	# 内容をファイルへ書くコマンドレット。読み取りの Get-Content は含めない
	if ($Command -match '(?i)(^|[\s;|&])(Set-Content|Add-Content|Out-File|Clear-Content|Tee-Object|New-Item|Copy-Item|Move-Item|Rename-Item)([\s;|&]|$)') {
		return $true
	}

	# ESLint や整形ツールの修正フラグ。--fix の無い実行は書き込まない
	if ($Command -match '(?i)(^|\s)--fix(\s|$)') {
		return $true
	}

	# Prettier などの書き戻しフラグ
	if ($Command -match '(?i)(^|\s)--write(\s|$)') {
		return $true
	}

	# ファイルへのリダイレクト。2>&1 のようなストリーム結合はファイルを書かない
	if ($Command -match '(?<![0-9&])>>?(?![&>])') {
		return $true
	}

	return $false
}

<#
.SYNOPSIS
	コマンド文字列に、そのファイルのパスが含まれるかを返す
.DESCRIPTION
	フルパスと、作業ディレクトリからの相対パスを見る。区切りは \ と / の両方
	相対パスが作業ディレクトリの外へ出るときは、フルパスだけを見る
.PARAMETER Command
	シェルのコマンド文字列。空なら一致しない
.PARAMETER FullPath
	比較するフルパス。空なら一致しない
.PARAMETER WorkingDirectory
	相対パスの基準。空ならフルパスだけを見る
.OUTPUTS
	System.Boolean。コマンドにパスがあるとき true
#>
function Test-CommandMentionsPath {
	param([string]$Command, [string]$FullPath, [string]$WorkingDirectory)

	# コマンドかパスが空なら、間隔の対象パスは決まらない
	if ([string]::IsNullOrWhiteSpace($Command) -or [string]::IsNullOrWhiteSpace($FullPath)) {
		return $false
	}

	# 大小と区切りを揃えたコマンド。Windows のパス比較に使う
	$hay  = $Command.ToLowerInvariant()
	$full = $FullPath.ToLowerInvariant()
	# フルパスがコマンドにあれば、相対パスへ直さなくてよい
	if ($hay.Contains($full)) {
		return $true
	}

	# 作業ディレクトリが無いと、相対パスは作れない
	if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
		return $false
	}

	# 作業ディレクトリからの相対パス。別ドライブでは例外になる
	$relative = ''
	try {
		$relative = [System.IO.Path]::GetRelativePath($WorkingDirectory, $FullPath)
	} catch {
		return $false
	}

	# 作業ディレクトリの外は、フルパスが無い限りこのコマンドの対象にしない
	if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('..')) {
		return $false
	}

	# \ と / のどちらで書かれていても同じファイルとみなす
	$relativeLower = $relative.ToLowerInvariant()
	$relativeSlash = $relativeLower.Replace('\', '/')
	return $hay.Contains($relativeLower) -or $hay.Contains($relativeSlash)
}

<#
.SYNOPSIS
	コマンド内のトークンのうち、実在するファイルのフルパスを返す
.DESCRIPTION
	引用符付きと空白区切りのトークンを、作業ディレクトリ基準でフルパスにする
	ディレクトリ、オプション、実在しないパスは返さない
.PARAMETER Command
	シェルのコマンド文字列。空なら空配列
.PARAMETER WorkingDirectory
	相対トークンの基準ディレクトリ
.OUTPUTS
	System.String[]。小文字化したフルパス。無ければ空配列
#>
function Get-CommandFilePaths {
	param([string]$Command, [string]$WorkingDirectory)

	# コマンドが空なら、トークンからファイルは取れない
	if ([string]::IsNullOrWhiteSpace($Command)) {
		return @()
	}

	# 見つかったファイル。キーは小文字のフルパス
	$found = @{}
	# 引用符付きと、空白区切りのトークン
	$tokens = [regex]::Matches($Command, '"([^"]+)"|''([^'']+)''|(\S+)')
	foreach ($tokenMatch in $tokens) {
		# 引用符の中か、裸のトークン。グループのどれか一つに入る
		$token = $tokenMatch.Groups[1].Value
		# 二重引用符が空なら、単一引用符の中を使う
		if ([string]::IsNullOrWhiteSpace($token)) {
			$token = $tokenMatch.Groups[2].Value
		}

		# 引用符が無ければ、空白区切りのトークンを使う
		if ([string]::IsNullOrWhiteSpace($token)) {
			$token = $tokenMatch.Groups[3].Value
		}

		# 区切りの残りを外す。オプションはパスにしない
		$token = $token.Trim().TrimEnd(',', ';')
		# フラグはファイルパスではない
		if ([string]::IsNullOrWhiteSpace($token) -or $token.StartsWith('-')) {
			continue
		}

		# 相対パスは作業ディレクトリから辿る
		$candidate = $token
		# ドライブレターや UNC でなければ、作業ディレクトリを付ける
		if (-not [System.IO.Path]::IsPathRooted($candidate)) {
			$candidate = Join-Path $WorkingDirectory $candidate
		}

		# 不正な文字のトークンはパスにしない
		$full = ''
		try {
			$full = [System.IO.Path]::GetFullPath($candidate)
		} catch {
			continue
		}

		# 実在するファイルだけを間隔の対象にする。ディレクトリは対象外
		if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
			continue
		}

		$found[$full.ToLowerInvariant()] = $true
	}

	return @($found.Keys)
}

<#
.SYNOPSIS
	前回の編集時刻を TEMP から読む
.DESCRIPTION
	記録ファイルが無い、または JSON が壊れているときは空の辞書を返す。リポジトリのファイルは読まない
.OUTPUTS
	Hashtable。キーはフルパス、値は UTC ミリ秒
#>
function Read-EditTimes {
	# 記録が無い最初の編集は空の辞書
	if (-not (Test-Path -LiteralPath $statePath)) {
		return @{}
	}

	# パスと時刻の組。壊れた JSON は空として扱う
	$times = @{}
	try {
		# 保存済みの配列。要素は path と at
		$loaded = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json
		foreach ($entry in @($loaded)) {
			# パスが空の行は間隔の判定に使わない
			if ([string]::IsNullOrWhiteSpace([string]$entry.path)) {
				continue
			}

			$times[[string]$entry.path] = [int64]$entry.at
		}
	} catch {
		return @{}
	}

	return $times
}

<#
.SYNOPSIS
	編集時刻を TEMP へ書く
.DESCRIPTION
	1 分より古いパスは捨てる。書く先は TEMP の JSON だけで、リポジトリは変更しない
.PARAMETER Times
	パスをキー、UTC ミリ秒を値にした辞書。空でも JSON 配列を書く
.OUTPUTS
	なし。TEMP の JSON を上書きする
#>
function Write-EditTimes {
	param($Times)

	# 1 分より古いパスは捨てる。間隔の判定には使わない
	$cutoff = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 60000
	# JSON へ書く配列。path は編集対象、at は UTC ミリ秒
	$rows   = foreach ($path in @($Times.Keys)) {
		# 1 分より前の記録は間隔判定に残さない
		if ([int64]$Times[$path] -lt $cutoff) {
			continue
		}

		[pscustomobject]@{
			# 編集したファイルのフルパス
			path = [string]$path
			# その編集を記録した時刻（UTC ミリ秒）
			at   = [int64]$Times[$path]
		}
	}

	# 配列が空でも JSON 配列として書く
	@($rows) | ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -Encoding utf8
}

<#
.SYNOPSIS
	対象パスの間隔を空け、時刻を記録する
.DESCRIPTION
	待つときは、対象のうち最も新しい記録から 6 秒経つまでスリープする
	待ったあとの時刻を各パスへ書く。リポジトリのファイルは変更しない
	ロックが取れないときは何も書かず戻る
.PARAMETER Paths
	小文字のフルパス。コマンドからは取れなくても、記録済みパスの照合で増える
.PARAMETER Command
	シェルのコマンド。空なら、記録済みパスとの照合はしない
.PARAMETER WorkingDirectory
	Command 内の相対パスを解く基準
.PARAMETER Wait
	true のとき、6 秒未満の再編集を待ってから記録する。終了時の記録は false
.OUTPUTS
	なし。TEMP の JSON を更新する。ロックが取れないときは更新しない
#>
function Sync-EditGap {
	param([string[]]$Paths, [string]$Command, [string]$WorkingDirectory, [bool]$Wait)

	# 同時に入った同じパスの判定を一つずつにする
	$mutex    = New-Object System.Threading.Mutex($false, $mutexName)
	# WaitOne が成功したときだけ解放する
	$acquired = $false
	try {
		$acquired = $mutex.WaitOne($lockWaitMs)
		# ロックが取れないときは編集を止めず、間隔の強制は諦める
		if (-not $acquired) {
			return
		}

		# パスごとの前回時刻。無ければ空
		$times = Read-EditTimes
		# 今回記録するパス。トークン解決と、コマンドに含まれる記録済みパス
		$targets = @{}
		foreach ($path in @($Paths)) {
			# 空の要素は間隔の対象にしない
			if ([string]::IsNullOrWhiteSpace($path)) {
				continue
			}

			$targets[$path.ToLowerInvariant()] = $true
		}

		# コマンドに記録済みのパスが出ていれば、トークン解決に失敗しても対象に含める
		if (-not [string]::IsNullOrWhiteSpace($Command)) {
			foreach ($known in @($times.Keys)) {
				# フルパスか相対パスがコマンドにあれば、そのファイルへの書き込みとみなす
				if (Test-CommandMentionsPath -Command $Command -FullPath ([string]$known) -WorkingDirectory $WorkingDirectory) {
					$targets[[string]$known] = $true
				}
			}
		}

		# 対象が無いコマンドは、時刻を動かさない
		if ($targets.Count -eq 0) {
			return
		}

		# 今の UTC ミリ秒。前回との差をここから引く
		$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
		# 開始前だけ待つ。終了時は、終わった時刻で記録を上書きする
		if ($Wait) {
			# 対象のうち最も新しい記録。無ければ待たない
			$latest = [int64]0
			foreach ($path in @($targets.Keys)) {
				# 記録が無いパスは、今回が最初の編集なので待たない
				if (-not $times.ContainsKey($path)) {
					continue
				}

				# より新しい記録があれば、待ち時間はそちらに合わせる
				if ([int64]$times[$path] -gt $latest) {
					$latest = [int64]$times[$path]
				}
			}

			# 前回があるときだけ、6 秒未満の分を待つ
			if ($latest -gt 0) {
				# 前回記録からの経過。負なら時計のずれとして待たない
				$elapsed = $now - $latest
				# 6 秒未満の再編集だけ、残り時間を待ってから記録する
				if ($elapsed -ge 0 -and $elapsed -lt $gapMs) {
					Start-Sleep -Milliseconds ($gapMs - $elapsed)
					$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
				}
			}
		}

		foreach ($path in @($targets.Keys)) {
			$times[$path] = $now
		}

		Write-EditTimes -Times $times
	} finally {
		# 取れたロックだけ戻す。取れなかった Mutex は解放しない
		if ($acquired) {
			$mutex.ReleaseMutex()
		}

		$mutex.Dispose()
	}
}

# ==============================================
# 入力を読んで間隔を更新する
# ==============================================

# 標準入力のフック JSON。空なら編集を止めない
$raw = [Console]::In.ReadToEnd()
# 入力が無い呼び出しは間隔を判定できないので許可する
if ([string]::IsNullOrWhiteSpace($raw)) {
	Write-HookResult -IsPost $false
	exit 0
}

try {
	# preToolUse または postToolUse の本体。壊れていれば許可する
	$payload = $raw | ConvertFrom-Json
} catch {
	Write-HookResult -IsPost $false
	exit 0
}

# postToolUse のとき true。開始前の待ちはしない
$isPost = [string]$payload.hook_event_name -eq 'postToolUse'
# ツール名。大文字小文字は区別しない
$toolName = [string]$payload.tool_name
# ツール引数。path と command はここから読む
$inputObj = Get-ToolInput -Payload $payload
# 相対パスの基準。Write でもシェルの作業ディレクトリを使う
$workingDirectory = Get-WorkingDirectory -Payload $payload -InputObj $inputObj

# 間隔の対象にするフルパス。シェルの読み取りは空のまま戻す
$editPaths = @()
# 記録済みパスと照合するコマンド。Write と StrReplace は空
$command = ''
# シェルは、ファイルを書くコマンドだけ間隔の対象にする
if ($toolName -eq 'Shell') {
	$command = [string]$inputObj.command
	# 読み取りのシェルは時刻を動かさず、開始前なら許可する
	if (-not (Test-ShellCommandWritesFile -Command $command)) {
		Write-HookResult -IsPost $isPost
		exit 0
	}

	# コマンドに書かれた実在ファイル。記録済みパスはロックの中で足す
	$editPaths = @(Get-CommandFilePaths -Command $command -WorkingDirectory $workingDirectory)
} else {
	# Write と StrReplace のパス。空ならこのツールはファイル編集ではない
	$editPath = Get-EditPath -InputObj $inputObj
	# パスが無い編集は間隔の対象外
	if ([string]::IsNullOrWhiteSpace($editPath)) {
		Write-HookResult -IsPost $isPost
		exit 0
	}

	# 比較用のフルパス。大文字小文字は Windows では区別しない
	$editPaths = @([System.IO.Path]::GetFullPath($editPath).ToLowerInvariant())
}

# 開始前は 6 秒空けてから予約し、終了時はその時刻で上書きする
Sync-EditGap -Paths $editPaths -Command $command -WorkingDirectory $workingDirectory -Wait (-not $isPost)
Write-HookResult -IsPost $isPost
exit 0
