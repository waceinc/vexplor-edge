# VEXPLOR Edge - download, check and install on Windows in one line. This is the command the "Remote collectors"
# screen of VEXPLOR AAS Studio shows, with the server and a one-time code already filled in. Paste it into an elevated
# Command Prompt or PowerShell (Run as administrator):
#
#   powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://github.com/waceinc/vexplor-edge/releases/latest/download/get.ps1))) -Server https://aas.example.com -Code 7KQ4-M2XD-9PRT"
#
#   ... -Server ... -Code ... [-Proxy http://proxy:3128] [-CaFile corp-ca.pem] [-CredentialsFile credentials.json]
#       [-Name "Line 1"] [-NoService]
#   ... -Upgrade [-Proxy ...]           # install this release over an installed one, keep registration and edge.json
#   ... -Uninstall [-Purge]             # remove; -Purge also deletes key and queue
#
# It takes the Windows x64 package from the same release as this script, checks it against that release's SHA256SUMS,
# and runs the installer inside (install.ps1 - every option is passed on). Windows PowerShell 5.1 or later.
#
# Important: no execution policy is changed. This script runs as a script block (execution policy covers script files,
#    not text); only the installer process it starts gets "-ExecutionPolicy Bypass", for that one file.
# Important: TLS 1.2 is switched on for this process - Windows PowerShell 5.1 on Windows 10 / Server 2016 offers only
#    TLS 1.0 by default and GitHub refuses it. The one-line command does the same before fetching this script.
# Important: -Proxy is used for the downloads and written to edge.json for the collector; without it the downloads use
#    the proxy set in Windows (Internet Options), as Invoke-WebRequest does by default.
# Important: ASCII only - Windows PowerShell 5.1 reads a script file without byte order mark in the system code page.
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$Server,
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$Code,
  [Parameter(ParameterSetName = 'Install')][string]$CaFile = '',
  [Parameter(ParameterSetName = 'Install')][string]$CredentialsFile = '',
  [Parameter(ParameterSetName = 'Install')][string]$Name = '',
  [Parameter(ParameterSetName = 'Install')][switch]$NoService,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Upgrade')][string]$Proxy = '',
  [Parameter(ParameterSetName = 'Upgrade', Mandatory = $true)][switch]$Upgrade,
  [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
  [Parameter(ParameterSetName = 'Uninstall')][switch]$Purge
)
$ErrorActionPreference = 'Stop'
# The progress bar makes Invoke-WebRequest many times slower in Windows PowerShell 5.1
$ProgressPreference = 'SilentlyContinue'

$Repository = 'https://github.com/waceinc/vexplor-edge'
$Version = '__EDGE_VERSION__'

# throw, not exit: pasted into an open PowerShell window, exit would close the window with the message in it
function Fail([string]$message) { throw "vexplor-edge: $message" }

if ($PSVersionTable.PSVersion.Major -lt 5) { Fail "Windows PowerShell 5.1 or later is needed (this is $($PSVersionTable.PSVersion))" }
$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($cpu -ne 'AMD64') { Fail "unsupported CPU: $cpu (Windows x64 is supported)" }
$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'run this in an elevated Command Prompt or PowerShell (right-click, Run as administrator)'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# The same PowerShell that runs this (powershell.exe or pwsh.exe) runs the installer, for that one file only
$shell = (Get-Process -Id $PID).Path
function Invoke-Installer([string]$installer, [string[]]$arguments) {
  & $shell -NoProfile -ExecutionPolicy Bypass -File $installer @arguments
  if ($LASTEXITCODE -ne 0) { Fail "the installer stopped (exit code $LASTEXITCODE) - see the message above" }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("vexplor-edge-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  if ($PSCmdlet.ParameterSetName -eq 'Uninstall') {
    $installed = Join-Path $env:ProgramFiles 'VEXPLOR Edge\install.ps1'
    if (-not (Test-Path -LiteralPath $installed)) { Fail 'VEXPLOR Edge is not installed on this PC' }
    # Run from a copy - the installer deletes its own folder
    Copy-Item -LiteralPath $installed -Destination $work
    Invoke-Installer (Join-Path $work 'install.ps1') (@('-Uninstall') + $(if ($Purge) { @('-Purge') } else { @() }))
    return
  }

  $package = "vexplor-edge-$Version-win-x64.zip"
  $base = "$Repository/releases/download/v$Version"
  $web = @{ UseBasicParsing = $true }
  if ($Proxy) { $web.Proxy = $Proxy; $web.ProxyUseDefaultCredentials = $true }
  Write-Host "VEXPLOR Edge $Version (win-x64) - downloading"
  foreach ($file in $package, 'SHA256SUMS') {
    try { Invoke-WebRequest @web -Uri "$base/$file" -OutFile (Join-Path $work $file) }
    catch { Fail "download failed: $base/$file - $($_.Exception.Message)" }
  }
  $expected = ''
  foreach ($line in Get-Content -LiteralPath (Join-Path $work 'SHA256SUMS')) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[1].Trim() -eq $package) { $expected = $parts[0].ToLowerInvariant() }
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work $package)).Hash.ToLowerInvariant()
  if (-not $expected -or $expected -ne $actual) { Fail "$package does not match SHA256SUMS - not installed" }
  Write-Host 'checked against SHA256SUMS'

  Expand-Archive -LiteralPath (Join-Path $work $package) -DestinationPath $work -Force
  $installer = Join-Path $work "vexplor-edge-$Version\install.ps1"

  if ($PSCmdlet.ParameterSetName -eq 'Upgrade') {
    Invoke-Installer $installer @('-Upgrade')
    return
  }
  $arguments = @('-Server', $Server, '-Code', $Code)
  if ($Proxy) { $arguments += @('-Proxy', $Proxy) }
  if ($Name) { $arguments += @('-Name', $Name) }
  # The installer runs in another process whose working folder may differ - files are passed with their full path
  if ($CaFile) { $arguments += @('-CaFile', (Resolve-Path -LiteralPath $CaFile).Path) }
  if ($CredentialsFile) { $arguments += @('-CredentialsFile', (Resolve-Path -LiteralPath $CredentialsFile).Path) }
  if ($NoService) { $arguments += '-NoService' }
  Invoke-Installer $installer $arguments
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
