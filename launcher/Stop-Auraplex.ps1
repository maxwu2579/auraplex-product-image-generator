# Stops the Auraplex backend and frontend belonging to this project folder only.
# Unrelated python.exe / node.exe processes are never touched: a process is stopped only if
# it is tracked in runtime\launcher-state.json (PID + start time + project path verified), or it
# listens on port 3000/8000 and its own or its parent's command line references this project.
# Options: -NoUi  print the result to the console instead of showing a message box.

param([switch]$NoUi)

$script:NoUi = [bool]$NoUi
. (Join-Path $PSScriptRoot 'launcher-common.ps1')

Limit-LauncherLog
$lock = Enter-LauncherLock 15000
if ($null -eq $lock) {
    Show-Message "$AppTitle is still starting.`nWait until it opens, then try Stop again."
    exit 1
}

$exitCode = 0
try {
    Write-LauncherLog 'Stop requested.'
    $stopped = New-Object System.Collections.Generic.List[string]
    $state = Read-LauncherState

    foreach ($name in @('frontend', 'backend')) {
        $entry = $state[$name]
        if ($null -eq $entry) { continue }
        if (Test-TrackedAlive $entry) {
            Stop-ProcessTree $entry.pid $name
            $stopped.Add($name)
        } else {
            Write-LauncherLog "Removing stale $name PID $($entry.pid)."
        }
    }
    Save-LauncherState @{}

    # Instances of this project that the launcher did not start (e.g. started manually).
    foreach ($svc in @(@{ Name = 'frontend'; Port = $FrontendPort }, @{ Name = 'backend'; Port = $BackendPort })) {
        $port = Get-PortStatus $svc.Port
        if ($port.State -eq 'project') {
            Stop-ProcessTree ([int]$port.Root.ProcessId) "untracked $($svc.Name)"
            if (-not $stopped.Contains($svc.Name)) { $stopped.Add($svc.Name) }
        } elseif ($port.State -eq 'foreign') {
            Write-LauncherLog "Port $($svc.Port) is used by another program ($($port.Name), PID $($port.OwnerId)); left untouched."
        }
    }

    $remaining = @()
    foreach ($svc in @(@{ Name = 'frontend'; Port = $FrontendPort }, @{ Name = 'backend'; Port = $BackendPort })) {
        if ((Get-PortStatus $svc.Port).State -eq 'project') { $remaining += $svc.Name }
    }

    if ($remaining.Count -gt 0) {
        $exitCode = 1
        Write-LauncherLog "Still running after stop: $($remaining -join ', ')"
        Show-Message ("Some parts of $AppTitle could not be stopped: $($remaining -join ', ').`n`nSee:`n" + (Join-Path $LogDir 'launcher.log')) 'Warning'
    } elseif ($stopped.Count -eq 0) {
        Write-LauncherLog 'Nothing was running.'
        Show-Message "$AppTitle is not running."
    } else {
        Write-LauncherLog "Stopped: $($stopped -join ', ')"
        Show-Message "$AppTitle has been stopped."
    }
} catch {
    $exitCode = 1
    Write-LauncherLog "Stop failed: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
    Show-Message ("$AppTitle could not be stopped cleanly.`n`n$($_.Exception.Message)`n`nSee:`n" + (Join-Path $LogDir 'launcher.log')) 'Error'
} finally {
    $lock.ReleaseMutex()
    $lock.Dispose()
}
exit $exitCode
