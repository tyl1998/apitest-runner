#Requires -Version 5.1
<#
apitest-runner 启动/停止（Windows PowerShell 版，与同目录 ./start.sh 同一套语义）。

用法:
  .\start.ps1                # 后台启动（环境变量来自 shell 或同目录 .env）
  .\start.ps1 fg             # 前台启动，日志直接打到终端（调试用，Ctrl+C 优雅停）
  .\start.ps1 stop           # 优雅停止（见 stop.ps1）
  .\start.ps1 restart        # 停止后再启动
  .\start.ps1 status         # 查看运行状态

启动类命令可跟第二个参数指定容器档 Docker 通道（默认读 .env 的
APITRACK_RUNNER_DOCKER_TRANSPORT，缺省 cli）:
  .\start.ps1 start api      # 用 Engine API over named pipe / socket 起 Runner
  .\start.ps1 fg cli         # 前台走 docker run 通道
  .\start.ps1 start          # 不指定则用 .env 里的值

必填环境变量: APITRACK_RUNNER_URL 与 APITRACK_RUNNER_TOKEN（见 README / .env.example）。
.env 一行一个 KEY=VALUE，只补缺、不覆盖已在 shell 里导出的变量。

若提示「无法加载文件，因为在此系统上禁止运行脚本」，二选一:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
  或直接双击同目录的 start.cmd（包装脚本自带 ExecutionPolicy Bypass）。

与 bash 版的差异（Windows 没有 POSIX 信号 / nohup）:
  - 后台进程用 Start-Process 拉起（独立隐藏窗口，关掉终端不死），pidfile 记的是它的 PID；
  - 优雅停机靠对目标控制台发 Ctrl+Break（Node 映射成 SIGBREAK），停不下来再 taskkill /T /F；
  - 日志追加进 runner.log（运行期还会生成 .runner.run.cmd 包装文件，可随时删，下次启动重建）。
#>
param(
  [string]$Command = "start",
  [string]$Transport = ""
)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$PidFile = Join-Path $Root ".runner.pid"
$LogFile = Join-Path $Root "runner.log"
$Wrapper = Join-Path $Root ".runner.run.cmd"

# ── 参数校验 ────────────────────────────────────────────────────────────────
if (@("start", "fg", "stop", "restart", "status") -notcontains $Command) {
  Write-Host "未知命令: $Command (支持 start | fg | stop | restart | status)" -ForegroundColor Red
  exit 1
}
switch ($Transport) {
  ""      { }                                                    # 未指定：用 .env / shell 里的值
  "cli"   { $env:APITRACK_RUNNER_DOCKER_TRANSPORT = "cli" }
  "api"   { $env:APITRACK_RUNNER_DOCKER_TRANSPORT = "api" }
  default {
    Write-Host "未知 Docker 通道: $Transport (支持 cli | api；仅 start / fg / restart 会用)" -ForegroundColor Red
    exit 1
  }
}

# ── .env 只补缺（手工设置的进程环境变量优先），随后按需注入企业 CA ─────────────
function Import-DotEnv {
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
    $value = $value -replace "`r$", ""
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

# 平台部署在自签证书反代后面时，Node 的 fetch 会报 SELF_SIGNED_CERT_IN_CHAIN。
# 给一个 PEM 路径（APITRACK_RUNNER_CA_BUNDLE）即可，不需要就不设。
function Set-CaBundle {
  $bundle = [Environment]::GetEnvironmentVariable("APITRACK_RUNNER_CA_BUNDLE", "Process")
  if ($bundle -and -not $env:NODE_EXTRA_CA_CERTS -and (Test-Path $bundle)) {
    $env:NODE_EXTRA_CA_CERTS = $bundle
  }
}

function Test-RequiredEnv {
  foreach ($name in @("APITRACK_RUNNER_URL", "APITRACK_RUNNER_TOKEN")) {
    if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
      Write-Host "缺少 $name（环境变量或 $Root\.env）" -ForegroundColor Red
      exit 1
    }
  }
}

# 优先跑构建产物（dist），没有再退回 tsx 现场跑（开发机形状）。返回 @(exe, arg...)。
function Get-RunnerCommand {
  $dist = Join-Path $Root "dist\index.js"
  $tsx = Join-Path $Root "node_modules\.bin\tsx.cmd"
  if ((Test-Path $dist) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    return @("node", $dist)
  } elseif (Test-Path $tsx) {
    return @($tsx, (Join-Path $Root "src\index.ts"))
  } else {
    Write-Host "运行时缺失：先在 $Root 执行 pnpm install（跑产物另需 pnpm build）" -ForegroundColor Red
    exit 1
  }
}

# ── pidfile / 存活判定 ──────────────────────────────────────────────────────
function Get-RunnerPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($raw -and ($raw.Trim() -match '^\d+$')) { return [int]$raw.Trim() }
  return $null
}

function Test-RunnerUp {
  $processId = Get-RunnerPid
  if (-not $processId) { return $false }
  return [bool](Get-Process -Id $processId -ErrorAction SilentlyContinue)
}

# 把命令行拼成 cmd 可执行的一行（含引号）。
function Format-CommandLine([string[]]$Parts) {
  return ($Parts | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join " "
}

function Start-Runner {
  Import-DotEnv
  Set-CaBundle
  Test-RequiredEnv
  if (Test-RunnerUp) {
    Write-Host "Runner 已在运行 (pid $(Get-RunnerPid))，跳过"
    return
  }
  $cmd = Get-RunnerCommand
  $cmdLine = Format-CommandLine $cmd
  Write-Host "启动 Runner（$cmdLine），日志追加到 $LogFile"
  # 运行期包装：cd 到 ROOT，把 stdout/stderr 合并追加进 runner.log（避免 PowerShell 版本间
  # -ArgumentList 的引号差异，也让 Start-Process 能用隐藏窗口后台常驻）。
  $content = "@echo off`r`ncd /d `"$Root`"`r`n$cmdLine >> `"$LogFile`" 2>&1`r`n"
  Set-Content -Path $Wrapper -Value $content -Encoding ASCII
  $proc = Start-Process -FilePath $Wrapper -WindowStyle Hidden -PassThru
  Set-Content -Path $PidFile -Value "$($proc.Id)" -Encoding ASCII
  # 配置错误会在启动一秒内退出（URL/Token 校验、git 缺失），把原因翻出来而不是留一个空 pidfile。
  Start-Sleep -Seconds 1
  if (-not (Test-RunnerUp)) {
    Write-Host "启动失败，最近的日志：" -ForegroundColor Red
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host "已启动 (pid $(Get-RunnerPid))"
}

function Start-RunnerForeground {
  Import-DotEnv
  Set-CaBundle
  Test-RequiredEnv
  $cmd = Get-RunnerCommand
  Push-Location $Root
  try {
    & $cmd[0] @($cmd[1..($cmd.Count - 1)])
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

function Show-Status {
  if (Test-RunnerUp) {
    Write-Host "运行中 (pid $(Get-RunnerPid))"
  } else {
    Write-Host "未运行"
    exit 1
  }
}

# ── 分派 ────────────────────────────────────────────────────────────────────
switch ($Command) {
  "start"   { Start-Runner }
  "fg"      { Start-RunnerForeground }
  "stop"    { & (Join-Path $Root "stop.ps1") }
  "restart" { & (Join-Path $Root "stop.ps1"); Start-Runner }
  "status"  { Show-Status }
}
