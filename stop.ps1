#Requires -Version 5.1
<#
apitest-runner 停止（Windows PowerShell 版，与 ./start.ps1 stop 同一套语义的独立入口）。

用法:
  .\stop.ps1            # 优雅停止：先 Ctrl+Break 让 Runner 停止领活、等在途任务收尾，再退出
  .\stop.ps1 -Force     # 快停：Ctrl+Break 后最多等 10s 就 taskkill /T /F（在途任务按 aborted 由下次启动补报）

停机等待 = Runner 自己的收尾宽限（APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS，默认 30）+ 余量。

与 bash 版的差异（Windows 没有可投递的 SIGTERM）:
  - 优雅信号用「AttachConsole 到目标控制台 + GenerateConsoleCtrlEvent(Ctrl+Break)」，
    Node 把它映射成 SIGBREAK，触发和 bash 版 SIGTERM 一样的两段式收尾；
  - 等不到就 taskkill /PID <pid> /T /F 整棵树杀（cmd → node → job 子进程）；
  - 兜底再按命令行里带 apitest-runner 路径的活口清一遍（pidfile 被删或手动起过时）。
  - Postgres/Redis、平台四个服务都不受影响。
#>
param(
  [switch]$Force
)

$ErrorActionPreference = "SilentlyContinue"

$Root = $PSScriptRoot
$PidFile = Join-Path $Root ".runner.pid"
$RootToken = ($Root -replace "\\", "/").ToLowerInvariant()

# ── Ctrl+Break 投递（对目标进程所在控制台发 CTRL_BREAK_EVENT）─────────────────
# 标准 windows-kill 手法：FreeConsole 脱离自己的控制台 → AttachConsole 到目标控制台 →
# GenerateConsoleCtrlEvent 发 Ctrl+Break（Node 收成 SIGBREAK）。这套 AttachConsole 折腾
# 本进程的控制台状态，若在主脚本里就地做，一旦目标无控制台 / 宿主无交互控制台会把
# 自己也搅死（实测会挂住 stop 脚本）。所以放进一个隔离的后台 job 里做，并给硬超时：
# job 是独立进程，搅坏的只是它自己；无论成功失败，主流程随后都会 taskkill /T 兜底。
function Send-CtrlBreak([int]$TargetPid) {
  $job = Start-Job -ScriptBlock {
    param($tp)
    $sig = @"
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool AttachConsole(uint dwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool FreeConsole();
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool SetConsoleCtrlHandler(System.IntPtr HandlerRoutine, bool Add);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
"@
    Add-Type -Namespace "Kb" -Name "N" -MemberDefinition $sig | Out-Null
    [Kb.N]::FreeConsole() | Out-Null
    if (-not [Kb.N]::AttachConsole([uint32]$tp)) { return $false }
    [Kb.N]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null
    $ok = [Kb.N]::GenerateConsoleCtrlEvent(1, 0)   # 1 = CTRL_BREAK_EVENT, 组 0 = 该控制台全部进程
    Start-Sleep -Milliseconds 300
    return [bool]$ok
  } -ArgumentList $TargetPid

  $result = $false
  if (Wait-Job $job -Timeout 10) {
    # 正常完成：拿结果并回收（此时 Remove-Job 是瞬时的）。
    $out = Receive-Job $job -ErrorAction SilentlyContinue
    $result = [bool]($out | Select-Object -Last 1)
    Remove-Job $job -Force -ErrorAction SilentlyContinue
  } else {
    # 超时：job 多半卡在首次 Add-Type 的 csc 冷编译里。此时**不能**同步 Remove-Job —— 它会
    # 阻塞到 job 自己跑完（实测冷机会拖到 ~60s）。直接放手，job 会在本进程退出时被回收，
    # 主流程随后走 taskkill /T 兜底，不影响停止速度。
    return $false
  }
  return $result
}

# ── pidfile / 校验 ──────────────────────────────────────────────────────────
function Get-RunnerPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($raw -and ($raw.Trim() -match '^\d+$')) { return [int]$raw.Trim() }
  return $null
}

# 目标 pid 及其所有子孙进程（一次快照）。pidfile 里记的是隐藏窗口的 cmd 包装，
# 真正要等收尾的 node 在它的子孙里。
function Get-ProcessSubtree([int]$RootPid) {
  $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  if (-not $all) { return @() }
  $byParent = @{}
  foreach ($p in $all) {
    $k = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($k)) { $byParent[$k] = @() }
    $byParent[$k] += $p
  }
  $result = @()
  $seen = @{}
  $stack = New-Object System.Collections.Stack
  $stack.Push($RootPid)
  while ($stack.Count -gt 0) {
    $cur = [int]$stack.Pop()
    if ($seen.ContainsKey($cur)) { continue }
    $seen[$cur] = $true
    $proc = $all | Where-Object { [int]$_.ProcessId -eq $cur } | Select-Object -First 1
    if ($proc) { $result += $proc }
    if ($byParent.ContainsKey($cur)) {
      foreach ($child in $byParent[$cur]) { $stack.Push([int]$child.ProcessId) }
    }
  }
  return $result
}

# pid 可能被系统复用：确认它本人或某个子孙进程的命令行里带 apitest-runner 路径，才是本 Runner。
function Test-LooksLikeRunner([int]$TargetPid) {
  foreach ($proc in (Get-ProcessSubtree $TargetPid)) {
    if ($proc.CommandLine -and ($proc.CommandLine -replace "\\", "/").ToLowerInvariant().Contains($RootToken)) {
      return $true
    }
  }
  return $false
}

function Kill-Tree([int]$TargetPid) {
  if ($TargetPid -le 0) { return }
  & taskkill.exe /PID $TargetPid /T /F 2>&1 | Out-Null
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
function Stop-Runner {
  $processId = Get-RunnerPid
  if (-not $processId -or -not (Get-Process -Id $processId -ErrorAction SilentlyContinue) -or -not (Test-LooksLikeRunner $processId)) {
    if ($processId) {
      Write-Host "pidfile 记录的 pid $processId 已不是 Runner，视为残留记录"
    } else {
      Write-Host "无 pidfile 记录"
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return
  }

  $grace = [Environment]::GetEnvironmentVariable("APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS", "Process")
  if (-not ($grace -match '^\d+$')) { $grace = 30 } else { $grace = [int]$grace }
  if ($Force) { $waitSeconds = 10 } else { $waitSeconds = $grace + 90 }

  # 真正要等收尾的是 node（Runner 本体），不是隐藏窗口的 cmd 包装：Ctrl+Break 打到整个
  # 控制台后，node 会走 SIGBREAK 优雅收尾并退出，而 cmd 包装（批处理）会卡在
  # "Terminate batch job (Y/N)?" 永远不自己退——若去等它就会白等满整个超时。所以只等 node，
  # node 一走就立刻 taskkill /T 把卡住的 cmd 包装和残留整棵树清掉。
  $drainPids = @(Get-ProcessSubtree $processId |
    Where-Object { $_.Name -eq "node.exe" } |
    ForEach-Object { [int]$_.ProcessId })

  Write-Host "停止 Runner (pid $processId)：Ctrl+Break，最多等 ${waitSeconds}s（在途任务收尾）"
  $signaled = Send-CtrlBreak $processId
  if (-not $signaled) {
    Write-Host "  无法投递 Ctrl+Break（可能进程无控制台），直接 taskkill /T /F" -ForegroundColor Yellow
  } elseif ($drainPids.Count -gt 0) {
    $waited = 0
    while ($true) {
      $alive = @($drainPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
      if ($alive.Count -eq 0) { break }
      if ($waited -ge $waitSeconds) {
        Write-Host "等待超时，强杀（残留状态由下次启动的补报与平台租约回收兜底）" -ForegroundColor Yellow
        break
      }
      Start-Sleep -Seconds 1
      $waited += 1
    }
  }

  # 无论优雅是否成功，都把整棵树（cmd 包装 / tsx / 残留 node）清干净——node 已优雅退出时
  # 这只是收走卡在 Y/N 的 cmd 包装，很快返回；没退干净时这一步兜底强杀。
  Kill-Tree $processId
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host "已停止"
}

# 兜底：pidfile 之外可能还有活口（pidfile 被删过、或手动用绝对路径起的）。
# 只匹配带 apitest-runner 路径前缀的命令行——"watch src/index.ts" 这类会误杀 apitest-server 的进程。
function Clear-Leftover {
  $patterns = @("apitest-runner/dist/index.js", "apitest-runner/src/index.ts")
  $hits = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    if (-not $_.CommandLine) { return $false }
    $cl = ($_.CommandLine -replace "\\", "/").ToLowerInvariant()
    foreach ($pat in $patterns) { if ($cl.Contains($pat)) { return $true } }
    return $false
  }
  if (-not $hits) { return }
  $pids = @($hits | ForEach-Object { [int]$_.ProcessId })
  Write-Host "清理残留 Runner 进程 (pid $($pids -join ' '))"
  foreach ($p in $pids) { Kill-Tree $p }
}

Stop-Runner
Clear-Leftover
Write-Host "完成（平台四个服务与 Postgres/Redis 不受影响）"
