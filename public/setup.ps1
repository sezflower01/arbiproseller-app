# InventorySprint dev environment bootstrap
#
# Usage (from a fresh Windows machine, in PowerShell):
#   irm https://inventorysprint.com/setup.ps1 | iex
#
# What it does:
#   1. Checks for / installs Node.js LTS (via winget)
#   2. Checks for / installs Git (via winget)
#   3. Checks for / installs Claude Code (via npm)
#   4. Clones inventorysprint-app and new-venture-generator into ~\dev
#   5. Runs npm install in each
#
# Both repos are private - cloning will pop a browser window asking you to
# sign in to GitHub (via Git Credential Manager). That's expected.
#
# If any step fails, re-run this script - every step is safe to run again
# (already-installed tools and already-cloned repos are skipped, not
# reinstalled/re-cloned). See the "Manual steps" checklist on the admin
# Dev Environment Setup page for how to do each step by hand instead.

$ErrorActionPreference = "Continue"
$hadFailure = $false

function Write-Step($msg) { Write-Host "" ; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[..] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; $script:hadFailure = $true }
function Test-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# winget installs to machine/user PATH but doesn't update THIS session's
# $env:Path - without this, npm/git installed a moment ago would look
# "missing" for the rest of this same script run.
function Update-SessionPath {
  $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

Write-Host "=== InventorySprint Dev Environment Setup ===" -ForegroundColor Cyan

# --- 1. Node.js ------------------------------------------------------------
Write-Step "Node.js"
if (Test-Cmd "node") {
  Write-Ok "Already installed: $(node --version)"
} else {
  if (-not (Test-Cmd "winget")) {
    Write-Fail "winget not found - install Node.js manually from https://nodejs.org (LTS) then re-run this script."
  } else {
    Write-Warn "Not found. Installing via winget..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Update-SessionPath
    if (Test-Cmd "node") {
      Write-Ok "Installed: $(node --version)"
    } else {
      Write-Fail "winget reported success but 'node' still isn't on PATH - close and reopen PowerShell, then re-run this script."
    }
  }
}

# --- 2. Git ------------------------------------------------------------------
Write-Step "Git"
if (Test-Cmd "git") {
  Write-Ok "Already installed: $(git --version)"
} else {
  if (-not (Test-Cmd "winget")) {
    Write-Fail "winget not found - install Git manually from https://git-scm.com/download/win then re-run this script."
  } else {
    Write-Warn "Not found. Installing via winget..."
    winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
    Update-SessionPath
    if (Test-Cmd "git") {
      Write-Ok "Installed: $(git --version)"
    } else {
      Write-Fail "winget reported success but 'git' still isn't on PATH - close and reopen PowerShell, then re-run this script."
    }
  }
}

# --- 3. Claude Code ----------------------------------------------------------
Write-Step "Claude Code"
if (Test-Cmd "claude") {
  Write-Ok "Already installed"
} elseif (-not (Test-Cmd "npm")) {
  Write-Fail "npm isn't available (Node.js install above must succeed first) - skipping Claude Code."
} else {
  Write-Warn "Not found. Installing via npm..."
  npm install -g "@anthropic-ai/claude-code"
  if (Test-Cmd "claude") {
    Write-Ok "Installed"
  } else {
    Write-Fail "npm install finished but 'claude' still isn't on PATH - close and reopen PowerShell, then re-run this script."
  }
}

# --- 4. Clone repos + npm install --------------------------------------------
Write-Step "Repositories"
$devRoot = Join-Path $HOME "dev"
if (-not (Test-Path $devRoot)) { New-Item -ItemType Directory -Path $devRoot | Out-Null }

$repos = @(
  @{ Name = "inventorysprint-app";     Url = "https://github.com/sezflower01/inventorysprint-app.git" },
  @{ Name = "new-venture-generator"; Url = "https://github.com/sezflower01/new-venture-generator.git" }
)

if (-not (Test-Cmd "git")) {
  Write-Fail "git isn't available - skipping repo clone/install. Run this script again once Git is installed."
} else {
  foreach ($repo in $repos) {
    $path = Join-Path $devRoot $repo.Name
    Write-Host ""
    if (Test-Path $path) {
      Write-Ok "$($repo.Name) already cloned at $path"
    } else {
      Write-Warn "Cloning $($repo.Name) (private repo - a GitHub sign-in window may open)..."
      git clone $repo.Url $path
      if (Test-Path $path) {
        Write-Ok "Cloned $($repo.Name)"
      } else {
        Write-Fail "Clone of $($repo.Name) did not complete - check the GitHub sign-in prompt above, then re-run this script."
        continue
      }
    }

    if (-not (Test-Cmd "npm")) {
      Write-Fail "npm isn't available - skipping 'npm install' for $($repo.Name)."
      continue
    }
    Write-Warn "Running npm install in $($repo.Name)..."
    Push-Location $path
    npm install
    $npmExit = $LASTEXITCODE
    Pop-Location
    if ($npmExit -eq 0) {
      Write-Ok "$($repo.Name) dependencies installed"
    } else {
      Write-Fail "npm install failed in $($repo.Name) (exit code $npmExit) - open that folder and run 'npm install' manually to see the full error."
    }
  }
}

# --- Summary -------------------------------------------------------------
Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Cyan
Write-Host "Repos: $devRoot" -ForegroundColor Cyan
if ($hadFailure) {
  Write-Host "Some steps need attention - see [FAIL] lines above, or follow the manual checklist on the Dev Environment Setup admin page." -ForegroundColor Yellow
} else {
  Write-Host "Everything installed cleanly. If this was a fresh Node/Git install, close and reopen PowerShell before your first 'claude'/'npm'/'git' command." -ForegroundColor Green
}
