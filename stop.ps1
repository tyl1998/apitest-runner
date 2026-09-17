#Requires -Version 5.1
<#
apitest-runner 停止脚本（Windows PowerShell 版，与 .\start.ps1 stop 同一套语义）。
用法:
  .\stop.ps1            # 优雅停止：先 taskkill /T 请求收尾，超宽限强杀
  .\stop.ps1 -Force     # 快停：最多等 10s 就强杀（在途任务按 aborted 由下次启动补报）

停机等待 = Runner 自己的收尾宽限 + 余量（与 start.ps1 stop 一致）。
Windows 没有 POSIX SIGTERM：taskkill /T（不带 /F）只是「请求关闭」，控制台型 Node
进程通常不响应——因此多数情况下要等满宽限才强杀；残留状态由平台租约回收 + 下次启动
的补报兜底。

若提示脚本被禁止运行：powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
或直接双击同目录的 stop.cmd。
#>
param(
  [switch]$Force
)

$ErrorActionPreference = "SilentlyContinue"

$Root = $PSScriptRoot
$PidFile = Join-Path $Root ".runner.pid"

function Get-RunnerPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile | Select-Object -First 1)
  if (-not $raw) { return $null }
  return $raw.Trim()
}

# pidfile 里的 pid 可能已被系统复用，动手前确认它还是本 Runner（命令行里带 $Root 路径）。
function Test-LooksLikeRunner([int]$ProcessId) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
  if (-not $proc -or -not $proc.CommandLine) { return $false }
  $needle = $Root.ToLowerInvariant().Replace("\", "/")
  return $proc.CommandLine.ToLowerInvariant().Replace("\", "/").Contains($needle)
}

function Kill-Tree([int]$ProcessId, [switch]$Hard) {
  if ($ProcessId -le 0) { return }
  if ($Hard) { & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null }
  else { & taskkill.exe /PID $ProcessId /T 2>&1 | Out-Null }
}

function Do-Stop {
  $raw = Get-RunnerPid
  $processId = 0
  if ($raw -match '^\d+$') { $processId = [int]$raw }
  if ($processId -eq 0 -or -not (Get-Process -Id $processId -ErrorAction SilentlyContinue) -or -not (Test-LooksLikeRunner $processId)) {
    if ($raw) { Write-Host "pidfile 记录的 pid $raw 已不是 Runner，视为残留记录" }
    else { Write-Host "无 pidfile 记录" }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return
  }

  $grace = 30
  if ($env:APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS -match '^\d+$') {
    $grace = [int]$env:APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS
  }
  $waitSeconds = if ($Force) { 10 } else { $grace + 90 }
  Write-Host "停止 Runner (pid $processId)：最多等 ${waitSeconds}s（在途任务收尾）"
  Kill-Tree $processId
  $waited = 0
  while (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    if ($waited -ge $waitSeconds) {
      Write-Host "等待超时，强杀（残留状态由下次启动的补报与平台租约回收兜底）" -ForegroundColor Yellow
      # 先杀孩子再杀父：父一死孩子就被系统收养，父的进程树关系就断了
      Kill-Tree $processId -Hard
      break
    }
    Start-Sleep -Seconds 2
    $waited += 2
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host "已停止"
}

Do-Stop

# 兜底：pidfile 之外可能还有活口（pidfile 被删过、手动用绝对路径起的）。
# 只用带 apitest-runner 路径前缀的模式——"watch src/index.ts" 这类会误杀 apitest-server 的 API 进程。
$Leftover = $false
function Cleanup-Pattern([string]$Pattern, [string]$Label) {
  $needle = $Pattern.ToLowerInvariant().Replace("\", "/")
  $hits = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Replace("\", "/").Contains($needle) }
  if (-not $hits) { return }
  $script:Leftover = $true
  $pids = @($hits | ForEach-Object { $_.ProcessId })
  Write-Host "清理残留 $Label (pid $($pids -join ' '))"
  foreach ($processId in $pids) { Kill-Tree ([int]$processId) }
}

Cleanup-Pattern "apitest-runner/dist/index.js" "dist 产物进程"
Cleanup-Pattern "apitest-runner/src/index.ts" "tsx 进程"

# 给兜底清理的进程 2 秒退场时间，还活着就补一刀 KILL
if ($Leftover) {
  Start-Sleep -Seconds 2
  foreach ($processId in @(Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -and ($_.CommandLine.ToLowerInvariant().Replace("\", "/").Contains("apitest-runner/dist/index.js") -or $_.CommandLine.ToLowerInvariant().Replace("\", "/").Contains("apitest-runner/src/index.ts"))
    } | ForEach-Object { $_.ProcessId })) {
    Kill-Tree ([int]$processId) -Hard
  }
}

Write-Host "完成（平台四个服务与 Postgres/Redis 不受影响）"
