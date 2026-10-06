<#
  ENCODING: this file is UTF-8 *with* a BOM, on purpose — do not strip it.
  Windows PowerShell 5.1 (the `powershell.exe` on every Windows box) decodes a
  BOM-less .ps1 as the system ANSI code page; the em dashes in the messages below
  then eat one byte too many, one of the double quotes disappears, and the parser
  fails with "Unexpected token '}'". Measured 2026-09-28. If you ever must drop
  the BOM, make this file pure ASCII at the same time.

.SYNOPSIS
  Install (or refresh) dsh-windows-notifier into one — or every — DSH profile.

.DESCRIPTION
  This script used to copy the deployable files into
  `$DSH_HOME\profiles\node_modules\<name>`, described as "the resolution root
  shared by every profile". Current DSH (0.1.7-rc.2, Desktop) does not resolve
  packages from there: it resolves from the Desktop installation and from the
  ACTIVE PROFILE's own `node_modules`, and reports

    dsh-plugin-desktop: cannot resolve package "dsh-windows-notifier" from the
    Desktop installation or active Profile

  when it cannot (the error is constructed in the Desktop app's
  `resources\app\lib\package-overlay-*.js`). The copy therefore produced exactly
  the failure the old comment here tried to prevent: repository fixed, running
  environment still broken — plus a `failed to import` line from the loader.

  This script now does what the plugin market does: it packs the repository and
  installs that tarball with DSH's own CLI. `dsh plugin --profile <p> add
  "file:<tgz>"` adds the profile dependency and runs pnpm inside the profile
  directory, so the package lands in that profile's own `node_modules` as a real
  directory (a `link:` to this checkout would not have its dependencies
  installed, and the resulting symlink is not the shape the resolver accepts).

  Two consequences worth knowing before running it:

  - pnpm considers a local tarball "already installed" when its path AND version
    are unchanged, even when the file now holds different code. Measured
    2026-09-27: a plain `add` printed `Already up to date` and the profile copy's
    SHA256 did not change; `remove` followed by `add` did replace it. So a
    package that is already a dependency is removed first — that is what makes
    "I changed the source and re-ran the script" actually reach the environment.
  - The version in package.json is not bumped here. Bumping is not required (the
    remove/add above handles content changes), but it is the conventional way to
    make a change legible.

  The package also declares its own bundle patch (`dsh.bundle.patch` ->
  `cordis.patch.yml`). That bundle layer is what contributes the
  `windows-notifier` row the Plugins page renders — and therefore what the Host's
  configuration forms are addressed by — so nothing has to be inserted into a
  `cordis.patch.yml` by hand any more.

  Installing is not the same as selecting. `dsh plugin add` forwards to pnpm, and
  the CLI then reconciles installed bundle declarations: a dependency whose
  manifest declares `dsh.bundle` is appended to `dsh.profile.bundles`
  (`reconcileProfilePlugins` in `@deepseek-ai/dsh-app-boot`). Measured
  2026-09-28: that write can land a moment AFTER the command has already
  returned, so do not read the manifest back and trust it. A dependency that is
  not in that list mounts nothing at all — no row, no configuration page — so
  this script verifies the selection and writes it itself when it is missing.
  Two more things follow:

  - The `desktop` profile is skipped: the launcher refuses it by name for every
    `dsh plugin` call ("profile \"desktop\" is managed exclusively by the
    Electron application", `rejectElectronProfile` in
    `@deepseek-ai/dsh/lib/bin.js`). Update that one from the Desktop app's plugin
    market — it runs the same install plus the bundle selection.
  - Installing into a profile whose host is RUNNING can fail outright: pnpm swaps
    directories, and Windows refuses to remove one that the live process still
    has open (`os error 32`, "another program is using this file"). Stop that
    host, then re-run.

  It also warns when `$DSH_HOME\cordis.patch.yml` still configures this plugin.
  That machine-level layer is applied after every profile, its `config` replaces
  the row's whole config object, and the Host refuses a form write whose composed
  result a home patch would shadow — a leftover row produces a configuration page
  that cannot save.

  Restart DSH afterwards: the loader caches an ES module by its resolved path, so
  replaced code is never re-imported into a running profile. A bundle selection
  and a `config:` edit are picked up by profiles with `patchReload: live`, but
  replaced `src/` code is not.

.PARAMETER Profile
  Install into this one profile only. Default: every profile under
  `$DSH_HOME\profiles` that has a package.json, because each profile selects the
  bundle for itself — there is no machine-level row to inherit any more.

.PARAMETER DshHome
  DSH user root. Default: $env:DSH_HOME, falling back to $HOME\.dsh.

.PARAMETER Dsh
  The dsh command, as an APPLICATION (a function or alias of the same name is
  not usable: this script invokes it through .Path — see the lookup below).
  Desktop's shim
  (%APPDATA%\DSH Desktop\host-commands\<profile>\generations\*\bin\dsh.cmd) is
  usually on PATH inside a DSH session; an npx install has the same name. It is
  usually NOT on PATH in the shell you are left with after stopping DSH — which
  is exactly when this script runs — so expect to pass the path.

.EXAMPLE
  powershell -NoProfile -File scripts\sync-to-profile.ps1              # every profile
  powershell -NoProfile -File scripts\sync-to-profile.ps1 -Profile web # one profile

  `powershell` (5.1) ships with Windows and needs no install; `pwsh` (7+) works
  the same where it is installed.
#>
[CmdletBinding()]
param(
  [string] $Profile,
  [string] $DshHome,
  [string] $Dsh = 'dsh'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repo 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "not a dsh-windows-notifier checkout: $repo has no package.json"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$name = $manifest.name
$version = $manifest.version

$root = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if (-not [System.IO.Path]::IsPathRooted($root)) { $root = Join-Path (Get-Location).Path $root }
$root = [System.IO.Path]::GetFullPath($root)

# Application only, and called through .Path: in some sessions the name `dsh` is
# shadowed by a function of the same name (Get-Command returns Function with an
# empty .Source), and `& $cmd.Source …` then fails with "The expression after '&'
# in a pipeline element produced an object that was not valid".
# The candidate list is tested for emptiness before it is indexed, instead of the
# idiomatic `@(...)[0]`: under `Set-StrictMode -Version Latest` an out-of-range
# index is an ERROR rather than $null, so "dsh is not on PATH" surfaced as
# IndexOutOfRangeException and the message below never printed (measured
# 2026-09-28, Windows PowerShell 5.1, from a shell outside any DSH session).
$dshCandidates = @(Get-Command $Dsh -CommandType Application -ErrorAction SilentlyContinue)
$dshCmd = $null
if ($dshCandidates.Count -gt 0) { $dshCmd = $dshCandidates[0] }
if (-not $dshCmd) {
  $reason = "dsh executable not found ($Dsh)."
  $shadow = @(Get-Command $Dsh -ErrorAction SilentlyContinue)
  if ($shadow.Count -gt 0) {
    $reason += ' The name resolves to a ' + $shadow[0].CommandType + ' named ' + $Dsh +
        ', which cannot be invoked as an application.'
  }
  $reason += ' Desktop''s shim lives at %APPDATA%\DSH Desktop\host-commands\<profile>' +
      '\generations\*\bin\dsh.cmd (usually on PATH inside a DSH session);' +
      ' otherwise pass -Dsh <path to dsh.cmd>.'
  $shims = @(Get-ChildItem -Path (Join-Path $env:APPDATA 'DSH Desktop\host-commands\*\generations\*\bin\dsh.cmd') -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending)
  if ($shims.Count -gt 0) {
    $reason += ' One is installed at ' + $shims[0].FullName +
        ' (pass it with -Dsh; a standalone CLI from the same DSH install works just as well).'
  }
  throw $reason
}

# Pack. The tarball's contents come from package.json's `files` field — the same
# field npm publishes — so the installed copy and a published install agree.
$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$tgz = Join-Path $dist "$name-$version.tgz"
if (Test-Path -LiteralPath $tgz) { Remove-Item -LiteralPath $tgz -Force }
Write-Host "packing $name@$version …"
& npm pack $repo --pack-destination $dist
if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit $LASTEXITCODE)" }
if (-not (Test-Path -LiteralPath $tgz)) { throw "npm pack did not produce $tgz" }
# pnpm's file: specifier takes forward slashes.
$spec = 'file:' + $tgz.Replace('\', '/')

$profilesRoot = Join-Path $root 'profiles'
if ($Profile) {
  $targets = @($Profile)
} else {
  $targets = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne 'node_modules' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'package.json')) } |
      Select-Object -ExpandProperty Name)
}
if ($targets.Count -eq 0) { throw "no profile with a package.json under $profilesRoot" }

# The row now comes from the bundle layer, so a machine-level row for the same id
# is not a fallback but a conflict: it is applied after every profile, replaces
# the row's whole config object, and makes the Plugins page's configuration page
# refuse every save.
$homePatch = Join-Path $root 'cordis.patch.yml'
if (Test-Path -LiteralPath $homePatch) {
  # Comment lines are ignored on purpose: this layer's own header explains where
  # the row went, and naming the plugin in prose is not a configuration.
  $hits = @(Select-String -LiteralPath $homePatch -Pattern 'windows-notifier' -ErrorAction SilentlyContinue |
      Where-Object { $_.Line -notmatch '^\s*#' })
  if ($hits.Count -gt 0) {
    Write-Warning "$homePatch still configures this plugin (line $($hits[0].LineNumber)). Delete that row: the bundle layer contributes it now, and a home-level row for the same id makes the configuration form unable to save."
  }
}

$skipped = @()
$synced = @()
foreach ($p in $targets) {
  $profileDir = Join-Path $profilesRoot $p
  if (-not (Test-Path -LiteralPath $profileDir)) { throw "no such profile directory: $profileDir" }

  # The launcher refuses this one by name, hardcoded:
  #   profile "desktop" is managed exclusively by the Electron application
  # (rejectElectronProfile in @deepseek-ai/dsh/lib/bin.js, applied to every
  # `dsh plugin` invocation). The Desktop app runs the same pnpm and the same
  # in-process package-manager install, so its own plugin market is the only
  # supported way in — for the row AND for its bundle selection.
  if ($p -ieq 'desktop') {
    Write-Warning "$p : skipped — this profile belongs to the DSH Desktop application. Install or update it from that app's plugin market (it does the same pnpm install plus the bundle selection)."
    $skipped += $p
    continue
  }

  $deps = @()
  $profileManifest = Join-Path $profileDir 'package.json'
  if (Test-Path -LiteralPath $profileManifest) {
    $parsed = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
    if ($parsed.PSObject.Properties.Name -contains 'dependencies' -and $parsed.dependencies) {
      # An explicit loop, not `$parsed.dependencies.PSObject.Properties.Name`: on
      # Windows PowerShell 5.1 an empty `"dependencies": {}` makes member
      # enumeration throw "The property 'Name' cannot be found on this object"
      # under `Set-StrictMode -Version Latest` (measured on the headless profile).
      foreach ($prop in @($parsed.dependencies.PSObject.Properties)) { $deps += $prop.Name }
    }
  }

  if ($deps -contains $name) {
    Write-Host "$p : $name is already a dependency — removing first (otherwise pnpm keeps the old files)"
    & $dshCmd.Path plugin --profile $p remove $name
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin --profile $p remove $name failed (exit $LASTEXITCODE)" }
  }
  Write-Host "$p : installing $name@$version"
  & $dshCmd.Path plugin --profile $p add $spec
  if ($LASTEXITCODE -ne 0) {
    throw "dsh plugin --profile $p add failed (exit $LASTEXITCODE). If this profile's host is running, stop it and re-run: pnpm cannot swap a directory Windows still has open (os error 32)."
  }

  $installed = Join-Path $profileDir "node_modules\$name"
  if (Test-Path -LiteralPath $installed) {
    Write-Host "  -> $installed"
  } else {
    Write-Warning "  package not found at $installed after add — the profile will report a failed import"
  }
  $synced += $p

  # Verify the bundle selection, and repair it when it is missing. Installing is
  # not selecting: a dependency that is not in `dsh.profile.bundles` mounts
  # nothing at all (no row, no configuration page). The CLI's post-install
  # reconciliation normally appends it (`reconcileProfilePlugins` in
  # @deepseek-ai/dsh-app-boot), but that write was measured to land a moment
  # after `dsh plugin add` returned, so reading the manifest back is not proof.
  # The repair is the same manifest write the in-process package-manager
  # operation performs: read it, keep everything, append the name.
  $installedManifest = Join-Path $installed 'package.json'
  $declaresBundle = $false
  if (Test-Path -LiteralPath $installedManifest) {
    $meta = Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json
    $metaDsh = $meta.PSObject.Properties['dsh']
    if ($metaDsh) { $declaresBundle = $null -ne $metaDsh.Value.PSObject.Properties['bundle'] }
  }
  if (-not $declaresBundle) {
    Write-Warning "  $name declares no dsh.bundle — installed as a plain dependency, not a profile layer"
  } else {
    $manifest = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
    $dshProp = $manifest.PSObject.Properties['dsh']
    $profileProp = if ($dshProp) { $dshProp.Value.PSObject.Properties['profile'] } else { $null }
    if (-not $profileProp) {
      Write-Warning "  $profileManifest has no dsh.profile — add `"bundles`": [`"$name`"] to it yourself"
    } else {
      $bundlesProp = $profileProp.Value.PSObject.Properties['bundles']
      $bundles = if ($bundlesProp -and $bundlesProp.Value) { @($bundlesProp.Value) } else { @() }
      if ($bundles -contains $name) {
        Write-Host "  -> already selected in dsh.profile.bundles"
      } else {
        $profileProp.Value.bundles = @($bundles + $name)
        [System.IO.File]::WriteAllText($profileManifest, ($manifest | ConvertTo-Json -Depth 20) + "`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "  -> selected in dsh.profile.bundles"
      }
    }
  }
}

$legacy = Join-Path $profilesRoot "node_modules\$name"
Write-Host ''
Write-Host "synced $name@$version into: $(if ($synced.Count -eq 0) { '(no profile)' } else { $synced -join ', ' })"
if ($skipped.Count -gt 0) {
  Write-Host "not touched: $($skipped -join ', ') — Electron-managed, update those from the Desktop app" -ForegroundColor Yellow
}
if (Test-Path -LiteralPath $legacy) {
  Write-Host "legacy copy (this DSH version no longer resolves packages from there — safe to delete): $legacy" -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Restart DSH: a replaced module is not re-imported into a running profile.' -ForegroundColor Yellow
Write-Host 'A running profile can also refuse the swap outright (pnpm: "another program is using this file"); stop that host first.' -ForegroundColor Yellow