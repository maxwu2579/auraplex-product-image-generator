# Shared helpers for the Auraplex Windows launcher.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:AppTitle = 'Auraplex Image Tool'
$script:ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$script:BackendDir = Join-Path $ProjectRoot 'backend'
$script:FrontendDir = Join-Path $ProjectRoot 'frontend'
$script:LogDir = Join-Path $ProjectRoot 'logs'
$script:RuntimeDir = Join-Path $ProjectRoot 'runtime'
$script:StateFile = Join-Path $RuntimeDir 'launcher-state.json'
$script:BuildMarkerFile = Join-Path $RuntimeDir 'frontend-build.json'
$script:BackendPython = Join-Path $BackendDir '.venv\Scripts\python.exe'
$script:BackendPort = 8000
$script:FrontendPort = 3000
$script:BackendHealthUrl = 'http://127.0.0.1:8000/api/health'
$script:FrontendUrl = 'http://127.0.0.1:3000/'
$script:AppUrl = 'http://127.0.0.1:3000'
$script:PageTitle = [string]::Concat('Auraplex ', [char]0x56FE, [char]0x7247, [char]0x5408, [char]0x6210, [char]0x5DE5, [char]0x5177)

foreach ($dir in @($LogDir, $RuntimeDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
}

# ---------------------------------------------------------------- UI

$script:StatusForm = $null
$script:StatusLabel = $null
$script:AllowStatusClose = $false

# Set $script:NoUi = $true (the -NoUi switch) to print to the console instead of showing windows.
if (-not (Test-Path variable:script:NoUi)) { $script:NoUi = $false }

function Show-Status([string]$Message) {
    if ($script:NoUi) { Write-Output "[status] $Message"; return }
    if ($null -eq $script:StatusForm) {
        $form = New-Object System.Windows.Forms.Form
        $form.Text = $script:AppTitle
        $form.Size = New-Object System.Drawing.Size(460, 140)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $form.MinimizeBox = $true
        $form.TopMost = $true
        # Closing the status window would not stop the start; keep it until the launcher closes it.
        $form.Add_FormClosing({ param($s, $e) if (-not $script:AllowStatusClose) { $e.Cancel = $true } })
        $label = New-Object System.Windows.Forms.Label
        $label.Dock = 'Fill'
        $label.Padding = New-Object System.Windows.Forms.Padding(16)
        $label.Font = New-Object System.Drawing.Font('Segoe UI', 10)
        $form.Controls.Add($label)
        $script:StatusForm = $form
        $script:StatusLabel = $label
        $form.Show()
    }
    $script:StatusLabel.Text = $Message
    Update-Ui
}

function Update-Ui {
    if ($null -ne $script:StatusForm) { [System.Windows.Forms.Application]::DoEvents() }
}

function Close-Status {
    if ($null -ne $script:StatusForm) {
        $script:AllowStatusClose = $true
        $script:StatusForm.Close()
        $script:StatusForm.Dispose()
        $script:StatusForm = $null
    }
}

function Show-Message([string]$Message, [string]$Kind = 'Information') {
    if ($script:NoUi) { Write-Output "[$Kind] $Message"; return }
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    try {
        [System.Windows.Forms.MessageBox]::Show($owner, $Message, $script:AppTitle, 'OK', $Kind) | Out-Null
    } finally {
        $owner.Dispose()
    }
}

function Wait-Ui([int]$Milliseconds) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($Milliseconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        Update-Ui
        Start-Sleep -Milliseconds 100
    }
}

# ---------------------------------------------------------------- Logs

function Write-LauncherLog([string]$Message) {
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PID, $Message
    Add-Content -LiteralPath (Join-Path $script:LogDir 'launcher.log') -Value $line -Encoding UTF8
}

# Keep one previous copy of a log; start the current run with an empty file.
function Initialize-Log([string]$Name) {
    $path = Join-Path $script:LogDir $Name
    if (Test-Path -LiteralPath $path) {
        $previous = [System.IO.Path]::ChangeExtension($path, '.previous.log')
        Move-Item -LiteralPath $path -Destination $previous -Force
    }
    New-Item -ItemType File -Path $path -Force | Out-Null
    return $path
}

# launcher.log is appended across runs; trim it when it grows past 1 MB.
function Limit-LauncherLog {
    $path = Join-Path $script:LogDir 'launcher.log'
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 1MB) {
        Move-Item -LiteralPath $path -Destination ([System.IO.Path]::ChangeExtension($path, '.previous.log')) -Force
    }
}

# ---------------------------------------------------------------- HTTP

function Test-HttpOk([string]$Url, [int]$TimeoutMs = 3000) {
    try {
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = 'GET'
        $request.Timeout = $TimeoutMs
        $request.ReadWriteTimeout = $TimeoutMs
        $request.Proxy = $null
        $request.AllowAutoRedirect = $true
        $response = $request.GetResponse()
        try { return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400) }
        finally { $response.Close() }
    } catch {
        return $false
    }
}

function Test-BackendHealthy { return (Test-HttpOk $script:BackendHealthUrl) }
function Test-FrontendHealthy { return (Test-HttpOk $script:FrontendUrl 10000) }

# ---------------------------------------------------------------- Processes

function Get-ProcessInfo([int]$ProcessId) {
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Get-ProcessStartTicks($Info) {
    if ($null -eq $Info -or $null -eq $Info.CreationDate) { return 0 }
    return ([DateTime]$Info.CreationDate).ToUniversalTime().Ticks
}

function Get-DescendantIds([int]$RootId) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
    $result = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[object]
    $root = $all | Where-Object { $_.ProcessId -eq $RootId } | Select-Object -First 1
    if ($null -eq $root) { return @() }
    $queue.Enqueue($root)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($child in $all) {
            # A child must be younger than its parent, otherwise the parent id was reused.
            if ($child.ParentProcessId -eq $parent.ProcessId -and $child.ProcessId -ne $parent.ProcessId -and
                (Get-ProcessStartTicks $child) -ge (Get-ProcessStartTicks $parent) -and -not $result.Contains([int]$child.ProcessId)) {
                $result.Add([int]$child.ProcessId)
                $queue.Enqueue($child)
            }
        }
    }
    return $result.ToArray()
}

function Test-CommandLineInProject($Info) {
    if ($null -eq $Info -or [string]::IsNullOrEmpty($Info.CommandLine)) { return $false }
    return $Info.CommandLine.IndexOf($script:ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

# A process is part of this project if it, or one of its (python/node/cmd) ancestors,
# was started from a command line that references the project directory.
# The venv python.exe is a redirector: the real listener is a child of it whose
# command line does not mention the project path.
function Get-ProjectServerRoot([int]$ProcessId) {
    $table = @{}
    foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate) { $table[[int]$p.ProcessId] = $p }
    $info = $table[$ProcessId]
    $found = $null
    $guard = 0
    while ($null -ne $info -and $guard -lt 8) {
        $guard++
        if (@('python.exe', 'node.exe', 'cmd.exe') -notcontains $info.Name.ToLowerInvariant()) { break }
        if (Test-CommandLineInProject $info) { $found = $info }
        elseif ($null -ne $found) { break }
        $parent = $table[[int]$info.ParentProcessId]
        if ($null -eq $parent -or (Get-ProcessStartTicks $parent) -gt (Get-ProcessStartTicks $info)) { break }
        $info = $parent
    }
    return $found
}

# netstat is ~20x faster than Get-NetTCPConnection on PowerShell 5.1. The state column may be
# localized, so a listener is recognised by its unspecified remote address instead.
function Get-PortOwner([int]$Port) {
    try {
        $lines = & netstat.exe -ano
        if ($LASTEXITCODE -eq 0) {
            foreach ($line in $lines) {
                $cols = -split $line
                if ($cols.Count -ge 5 -and $cols[0] -eq 'TCP' -and $cols[1].EndsWith(":$Port") -and
                    ($cols[2] -eq '0.0.0.0:0' -or $cols[2] -eq '[::]:0')) {
                    return [int]$cols[$cols.Count - 1]
                }
            }
            return $null
        }
    } catch { }
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $conn) { return $null }
    return [int]$conn.OwningProcess
}

# Returns: @{ State = 'free' | 'project' | 'foreign'; OwnerId; Root; Name }
function Get-PortStatus([int]$Port) {
    $owner = Get-PortOwner $Port
    if ($null -eq $owner) { return @{ State = 'free'; OwnerId = $null; Root = $null; Name = $null } }
    $info = Get-ProcessInfo $owner
    $name = if ($null -ne $info) { $info.Name } else { 'unknown' }
    $root = Get-ProjectServerRoot $owner
    if ($null -ne $root) { return @{ State = 'project'; OwnerId = $owner; Root = $root; Name = $name } }
    return @{ State = 'foreign'; OwnerId = $owner; Root = $null; Name = $name }
}

# Launch a command line through a window-less cmd.exe so stdout/stderr go to a log file
# and no console window is shown. Returns the cmd.exe process (the tracked root).
function Start-HiddenProcess([string]$WorkingDirectory, [string]$CommandLine, [string]$LogPath, [hashtable]$Environment) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $psi.Arguments = '/d /s /c "' + $CommandLine + ' 1>>"' + $LogPath + '" 2>&1"'
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($null -ne $Environment) {
        foreach ($key in $Environment.Keys) { $psi.EnvironmentVariables[$key] = [string]$Environment[$key] }
    }
    return [System.Diagnostics.Process]::Start($psi)
}

function Stop-ProcessTree([int]$RootId, [string]$Label) {
    # taskkill reports expected failures on stderr (e.g. console apps refuse a polite close);
    # PowerShell 5.1 would turn that into a terminating error under 'Stop'.
    $ErrorActionPreference = 'SilentlyContinue'
    $ids = @($RootId) + @(Get-DescendantIds $RootId)
    Write-LauncherLog "Stopping $Label tree: $($ids -join ', ')"
    # Polite request first (no effect on window-less console apps, but harmless), then force.
    & taskkill.exe /PID $RootId /T 2>&1 | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    while ([DateTime]::UtcNow -lt $deadline) {
        $alive = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($alive.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    }
    & taskkill.exe /PID $RootId /T /F 2>&1 | Out-Null
    foreach ($id in $ids) {
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        $alive = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($alive.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    }
}

# ---------------------------------------------------------------- State

function Read-LauncherState {
    if (-not (Test-Path -LiteralPath $script:StateFile)) { return @{} }
    try {
        $raw = Get-Content -LiteralPath $script:StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $state = @{}
        foreach ($name in @('backend', 'frontend')) {
            $entry = $raw.PSObject.Properties[$name]
            if ($null -ne $entry -and $null -ne $entry.Value) {
                $state[$name] = @{ pid = [int]$entry.Value.pid; startTicks = [long]$entry.Value.startTicks }
            }
        }
        return $state
    } catch {
        Write-LauncherLog "Ignoring unreadable state file: $($_.Exception.Message)"
        return @{}
    }
}

function Save-LauncherState([hashtable]$State) {
    if ($State.Count -eq 0) {
        Remove-Item -LiteralPath $script:StateFile -Force -ErrorAction SilentlyContinue
        foreach ($name in @('backend', 'frontend')) { Remove-Item -LiteralPath (Join-Path $script:RuntimeDir "$name.pid") -Force -ErrorAction SilentlyContinue }
        return
    }
    $out = [ordered]@{ projectRoot = $script:ProjectRoot; updated = (Get-Date).ToString('o') }
    foreach ($name in @('backend', 'frontend')) {
        $pidFile = Join-Path $script:RuntimeDir "$name.pid"
        if ($State.ContainsKey($name)) {
            $out[$name] = [ordered]@{ pid = $State[$name].pid; startTicks = $State[$name].startTicks }
            Set-Content -LiteralPath $pidFile -Value $State[$name].pid -Encoding ASCII
        } else {
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        }
    }
    Set-Content -LiteralPath $script:StateFile -Value ($out | ConvertTo-Json) -Encoding UTF8
}

# A tracked entry is live only if the PID still exists with the same start time
# and its command line still references this project (guards against PID reuse).
function Test-TrackedAlive($Entry) {
    if ($null -eq $Entry) { return $false }
    $info = Get-ProcessInfo $Entry.pid
    if ($null -eq $info) { return $false }
    if ((Get-ProcessStartTicks $info) -ne $Entry.startTicks) { return $false }
    return (Test-CommandLineInProject $info)
}

# ---------------------------------------------------------------- Mutex

function Enter-LauncherLock([int]$TimeoutMs) {
    $hash = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA1]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:ProjectRoot.ToLowerInvariant()))
    ).Replace('-', '').Substring(0, 16)
    $mutex = New-Object System.Threading.Mutex($false, "Local\AuraplexLauncher-$hash")
    try {
        if ($mutex.WaitOne($TimeoutMs)) { return $mutex }
    } catch [System.Threading.AbandonedMutexException] {
        return $mutex
    }
    $mutex.Dispose()
    return $null
}

function Test-PathIsCmdSafe([string]$Path) {
    return ($Path.IndexOf('%') -lt 0 -and $Path.IndexOf('"') -lt 0)
}
