# Install the kfc-cn-ordering skill into Hermes (~/.hermes/skills).
# This does not touch config.yaml; MCP registration is manual (see config.snippet.yaml).
$ErrorActionPreference = 'Stop'

$hermesDir = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE '.hermes' }
$target = Join-Path $hermesDir 'skills\kfc-cn-ordering'
$source = Join-Path $PSScriptRoot 'skills\kfc-cn-ordering'

if (-not (Test-Path $source)) {
  throw "Skill source not found: $source"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse -Force (Join-Path $source '*') $target

Write-Host "Installed skill to $target"
Write-Host 'Restart Hermes or run /reset, then use /kfc-cn-ordering.'
