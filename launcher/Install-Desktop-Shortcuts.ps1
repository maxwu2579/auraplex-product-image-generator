# Creates two desktop shortcuts for the current user (no administrator rights needed):
#   "Auraplex Image Tool"  -> launcher\Start-Auraplex.ps1
#   "Stop Auraplex Tool"   -> launcher\Stop-Auraplex.ps1
# Re-running overwrites the two shortcuts. Delete them from the desktop to uninstall.
# Run once:  powershell -NoProfile -ExecutionPolicy Bypass -File launcher\Install-Desktop-Shortcuts.ps1
# Option: -Destination <folder>  create the shortcuts somewhere other than the desktop.

param([string]$Destination = [Environment]::GetFolderPath('Desktop'))

$ErrorActionPreference = 'Stop'

$launcherDir = (Resolve-Path -LiteralPath $PSScriptRoot).ProviderPath
$projectRoot = Split-Path -Parent $launcherDir
$desktop = $Destination
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell = New-Object -ComObject WScript.Shell

$shortcuts = @(
    @{ Name = 'Auraplex Image Tool'; Script = 'Start-Auraplex.ps1'; Icon = "$env:SystemRoot\System32\imageres.dll,108"; Description = 'Start Auraplex Image Tool' },
    @{ Name = 'Stop Auraplex Tool'; Script = 'Stop-Auraplex.ps1'; Icon = "$env:SystemRoot\System32\shell32.dll,27"; Description = 'Stop Auraplex Image Tool services' }
)

foreach ($item in $shortcuts) {
    $path = Join-Path $desktop ($item.Name + '.lnk')
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $powershell
    $link.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $launcherDir $item.Script) + '"'
    $link.WorkingDirectory = $projectRoot
    $link.WindowStyle = 7   # minimized: avoids a console flash before PowerShell hides itself
    $link.IconLocation = $item.Icon
    $link.Description = $item.Description
    $link.Save()
    Write-Output "Created: $path"
}
