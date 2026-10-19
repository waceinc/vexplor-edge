# VEXPLOR Edge - install on Windows with one command (docs/install.md, Windows). get.ps1 downloads the package and runs this.
# Windows PowerShell 5.1 or later, in an elevated window (Run as administrator):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Server https://aas.example.com -Code 7KQ4-M2XD-9PRT
#       [-Proxy http://proxy:3128] [-CaFile corp-ca.pem] [-CredentialsFile credentials.json] [-Name "Line 1"] [-NoService]
#   ... -File .\install.ps1 -Upgrade              # replace the program, keep registration and edge.json, restart
#   ... -File "C:\Program Files\VEXPLOR Edge\install.ps1" -Uninstall [-Purge]   # -Purge also deletes key and queue
#
# Installs the program to "C:\Program Files\VEXPLOR Edge", keeps configuration, key, queue and logs in
# "C:\ProgramData\VEXPLOR Edge" (SYSTEM and Administrators full, the service account LocalService reads the
# configuration and writes only state\ and logs\), registers with the one-time code and starts the Windows service
# "vexplor-edge" (automatic, delayed start; restarted after a failure). It reads equipment only after a person approves
# the read list on the server.
#
# Important: the service is run by WinSW (vexplor-edge-service.exe, MIT) because Node cannot answer the Windows service
#    manager itself - a plain executable registered with sc.exe is ended after 30 s (error 1053). The account, the start
#    type and the restart rules are then set here through the service manager (CIM, sc.exe), not left to WinSW, so they
#    are the same whatever WinSW's configuration format does.
# Important: accounts are given by SID (S-1-5-18 SYSTEM, S-1-5-32-544 Administrators, S-1-5-19 LocalService) - the names
#    are translated on non-English Windows and icacls would fail there.
# Important: files are written as UTF-8 without a byte order mark. Windows PowerShell 5.1 adds one with
#    "Set-Content -Encoding UTF8"; the collector strips it since 1.2.0, older versions would refuse the file.
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$Server,
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$Code,
  [Parameter(ParameterSetName = 'Install')][string]$Proxy = '',
  [Parameter(ParameterSetName = 'Install')][string]$CaFile = '',
  [Parameter(ParameterSetName = 'Install')][string]$CredentialsFile = '',
  [Parameter(ParameterSetName = 'Install')][string]$Name = $env:COMPUTERNAME,
  [Parameter(ParameterSetName = 'Install')][switch]$NoService,
  [Parameter(ParameterSetName = 'Upgrade', Mandatory = $true)][switch]$Upgrade,
  [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
  [Parameter(ParameterSetName = 'Uninstall')][switch]$Purge
)
$ErrorActionPreference = 'Stop'

$ServiceId = 'vexplor-edge'
$program = Join-Path $env:ProgramFiles 'VEXPLOR Edge'
$data = Join-Path $env:ProgramData 'VEXPLOR Edge'
$config = Join-Path $data 'edge.json'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding $false

function Fail([string]$message) { Write-Host "vexplor-edge: $message" -ForegroundColor Red; exit 1 }

# Native commands report failure by exit code only - checked after every one
function Invoke-Checked([string]$what, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)" }
}

function Stop-EdgeService {
  $service = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceId -Force
    # The program file stays locked until the process has really ended
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }
  return $service
}

function Copy-Program([string]$from) {
  foreach ($file in 'vexplor-edge.exe', 'vexplor-edge-service.exe', 'vexplor-edge-service.xml', 'install.ps1', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt', 'sbom.cdx.json') {
    $source = Join-Path $from $file
    if (-not (Test-Path -LiteralPath $source)) { Fail "$file is missing from the package - download it again" }
    Copy-Item -LiteralPath $source -Destination $program -Force
  }
  Copy-Item -LiteralPath (Join-Path $from 'licenses') -Destination $program -Recurse -Force
}

function Set-EdgeService {
  # LocalService: no password, no network credentials, no rights on the PC beyond what is granted below
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceId'"
  $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' }
  if ($result.ReturnValue -ne 0) { Fail "setting the service account failed (Win32_Service.Change $($result.ReturnValue))" }
  Invoke-Checked 'sc.exe config' { sc.exe config $ServiceId start= delayed-auto | Out-Null }
  # Restart 10 s after the first two failures, 60 s after later ones; the count resets after a day without failure
  Invoke-Checked 'sc.exe failure' { sc.exe failure $ServiceId reset= 86400 actions= restart/10000/restart/10000/restart/60000 | Out-Null }
  # Also when the program ends with an error code while the service reports a normal stop
  Invoke-Checked 'sc.exe failureflag' { sc.exe failureflag $ServiceId 1 | Out-Null }
}

function Start-EdgeService {
  Start-Service -Name $ServiceId
  (Get-Service -Name $ServiceId).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
}

$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'run this in an elevated PowerShell (right-click, Run as administrator)'
}

if ($PSCmdlet.ParameterSetName -eq 'Uninstall') {
  $service = Stop-EdgeService
  if ($service) {
    $wrapper = Join-Path $program 'vexplor-edge-service.exe'
    if (Test-Path -LiteralPath $wrapper) { Invoke-Checked 'removing the service' { & $wrapper uninstall | Out-Null } }
    else { Invoke-Checked 'sc.exe delete' { sc.exe delete $ServiceId | Out-Null } }
  }
  if (Test-Path -LiteralPath $program) { Remove-Item -LiteralPath $program -Recurse -Force }
  if ($Purge) {
    if (Test-Path -LiteralPath $data) { Remove-Item -LiteralPath $data -Recurse -Force }
    Write-Host 'Removed the service, the program, the configuration, the key and the queue.'
  } else {
    Write-Host "Removed the service and the program. Configuration, key and queue are kept in $data (-Purge deletes them)."
  }
  Write-Host 'Revoke this collector on the server as well.'
  exit 0
}

if ($PSCmdlet.ParameterSetName -eq 'Upgrade') {
  if (-not (Test-Path -LiteralPath $config)) { Fail "not installed ($config is missing) - install with -Server and -Code" }
  $service = Stop-EdgeService
  Copy-Program $here
  if ($service) { Set-EdgeService; Start-EdgeService }
  $version = & (Join-Path $program 'vexplor-edge.exe') --version
  Write-Host "Upgraded to $version. Registration, approval and edge.json are unchanged."
  exit 0
}

# The code and the server go into a JSON file and a command line - refuse what would need escaping, like install.sh
foreach ($value in $Server, $Code, $Proxy, $Name) {
  if ($value -match '["\\]') { Fail "quotes and backslashes are not allowed: $value" }
}

$service = Stop-EdgeService
New-Item -ItemType Directory -Force -Path $program, $data, (Join-Path $data 'state'), (Join-Path $data 'logs') | Out-Null
Copy-Program $here

# Configuration readable by the service, written only by administrators; state and logs writable by the service
Invoke-Checked 'icacls (data)' { icacls $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null }
foreach ($writable in 'state', 'logs') {
  Invoke-Checked "icacls ($writable)" { icacls (Join-Path $data $writable) /grant:r '*S-1-5-19:(OI)(CI)M' | Out-Null }
}

$settings = [ordered]@{ server = $Server; stateDir = (Join-Path $data 'state'); name = $Name }
if ($Proxy) { $settings.proxy = $Proxy }
if ($CaFile) { Copy-Item -LiteralPath $CaFile -Destination (Join-Path $data 'ca.pem') -Force; $settings.caFile = 'ca.pem' }
if ($CredentialsFile) { Copy-Item -LiteralPath $CredentialsFile -Destination (Join-Path $data 'credentials.json') -Force; $settings.credentialsFile = 'credentials.json' }
[System.IO.File]::WriteAllText($config, ($settings | ConvertTo-Json), $utf8)

$edge = Join-Path $program 'vexplor-edge.exe'
Invoke-Checked 'registration' { & $edge register --config $config --code $Code }
# Registered as the administrator - the files it made inherit the service account's rights from state\; set them once
# more in case a folder was made before the rights above
Invoke-Checked 'icacls (state)' { icacls (Join-Path $data 'state') /grant:r '*S-1-5-19:(OI)(CI)M' /T | Out-Null }

if ($NoService) {
  Write-Host "Installed (no service): `"$edge`" run --config `"$config`""
} else {
  if (-not $service) {
    Invoke-Checked 'registering the service' { & (Join-Path $program 'vexplor-edge-service.exe') install | Out-Null }
  }
  Set-EdgeService
  Start-EdgeService
  Write-Host "Installed and started the service '$ServiceId' (VEXPLOR Edge). Logs: $data\logs"
  Write-Host "  Get-Service $ServiceId   /   Get-Content -Wait `"$data\logs\vexplor-edge-service.out.log`""
}
Write-Host "Done. Open the server's `"Remote collectors`" screen: this PC shows as Receiving once values arrive."
Write-Host 'If the list was not approved with the command, approve it there - it reads nothing before that.'
