param(
    [string]$InstallDirectory = (Join-Path $HOME '.local\bin'),
    [string]$ProfilePath,
    [string]$Version = $env:INSHELLISENSE2_VERSION,
    [string]$ReleaseUrl = $env:INSHELLISENSE2_RELEASE_URL
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$repo = 'https://github.com/AriesAlex/inshellisense2'
if (-not $Version) {
    $release = Invoke-RestMethod 'https://api.github.com/repos/AriesAlex/inshellisense2/releases/latest'
    $Version = $release.tag_name
}
if ($Version -notmatch '^v\d') { throw 'Cannot resolve a release version' }
if (-not $ReleaseUrl) { $ReleaseUrl = "$repo/releases/download/$Version" }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($architecture) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported Windows architecture: $architecture" }
}
$asset = "inshellisense2-win32-$arch.zip"
$binaryName = "inshellisense2-win32-$arch.exe"
$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ('inshellisense2-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDirectory -Force | Out-Null
try {
    $archive = Join-Path $tempDirectory $asset
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/$asset" -OutFile $archive
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/SHA256SUMS").Content
    $checksumLine = $checksums -split '\r?\n' | Where-Object { ($_ -split '\s+')[1] -eq $asset }
    $expected = ($checksumLine -split '\s+')[0]
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if (-not $expected -or $actual -ine $expected) { throw 'Release checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $tempDirectory -Force
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    $destination = Join-Path $InstallDirectory 'inshellisense2.exe'
    $previous = Join-Path $tempDirectory 'previous.exe'
    if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination $previous }
    try {
        Copy-Item -LiteralPath (Join-Path $tempDirectory $binaryName) -Destination $destination
    } catch {
        if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $destination }
        throw
    }
    $shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
    $initArguments = @('init', $shell, '--install')
    if ($ProfilePath) { $initArguments += @('--profile', $ProfilePath) }
    & $destination @initArguments
    if ($LASTEXITCODE -ne 0) { throw "Shell initialization failed: $LASTEXITCODE" }
    $env:PATH = $InstallDirectory + [IO.Path]::PathSeparator + $env:PATH
    Write-Host "Installed inshellisense2 $Version. Open a new terminal."
} finally {
    # A running previous executable may stay locked until its terminal closes.
    Get-ChildItem -LiteralPath $tempDirectory -File | ForEach-Object {
        try { [IO.File]::Delete($_.FullName) } catch {}
    }
    try { [IO.Directory]::Delete($tempDirectory) } catch {}
}
