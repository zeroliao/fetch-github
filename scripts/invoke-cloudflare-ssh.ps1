[CmdletBinding()]
param(
    [string]$HostAlias = 'sub2api-cf',
    [string]$AccessUrl = 'https://ssh.zero007.chat',
    [string]$RemoteCommand = '',
    [string[]]$SshOption = @(),
    [ValidateRange(0, 30)]
    [int]$RetryDelaySeconds = 2
)

$ErrorActionPreference = 'Stop'

function Protect-CommandOutput {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ''
    }

    $protected = $Text
    $protected = [regex]::Replace(
        $protected,
        '(?i)\bBearer\s+[^\s]+',
        'Bearer [REDACTED]'
    )
    $protected = [regex]::Replace(
        $protected,
        '\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b',
        '[REDACTED_JWT]'
    )
    $protected = [regex]::Replace(
        $protected,
        '(?i)(postgres(?:ql)?://[^:\s/@]+:)[^@\s]+(@)',
        '$1[REDACTED]$2'
    )

    return $protected.Trim()
}

function Invoke-SshAttempt {
    param(
        [string]$SshExecutable,
        [string[]]$Options,
        [string]$Alias,
        [string]$Command
    )

    $sshArguments = @($Options) + @($Alias)
    if (-not [string]::IsNullOrWhiteSpace($Command)) {
        $sshArguments += $Command
    }

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Native SSH writes connection errors to stderr; capture them for classification.
        $ErrorActionPreference = 'Continue'
        $output = @(& $SshExecutable @sshArguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
    }
}

function Test-CloudflareAccessFailure {
    param([string]$Text)

    $signals = @(
        'cloudflare',
        'failed to get app info',
        'access login',
        'connection closed by unknown port',
        'connection reset',
        'unexpected eof',
        'eof'
    )

    foreach ($signal in $signals) {
        if ($Text.IndexOf($signal, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }

    return $false
}

$sshPath = (Get-Command 'ssh.exe' -ErrorAction Stop).Source
$cloudflaredPath = (Get-Command 'cloudflared.exe' -ErrorAction Stop).Source

$firstAttempt = Invoke-SshAttempt `
    -SshExecutable $sshPath `
    -Options $SshOption `
    -Alias $HostAlias `
    -Command $RemoteCommand

if ($firstAttempt.ExitCode -eq 0) {
    if (-not [string]::IsNullOrWhiteSpace($firstAttempt.Output)) {
        Write-Output (Protect-CommandOutput -Text $firstAttempt.Output)
    }
    exit 0
}

if (-not (Test-CloudflareAccessFailure -Text $firstAttempt.Output)) {
    $safeOutput = Protect-CommandOutput -Text $firstAttempt.Output
    if (-not [string]::IsNullOrWhiteSpace($safeOutput)) {
        Write-Error $safeOutput
    }
    exit $firstAttempt.ExitCode
}

Write-Host 'Cloudflare Access may have expired. Opening the browser for re-authorization.'
Write-Host 'Complete the login in the browser; SSH will be retried automatically.'

# Make the Access application visible even when cloudflared cannot discover a
# default browser in the current PowerShell host.
try {
    Start-Process -FilePath $AccessUrl | Out-Null
} catch {
    Write-Host 'The default browser could not be started automatically.'
    Write-Host ("Open this URL manually: " + $AccessUrl)
}

$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    # cloudflared may emit a JWT even with --quiet; discard every output stream.
    & $cloudflaredPath access login $AccessUrl --quiet --auto-close *> $null
    $loginExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($loginExitCode -ne 0) {
    Write-Error "Cloudflare Access re-authorization failed (exit code: $loginExitCode)."
    exit $loginExitCode
}

if ($RetryDelaySeconds -gt 0) {
    Start-Sleep -Seconds $RetryDelaySeconds
}

$secondAttempt = Invoke-SshAttempt `
    -SshExecutable $sshPath `
    -Options $SshOption `
    -Alias $HostAlias `
    -Command $RemoteCommand

if ($secondAttempt.ExitCode -eq 0) {
    if (-not [string]::IsNullOrWhiteSpace($secondAttempt.Output)) {
        Write-Output (Protect-CommandOutput -Text $secondAttempt.Output)
    }
    exit 0
}

$safeOutput = Protect-CommandOutput -Text $secondAttempt.Output
if (-not [string]::IsNullOrWhiteSpace($safeOutput)) {
    Write-Error $safeOutput
}
Write-Error 'SSH is still unavailable after Cloudflare Access re-authorization.'
exit $secondAttempt.ExitCode
