<#
.SYNOPSIS
  Refresh the profile-level copy of dsh-windows-notifier from this repository.

.DESCRIPTION
  Deploying by copy — rather than by a directory junction — leaves the profile
  holding a frozen snapshot: a fix committed here does NOT reach the running
  environment, and nothing says so. The plugin then keeps behaving exactly like
  the version it was copied from, which is the "the repo is fixed but the
  environment still misbehaves" failure.

  Run this after every source change, then restart the DSH profile: DSH's
  loader caches an ES module by its resolved path, so a replaced file at the
  same path is never re-imported.

  The set of files copied is read from package.json's `files` field, which is
  also what npm publishes, so the deployed copy and a real install agree.

.PARAMETER ProfilesRoot
  The directory that holds every profile plus their shared node_modules.
  Defaults to $env:DSH_HOME\profiles (falling back to $HOME\.dsh\profiles).

.PARAMETER Name
  The package directory name to write.

.EXAMPLE
  pwsh -File scripts/sync-to-profile.ps1
#>
[CmdletBinding()]
param(
  [string] $ProfilesRoot = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }) 'profiles'),
  [string] $Name = 'dsh-windows-notifier'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repo 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "not a dsh-windows-notifier checkout: $repo has no package.json"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$entries = @($manifest.files) + @($manifest.main -replace '/[^/]+$', '') + 'package.json' | Select-Object -Unique
$target = Join-Path $ProfilesRoot "node_modules\$Name"

# A junction already points at this repository: there is nothing to copy, and
# deleting it would break the link.
if (Test-Path -LiteralPath $target) {
  $existing = Get-Item -LiteralPath $target -Force
  if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
    Write-Host "$target is a $($existing.LinkType) to $($existing.Target); it already follows this repository — nothing to sync."
    return
  }
}

$missing = @($entries | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repo $_)) })
if ($missing.Count -gt 0) {
  Write-Warning "package.json lists entries that do not exist and will be skipped: $($missing -join ', ')"
}
$copy = @($entries | Where-Object { Test-Path -LiteralPath (Join-Path $repo $_) })

New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Path $target | Out-Null
foreach ($entry in $copy) {
  Copy-Item -LiteralPath (Join-Path $repo $entry) -Destination $target -Recurse -Force
}

$version = $manifest.version
Write-Host "synced $Name@$version -> $target"
Write-Host "  entries: $($copy -join ', ')"
Write-Host ''
Write-Host 'A restart is required: DSH caches the module by resolved path, so this' -ForegroundColor Yellow
Write-Host 'replacement is not re-imported into an already-running profile.' -ForegroundColor Yellow