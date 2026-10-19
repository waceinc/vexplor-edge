# The Windows package installed as a real service on a CI runner (.github/workflows/ci.yml, job "windows") - install,
# run as LocalService, send to a stand-in server, restart after the program is killed, stop, upgrade, uninstall.
# Windows PowerShell 5.1, elevated. A Mac or Linux machine cannot run this; the CI result is the measurement.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\windows\service-smoke.ps1 -Package out\build\win-x64\vexplor-edge-<version>
param([Parameter(Mandatory = $true)][string]$Package)
$ErrorActionPreference = 'Stop'

$ServiceId = 'vexplor-edge'
$program = Join-Path $env:ProgramFiles 'VEXPLOR Edge'
$data = Join-Path $env:ProgramData 'VEXPLOR Edge'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('edge-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$Package = (Resolve-Path -LiteralPath $Package).Path
$shell = (Get-Process -Id $PID).Path

function Check([bool]$condition, [string]$what) {
  if (-not $condition) { throw "[FAIL] $what" }
  Write-Host "[OK] $what"
}

function Wait-Until([scriptblock]$condition, [int]$seconds, [string]$what) {
  $end = (Get-Date).AddSeconds($seconds)
  while (-not (& $condition)) {
    if ((Get-Date) -gt $end) { throw "[FAIL] $what (not within $seconds s)" }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "[OK] $what"
}

function Invoke-Installer([string]$installer, [string[]]$arguments) {
  & $shell -NoProfile -ExecutionPolicy Bypass -File $installer @arguments
  if ($LASTEXITCODE -ne 0) { throw "[FAIL] $installer $arguments (exit code $LASTEXITCODE)" }
}

$portFile = Join-Path $work 'port'
$server = Start-Process -FilePath node -ArgumentList @((Join-Path $PSScriptRoot 'fake-server.mjs'), $portFile) -PassThru -NoNewWindow
try {
  Wait-Until { Test-Path -LiteralPath $portFile } 30 'stand-in server started'
  $base = "http://127.0.0.1:$((Get-Content -LiteralPath $portFile -Raw).Trim())"
  $seen = { Invoke-RestMethod -UseBasicParsing -Uri "$base/_seen" }

  Invoke-Installer (Join-Path $Package 'install.ps1') @('-Server', $base, '-Code', 'CI00-TEST-CODE', '-Name', 'windows ci')
  Check ((& $seen).register -eq 1) 'registered once with the code'

  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceId'"
  Check ($service.State -eq 'Running') 'service running'
  Check ($service.StartName -eq 'NT AUTHORITY\LocalService') "runs as LocalService ($($service.StartName))"
  Check ($service.StartMode -eq 'Auto') 'starts automatically'
  if ($null -ne $service.DelayedAutoStart) { Check ([bool]$service.DelayedAutoStart) 'delayed start' }
  $failure = (sc.exe qfailure $ServiceId) -join "`n"
  Check ($failure -match 'RESTART') 'restarts after a failure'

  $config = [System.IO.File]::ReadAllBytes((Join-Path $data 'edge.json'))
  Check (-not ($config[0] -eq 0xEF -and $config[1] -eq 0xBB -and $config[2] -eq 0xBF)) 'edge.json has no byte order mark'
  Check (Test-Path -LiteralPath (Join-Path $data 'state\identity.json')) 'key stored in state'
  $users = (Get-Acl -LiteralPath (Join-Path $data 'state')).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-545' }
  Check ($null -eq $users) 'Users have no access to the key and queue'

  Wait-Until { (& $seen).batches -ge 1 } 150 'a batch written to the queue and sent by the service'
  $log = Join-Path $data 'logs\vexplor-edge-service.out.log'
  Wait-Until { (Test-Path -LiteralPath $log) -and ((Get-Content -LiteralPath $log -Raw) -match 'running as dev_windows_ci') } 30 'log written to ProgramData'

  # The program dies - the service manager starts it again (10 s, sc failure)
  $before = ([regex]::Matches((Get-Content -LiteralPath $log -Raw), 'running as ')).Count
  Get-Process -Name 'vexplor-edge' | Stop-Process -Force
  Wait-Until { ([regex]::Matches((Get-Content -LiteralPath $log -Raw), 'running as ')).Count -gt $before } 90 'started again after the program was killed'

  Stop-Service -Name $ServiceId
  (Get-Service -Name $ServiceId).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  Check ($null -eq (Get-Process -Name 'vexplor-edge' -ErrorAction SilentlyContinue)) 'stopped with the service (Ctrl+C), no program left running'

  Invoke-Installer (Join-Path $Package 'install.ps1') @('-Upgrade')
  Check ((Get-Service -Name $ServiceId).Status -eq 'Running') 'upgrade restarted the service'
  Check ((& $seen).register -eq 1) 'upgrade kept the registration'
  $version = & (Join-Path $program 'vexplor-edge.exe') --version
  Check ($version -match '^vexplor-edge \d+\.\d+\.\d+') "installed program answers --version ($version)"

  Copy-Item -LiteralPath (Join-Path $program 'install.ps1') -Destination $work
  Invoke-Installer (Join-Path $work 'install.ps1') @('-Uninstall', '-Purge')
  Check ($null -eq (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue)) 'service removed'
  Check (-not (Test-Path -LiteralPath $program) -and -not (Test-Path -LiteralPath $data)) 'program and data removed (-Purge)'
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
