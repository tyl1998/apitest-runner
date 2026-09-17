#Requires -Version 5.1
<#
apitest-runner 启动/停止脚本（Windows PowerShell 版，部署在自托管机器上用；
与同目录 ./start.sh 同一套语义）。

用法:
  .\start.ps1            # 后台启动（环境变量可来自 shell 或同目录 .env）
  .\start.ps1 fg         # 前台启动，日志直接打到终端（调试用）
  .\start.ps1 stop       # 停止：Windows 无 SIGTERM，先 taskkill /T 请求收尾，超宽限强杀
  .\start.ps1 restart    # 停止后再启动
  .\start.ps1 status     # 查看运行状态

启动类命令可跟第二个参数指定容器档 Docker 通道（默认读 .env 的
APITRACK_RUNNER_DOCKER_TRANSPORT，缺省 cli）:
  .\start.ps1 start api    # 用 Engine API over unix socket 起 Runner
  .\start.ps1 fg cli       # 前台走 docker run 通道
  .\start.ps1 start        # 不指定则用 .env 里的值

环境变量见 README；必填的是 APITRACK_RUNNER_URL 与 APITRACK_RUNNER_TOKEN。
.env 一行一个 KEY=VALUE，只补缺、不覆盖 shell 里已导出的变量。

若提示脚本被禁止运行：powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
或直接双击同目录的 start.cmd。
#>
param(
  [Parameter(Position = 0)][string]$Command = "start",
  [Parameter(Position = 1)][string]$Transport = ""
)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$PidFile = Join-Path $Root ".runner.pid"
$LogFile = Join-Path $Root "runner.log"

if (@("start", "fg", "stop", "restart", "status") -notcontains $Command) {
  Write-Host "未知命令: $Command (支持 start | fg | stop | restart | status)" -ForegroundColor Red
  exit 1
}

if ($Transport -ne "") {
  if (@("cli", "api") -notcontains $Transport) {
    Write-Host "未知 Docker 通道: $Transport (支持 cli | api；仅 start / fg / restart 会用)" -ForegroundColor Red
    exit 1
  }
  $env:APITRACK_RUNNER_DOCKER_TRANSPORT = $Transport
}

# 企业 CA（平台部署在自签证书反代后面时，Node 的 fetch 会报 SELF_SIGNED_CERT_IN_CHAIN）：
# 给一个 PEM 路径即可，不需要就不设。只在本脚本注入，不进 .env 的说明文档。
if ($env:APITRACK_RUNNER_CA_BUNDLE -and -not $env:NODE_EXTRA_CA_CERTS -and (Test-Path $env:APITRACK_RUNNER_CA_BUNDLE)) {
  $env:NODE_EXTRA_CA_CERTS = $env:APITRACK_RUNNER_CA_BUNDLE
}

# .env 只补缺：手工 export 的优先级高于文件，方便临时覆盖单个值。
function Import-EnvFile {
  $envFile = Join-Path $Root ".env"
  if (-not (Test-Path $envFile)) { return }
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1)
    if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { return }
    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
      [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
  }
}

function Assert-RequiredEnv {
  if (-not $env:APITRACK_RUNNER_URL) {
    Write-Host "缺少 APITRACK_RUNNER_URL（环境变量或 $Root\.env）" -ForegroundColor Red
    exit 1
  }
  if (-not $env:APITRACK_RUNNER_TOKEN) {
    Write-Host "缺少 APITRACK_RUNNER_TOKEN（环境变量或 $Root\.env）" -ForegroundColor Red
    exit 1
  }
}

# 优先跑构建产物（dist），没有再退回 tsx 现场跑（开发机形状）。
$RunnerExe = ""
$RunnerArgs = @()
function Resolve-RunnerCmd {
  $dist = Join-Path $Root "dist\index.js"
  $tsx = Join-Path $Root "node_modules\.bin\tsx.cmd"
  if ((Test-Path $dist) -and (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    $script:RunnerExe = "node.exe"
    $script:RunnerArgs = @($dist)
  } elseif (Test-Path $tsx) {
    $script:RunnerExe = $tsx
    $script:RunnerArgs = @((Join-Path $Root "src\index.ts"))
  } else {
    Write-Host "运行时缺失：先在 $Root 执行 pnpm install（跑产物另需 pnpm build）" -ForegroundColor Red
    exit 1
  }
}

function Get-RunnerPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $raw) { return $null }
  return $raw.Trim()
}

function Test-RunnerUp {
  $processId = Get-RunnerPid
  if (-not $processId) { return $false }
  return [bool](Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue)
}

function Start-Detached([string]$WorkDir, [string]$CommandLine, [string]$LogPath) {
  # 运行期 .cmd 包装（回避 PowerShell 版本间 -ArgumentList 的引号差异）；放在 Runner
  # 根目录（.gitignore 已忽略），这样 pidfile 里那个 cmd 进程的命令行带着 $Root 路径，
  # stop.ps1 的「这个 pid 还是本 Runner 吗」校验才能成立。Start-Process 拉起独立隐藏
  # 窗口：关掉终端不死；日志追加（>>），不截断历史。
  $wrapper = Join-Path $WorkDir ".runner.run.cmd"
  $content = "@echo off`r`ncd /d `"$WorkDir`"`r`n$CommandLine >> `"$LogPath`" 2>&1`r`n"
  Set-Content -Path $wrapper -Value $content -Encoding ASCII
  return Start-Process -FilePath $wrapper -WindowStyle Hidden -PassThru
}

function Do-Start {
  Import-EnvFile
  Assert-RequiredEnv
  if (Test-RunnerUp) {
    Write-Host "Runner 已在运行 (pid $(Get-RunnerPid))，跳过"
    return
  }
  Resolve-RunnerCmd
  # 命令行里所有可能带空格的路径都加引号；参数逐个转义。
  $quotedArgs = ($RunnerArgs | ForEach-Object { "`"$_`"" }) -join " "
  $commandLine = "`"$RunnerExe`" $quotedArgs"
  Write-Host "启动 Runner（$RunnerExe $quotedArgs），日志追加到 $LogFile"
  $proc = Start-Detached $Root $commandLine $LogFile
  Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII
  # 配置错误会在启动一秒内退出（URL/Token 校验、git 缺失），把原因翻出来而不是留一个空 pidfile。
  Start-Sleep -Seconds 1
  if (-not (Test-RunnerUp)) {
    Write-Host "启动失败，最近的日志：" -ForegroundColor Red
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 | Write-Host }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host "已启动 (pid $(Get-RunnerPid))"
}

function Do-Stop {
  if (-not (Test-RunnerUp)) {
    Write-Host "Runner 未在运行"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return
  }
  $processId = [int](Get-RunnerPid)
  # 停机等待 = Runner 自己的收尾宽限 + 余量（与 bash 版一致）。
  # Windows 说明：没有 POSIX SIGTERM，taskkill /T（不带 /F）只是「请求关闭」，
  # 控制台型 Node 进程通常不会响应——因此多数情况下要等满宽限才强杀。Runner 的在途
  # 任务由平台租约回收 + 下次启动补报兜底（与 bash 版超时强杀同一套兜底）。
  $grace = 30
  if ($env:APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS -match '^\d+$') {
    $grace = [int]$env:APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS
  }
  $waitSeconds = $grace + 90
  Write-Host "停止 Runner (pid $processId)：最多等 ${waitSeconds}s（在途任务收尾）"
  & taskkill.exe /PID $processId /T 2>&1 | Out-Null
  $waited = 0
  while (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    if ($waited -ge $waitSeconds) {
      Write-Host "等待超时，强杀（残留状态由下次启动的补报与平台租约回收兜底）" -ForegroundColor Yellow
      & taskkill.exe /PID $processId /T /F 2>&1 | Out-Null
      break
    }
    Start-Sleep -Seconds 2
    $waited += 2
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host "已停止"
}

function Do-Status {
  if (Test-RunnerUp) {
    Write-Host "运行中 (pid $(Get-RunnerPid))"
  } else {
    Write-Host "未运行"
    exit 1
  }
}

switch ($Command) {
  "start"   { Do-Start }
  "fg" {
    Import-EnvFile
    Assert-RequiredEnv
    Resolve-RunnerCmd
    & $RunnerExe @RunnerArgs
    exit $LASTEXITCODE
  }
  "stop"    { Do-Stop }
  "restart" { Do-Stop; Do-Start }
  "status"  { Do-Status }
}
