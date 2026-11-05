param([string]$OutputDirectory = "$env:USERPROFILE\Desktop\Videome-diagnostics")
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$system = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture,FreePhysicalMemory,TotalVisibleMemorySize
$system | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $OutputDirectory 'system.json')
$roots = @((Join-Path $env:APPDATA 'Videome'), (Join-Path $env:APPDATA 'videome')) | Select-Object -Unique
foreach ($root in $roots) {
  $jobs = Join-Path $root 'batch-mix'
  if (Test-Path $jobs) { Get-ChildItem -LiteralPath $jobs -Filter job.json -Recurse | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $OutputDirectory ($_.Directory.Name + '-job.json'))
  } }
}
Write-Host "诊断已保存到 $OutputDirectory。清单可能含素材路径，发送前可检查。"
