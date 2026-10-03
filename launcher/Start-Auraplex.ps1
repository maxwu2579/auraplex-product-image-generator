# Starts the Auraplex backend and frontend (if not already running) and opens the app.
# Usage: double-click "Start Auraplex Tool.bat" or the "Auraplex Image Tool" desktop shortcut.
# Options: -NoOpen  start/verify the services without opening the app.
#          -NoUi    print progress/errors to the console instead of showing windows.

param([switch]$NoOpen, [switch]$NoUi)

$script:NoUi = [bool]$NoUi
. (Join-Path $PSScriptRoot 'launcher-common.ps1')

$BackendTimeoutSec = 60
$FrontendTimeoutSec = 90
$BuildTimeoutSec = 900

class LaunchError : System.Exception {
    [string]$LogName
    LaunchError([string]$message, [string]$logName) : base($message) { $this.LogName = $logName }
}

function Fail([string]$Message, [string]$LogName) { throw [LaunchError]::new($Message, $LogName) }

# ---------------------------------------------------------------- Preflight

function Find-Npm {
    $cmd = Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cmd) { return $cmd.Source }
    foreach ($candidate in @(
            (Join-Path $env:ProgramFiles 'nodejs\npm.cmd'),
            (Join-Path ${env:ProgramFiles(x86)} 'nodejs\npm.cmd'),
            (Join-Path $env:APPDATA 'npm\npm.cmd'))) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Assert-Prerequisites {
    if (-not (Test-PathIsCmdSafe $ProjectRoot)) {
        Fail "The project folder path contains a % or quote character, which the launcher cannot handle:`n$ProjectRoot" $null
    }
    if (-not (Test-Path -LiteralPath $BackendPython)) {
        Fail "The backend Python environment was not found:`n$BackendPython`n`nCreate it once as described in README.md (Run locally)." $null
    }
    if (-not (Test-Path -LiteralPath (Join-Path $FrontendDir 'node_modules\next\package.json'))) {
        Fail "Frontend Node dependencies are missing.`n`nRun 'npm install' once in:`n$FrontendDir" $null
    }
    $npm = Find-Npm
    if ($null -eq $npm) { Fail "Node.js / npm was not found on this computer. Install Node.js and try again." $null }
    return $npm
}

# ---------------------------------------------------------------- Build fingerprint

function Get-FrontendFingerprint {
    $entries = New-Object System.Collections.Generic.List[string]
    foreach ($dir in @('app', 'components', 'lib', 'public', 'styles')) {
        $path = Join-Path $FrontendDir $dir
        if (Test-Path -LiteralPath $path) {
            foreach ($file in Get-ChildItem -LiteralPath $path -Recurse -File) {
                $entries.Add(('{0}|{1}|{2}' -f $file.FullName.Substring($FrontendDir.Length), $file.Length, $file.LastWriteTimeUtc.Ticks))
            }
        }
    }
    $topLevel = @('package.json', 'package-lock.json', 'next.config.ts', 'next.config.js', 'next.config.mjs',
        'tsconfig.json', 'postcss.config.mjs', 'postcss.config.js', '.env', '.env.local', '.env.production', '.env.production.local',
        'node_modules\next\package.json')
    foreach ($name in $topLevel) {
        $path = Join-Path $FrontendDir $name
        if (Test-Path -LiteralPath $path) {
            $file = Get-Item -LiteralPath $path
            $entries.Add(('{0}|{1}|{2}' -f $name, $file.Length, $file.LastWriteTimeUtc.Ticks))
        }
    }
    $entries.Sort([StringComparer]::OrdinalIgnoreCase)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Get-BuildId {
    $path = Join-Path $FrontendDir '.next\BUILD_ID'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Get-Content -LiteralPath $path -Raw).Trim()
}

function Test-BuildCurrent([string]$Fingerprint) {
    $buildId = Get-BuildId
    if (-not $buildId) { return $false }
    if (-not (Test-Path -LiteralPath $BuildMarkerFile)) { return $false }
    try {
        $marker = Get-Content -LiteralPath $BuildMarkerFile -Raw -Encoding UTF8 | ConvertFrom-Json
        return ($marker.buildId -eq $buildId -and $marker.fingerprint -eq $Fingerprint)
    } catch {
        return $false
    }
}

function Invoke-FrontendBuild([string]$Npm) {
    $fingerprint = Get-FrontendFingerprint
    if (Test-BuildCurrent $fingerprint) {
        Write-LauncherLog 'Frontend build is current; reusing it.'
        return
    }
    Write-LauncherLog 'Frontend build missing or out of date; running npm run build.'
    Show-Status "Preparing the app (building the frontend).`nThis happens only after an update and can take a few minutes..."
    Remove-Item -LiteralPath $BuildMarkerFile -Force -ErrorAction SilentlyContinue
    $log = Initialize-Log 'frontend-build.log'
    $proc = Start-HiddenProcess $FrontendDir ('"' + $Npm + '" run build') $log $null
    $deadline = [DateTime]::UtcNow.AddSeconds($BuildTimeoutSec)
    while (-not $proc.WaitForExit(250)) {
        Update-Ui
        if ([DateTime]::UtcNow -gt $deadline) {
            Stop-ProcessTree $proc.Id 'frontend build'
            Fail "The frontend build did not finish within $([int]($BuildTimeoutSec / 60)) minutes." 'frontend-build.log'
        }
    }
    $exitCode = $proc.ExitCode
    Write-LauncherLog "Frontend build exited with code $exitCode."
    if ($exitCode -ne 0) { Fail "The frontend build failed (exit code $exitCode)." 'frontend-build.log' }
    $buildId = Get-BuildId
    if (-not $buildId) { Fail 'The frontend build finished but produced no build output (.next\BUILD_ID).' 'frontend-build.log' }
    # Fingerprint again: the build must not be marked current for sources edited while it ran.
    if ((Get-FrontendFingerprint) -ne $fingerprint) { Write-LauncherLog 'Sources changed during build; marker not written.'; return }
    $marker = [ordered]@{ buildId = $buildId; fingerprint = $fingerprint; builtAt = (Get-Date).ToString('o') }
    Set-Content -LiteralPath $BuildMarkerFile -Value ($marker | ConvertTo-Json) -Encoding UTF8
}

# ---------------------------------------------------------------- Service control

$script:StartedThisRun = New-Object System.Collections.Generic.List[string]
$script:State = @{}

function Start-AppService([string]$Name, [string]$WorkingDirectory, [string]$CommandLine, [hashtable]$Environment) {
    $log = Initialize-Log "$Name.log"
    $proc = Start-HiddenProcess $WorkingDirectory $CommandLine $log $Environment
    $info = Get-ProcessInfo $proc.Id
    $script:State[$Name] = @{ pid = $proc.Id; startTicks = (Get-ProcessStartTicks $info) }
    Save-LauncherState $script:State
    $script:StartedThisRun.Add($Name)
    Write-LauncherLog "Started $Name (root PID $($proc.Id))."
    return $proc
}

function Wait-Ready([string]$Name, $Process, [scriptblock]$Probe, [int]$TimeoutSec) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Probe) { Write-LauncherLog "$Name is ready."; return }
        if ($null -ne $Process -and $Process.HasExited) {
            Fail "The $Name stopped unexpectedly while starting (exit code $($Process.ExitCode))." "$Name.log"
        }
        Wait-Ui 500
    }
    Fail "The $Name did not become ready within $TimeoutSec seconds." "$Name.log"
}

function Stop-StartedThisRun {
    foreach ($name in @($script:StartedThisRun)) {
        $entry = $script:State[$name]
        if ($null -ne $entry -and (Test-TrackedAlive $entry)) { Stop-ProcessTree $entry.pid $name }
        $script:State.Remove($name)
    }
    Save-LauncherState $script:State
}

# Decide what to do with one service. Returns 'running', 'starting' (ours, not yet healthy) or 'start'.
function Resolve-Service([string]$Name, [int]$Port, [scriptblock]$Probe) {
    $tracked = $script:State[$Name]
    if ($null -ne $tracked -and -not (Test-TrackedAlive $tracked)) {
        Write-LauncherLog "Discarding stale $Name PID $($tracked.pid)."
        $script:State.Remove($Name)
        $tracked = $null
    }
    $portStatus = Get-PortStatus $Port
    switch ($portStatus.State) {
        'foreign' {
            Fail ("Port $Port is already used by another program ($($portStatus.Name), PID $($portStatus.OwnerId)).`n`n" +
                "Close that program, or stop it, and start Auraplex Image Tool again.") $null
        }
        'project' {
            if (& $Probe) { Write-LauncherLog "$Name already running (listener PID $($portStatus.OwnerId))."; return 'running' }
            Write-LauncherLog "$Name process of this project holds port $Port but is not ready yet; waiting."
            return 'starting'
        }
        default {
            if ($null -ne $tracked) {
                # Tracked process alive but not listening: left over from a failed start. Replace it.
                Stop-ProcessTree $tracked.pid "stale $Name"
                $script:State.Remove($Name)
            }
            return 'start'
        }
    }
}

# ---------------------------------------------------------------- Open

function Find-Edge {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe')) {
        try {
            $value = (Get-Item -LiteralPath $key -ErrorAction Stop).GetValue('')
            if ($value) { $candidates.Add($value.Trim('"')) }
        } catch { }
    }
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($base) { $candidates.Add((Join-Path $base 'Microsoft\Edge\Application\msedge.exe')) }
    }
    foreach ($path in $candidates) { if (Test-Path -LiteralPath $path) { return $path } }
    return $null
}

function Open-App {
    $edge = Find-Edge
    if ($null -ne $edge) {
        try {
            Start-Process -FilePath $edge -ArgumentList "--app=$AppUrl"
            Write-LauncherLog "Opened app window with Edge: $edge"
            return
        } catch {
            Write-LauncherLog "Edge app mode failed: $($_.Exception.Message)"
        }
    }
    Start-Process $AppUrl
    Write-LauncherLog 'Opened app in the default browser.'
}

# ---------------------------------------------------------------- Main

Limit-LauncherLog
$lock = Enter-LauncherLock 0
if ($null -eq $lock) {
    Show-Message "$AppTitle is already starting or stopping.`nPlease wait a moment."
    exit 0
}

$exitCode = 0
try {
    Write-LauncherLog "Start requested. Project: $ProjectRoot"
    $npm = Assert-Prerequisites
    $script:State = Read-LauncherState

    $backendHealthy = { Test-BackendHealthy }
    $frontendHealthy = { Test-FrontendHealthy }
    $backendPlan = Resolve-Service 'backend' $BackendPort $backendHealthy
    $frontendPlan = Resolve-Service 'frontend' $FrontendPort $frontendHealthy
    Save-LauncherState $script:State

    if ($backendPlan -eq 'running' -and $frontendPlan -eq 'running') {
        Write-LauncherLog 'Both services already running; opening app only.'
    } else {
        Show-Status 'Starting Auraplex Image Tool...'

        $backendProc = $null
        if ($backendPlan -eq 'start') {
            Show-Status 'Starting the image-processing service...'
            $backendCmd = '"' + $BackendPython + '" -m uvicorn app.main:app --host 127.0.0.1 --port ' + $BackendPort
            $backendProc = Start-AppService 'backend' $BackendDir $backendCmd @{ PYTHONIOENCODING = 'utf-8'; PYTHONUNBUFFERED = '1' }
        }

        $frontendProc = $null
        if ($frontendPlan -eq 'start') {
            Invoke-FrontendBuild $npm
        }

        if ($backendPlan -ne 'running') {
            Show-Status 'Waiting for the image-processing service...'
            Wait-Ready 'backend' $backendProc $backendHealthy $BackendTimeoutSec
        }

        if ($frontendPlan -eq 'start') {
            Show-Status 'Starting the editor...'
            $frontendCmd = '"' + $npm + '" run start -- -p ' + $FrontendPort
            $frontendProc = Start-AppService 'frontend' $FrontendDir $frontendCmd $null
        }
        if ($frontendPlan -ne 'running') {
            Show-Status 'Waiting for the editor...'
            Wait-Ready 'frontend' $frontendProc $frontendHealthy $FrontendTimeoutSec
        }
    }

    if (-not $NoOpen) {
        Show-Status 'Opening Auraplex Image Tool...'
        Open-App
    }
    Write-LauncherLog 'Start completed.'
} catch {
    $exitCode = 1
    $err = $_.Exception
    Write-LauncherLog "Start failed: $($err.Message)"
    if (-not ($err -is [LaunchError])) { Write-LauncherLog $_.ScriptStackTrace }
    try { Stop-StartedThisRun } catch { Write-LauncherLog "Cleanup failed: $($_.Exception.Message)" }
    Close-Status
    $message = "$AppTitle could not start.`n`n$($err.Message)"
    if ($err -is [LaunchError] -and $err.LogName) {
        $message += "`n`nSee:`n" + (Join-Path $LogDir $err.LogName)
    } elseif (-not ($err -is [LaunchError])) {
        $message += "`n`nSee:`n" + (Join-Path $LogDir 'launcher.log')
    }
    Show-Message $message 'Error'
} finally {
    Close-Status
    $lock.ReleaseMutex()
    $lock.Dispose()
}
exit $exitCode
