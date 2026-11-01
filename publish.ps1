<#
  一键把本仓库发布到 GitHub（本地提交 + 推送；必要时创建仓库），Windows 双击入口。

  为什么不用 gh CLI：本机没装它，而且它还要额外登录一次。这个脚本只用 git +
  （可选的）GitHub REST API，够用。

  用法（在仓库根目录；双击 publish.cmd 等价于不带参数运行本脚本）：
    publish.cmd                                  # 按提示一路走
    publish.cmd -Help                            # 看帮助
    publish.cmd -NoPush                          # 只做本地第 1~5 步，不 push（预演/自测）
    publish.cmd -Token ghp_xxxxxxxx              # 用 PAT 自动建仓（Token 不写进任何文件）
    publish.cmd -Owner wgica -Repo other-name    # 换目标仓库

  做的 6 件事：
    [1/6] 环境检查（git / node / package.json）
    [2/6] 没有 .git 就 git init -b main；已有仓库但当前分支不是 main 就改名为 main
    [3/6] 检查 git 身份（user.name / user.email），缺失时直接报错并给出配置命令
    [4/6] 校正 origin = https://github.com/<owner>/<repo>.git；owner/repo 与文件里
          写的不一致时，调用 scripts/set-repo.mjs 统一改写 package.json 的
          repository/bugs/homepage 与 README.md 的 raw 前缀（幂等）
    [5/6] git add -A，有变更才 commit（打印将提交的条目数）；node_modules 没被忽略时拒绝执行
    [6/6] git push -u origin main；失败且像是「仓库不存在 / 认证失败」时：
            - 有 -Token：调用 GitHub REST API POST /user/repos 建仓，再重试 push；
            - 没有 -Token：在浏览器打开 https://github.com/new?... 让用户点一次创建，
              回来按回车重试（最多 3 次）。

  安全：-Token 只从命令行参数读，不写文件、不拼进 remote URL，日志里打码。
  不做 force push，不做 reset --hard；失败时以非零码退出。
  唯一可能留下的中间状态是「本地已经 init/commit 但还没 push」，处理完重跑本脚本即可续上。

  实现说明：脚本用 cmd.exe 把每条 git 命令的输出重定向到 .git 下的临时文件再读回来
  （读完立即删除），这样无论从双击窗口、CI 还是输出被重定向的地方运行行为都一致，
  也避开了不同 PowerShell 版本处理原生命令输出的编码差异。临时文件名固定带
  dsh-publish-cap 前缀，启动时会清理上次异常退出的残留。为了不让 git 卡在看不可见
  的终端密码提示上，脚本设置了 GIT_TERMINAL_PROMPT=0：首次 push 请看 Git
  Credential Manager 的弹窗登录，或者直接用 -Token。
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Owner = "",
  [string]$Repo = "",
  [string]$Token = "",
  [string]$Message = "",
  [switch]$NoPush,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:TotalSteps = 6
$script:CapSeq = 0
$script:CapCode = 0
$script:CapText = ""

$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $Root
$PkgPath = Join-Path $Root "package.json"
$GitDir = Join-Path $Root ".git"
$RepoPage = ""

# git 在输出被重定向时不要卡在终端的用户名/密码提示上（GCM 弹窗不受影响）
[Environment]::SetEnvironmentVariable("GIT_TERMINAL_PROMPT", "0", "Process")

function Say([string]$text) { Write-Host ("  " + $text) }
function Note([string]$text) { Write-Host ("  " + $text) -ForegroundColor DarkGray }
function Warn([string]$text) { Write-Host ("  " + $text) -ForegroundColor Yellow }
function Step([int]$number, [string]$text) {
  Write-Host ""
  Write-Host ("[{0}/{1}] {2}" -f $number, $script:TotalSteps, $text) -ForegroundColor Cyan
}
function Fail([string]$text) {
  Write-Host ""
  Write-Host ("× " + $text) -ForegroundColor Red
  Write-Host ""
  exit 1
}
function Redact([string]$text) {
  if ($Token -and $text) { return $text.Replace($Token, "***") }
  return $text
}

# 运行一条命令并把输出捕获到 .git/dsh-publish-cap-<n>.txt（读完立即删除）。
# 结果放在 $script:CapCode / $script:CapText；调用时必须是独立语句，不要写成 $x = Invoke-Cap ...
# 注意：命令里不能出现引号或空格之外的 cmd 元字符；本脚本用到的参数都不含空格。
function Invoke-Cap {
  param([string]$CommandLine)
  $script:CapSeq = $script:CapSeq + 1
  if (Test-Path $GitDir) {
    $rel = ".git/dsh-publish-cap-" + $script:CapSeq + ".txt"
  } else {
    $rel = ".dsh-publish-cap-" + $script:CapSeq + ".txt"
  }
  $abs = Join-Path $Root $rel
  if (Test-Path $abs) { Remove-Item $abs -Force -ErrorAction SilentlyContinue }
  & cmd.exe /d /c ($CommandLine + " > " + $rel + " 2>&1")
  $script:CapCode = $LASTEXITCODE
  $script:CapText = ""
  if (Test-Path $abs) {
    $script:CapText = Redact ([System.IO.File]::ReadAllText($abs, [System.Text.Encoding]::UTF8).Trim())
    Remove-Item $abs -Force -ErrorAction SilentlyContinue
  }
}

function Write-CapText([string]$prefix) {
  if (-not $script:CapText) { return }
  foreach ($line in ($script:CapText -split "\r?\n")) {
    if ($line.Trim()) { Note ($prefix + $line.Trim()) }
  }
}

# ── 帮助 ────────────────────────────────────────────────────────────────────
if ($Help) {
  Write-Host ""
  Write-Host "=== dsh-codex-effort-slider-ultra 一键发布到 GitHub ===" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "用法："
  Write-Host "  publish.cmd [选项]"
  Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File publish.ps1 [选项]"
  Write-Host ""
  Write-Host "选项："
  Write-Host "  -Owner <owner>      GitHub 用户名/组织名。默认从 package.json 的 repository.url 解析，"
  Write-Host "                      其次读 git remote origin，最后兜底 wgica。"
  Write-Host "  -Repo <repo>        仓库名。默认取 package.json 的 name。"
  Write-Host "  -Token <PAT>        可选。GitHub 个人访问令牌，用来在没有仓库时自动调 REST 建仓；"
  Write-Host "                      只从参数读，不写文件、不进 remote URL，日志里打码。"
  Write-Host "                      classic PAT 需要 repo scope；fine-grained PAT 需要"
  Write-Host "                      Administration: Read and write 才能建仓。"
  Write-Host "  -Message <msg>      提交信息。默认 'chore: publish v<version>'。"
  Write-Host "  -NoPush             只做本地步骤（init / add / commit / origin），不 push。"
  Write-Host "  -Help               显示这份帮助并退出。"
  Write-Host ""
  Write-Host "示例："
  Write-Host "  publish.cmd -NoPush"
  Write-Host "  publish.cmd -Token ghp_xxxxxxxxxxxxxxxx"
  Write-Host "  publish.cmd -Owner wgica -Repo dsh-codex-effort-slider-ultra -Message 'chore: release'"
  Write-Host ""
  Write-Host "前提：已安装 Git（init -b 需要 2.28+，更老的版本会自动回退到 git init + symbolic-ref）；"
  Write-Host "      打包/校验需要 Node.js >= 22；首次 push 需要 GitHub 认证，Windows 上一般由"
  Write-Host "      Git Credential Manager 弹窗并打开浏览器登录。"
  Write-Host ""
  exit 0
}

# ── 清理上次异常退出的残留 ──────────────────────────────────────────────────
Get-ChildItem -Path $Root -Filter ".dsh-publish-cap-*.txt" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path $GitDir) {
  Get-ChildItem -Path $GitDir -Filter "dsh-publish-cap-*.txt" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $GitDir "dsh-publish-msg.txt") -Force -ErrorAction SilentlyContinue
}

# ── [1/6] 环境检查 ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== dsh-codex-effort-slider-ultra 一键发布到 GitHub ===" -ForegroundColor Cyan
Say ("仓库目录 : " + $Root)
if ($NoPush) { Say "模式     : -NoPush（只做本地步骤，不 push）" }

Step 1 "环境检查"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "找不到 git。先安装 Git for Windows（https://git-scm.com/download/win），确认能跑 git --version 后重试。"
}
Invoke-Cap "git --version"
if ($script:CapCode -ne 0) { Fail ("git --version 跑不通：" + $script:CapText) }
Say ("git  : " + $script:CapText)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "找不到 node。scripts/set-repo.mjs 需要 Node.js >= 22，装好并加入 PATH 后重试。"
}
Invoke-Cap "node --version"
if ($script:CapCode -ne 0) { Fail ("node --version 跑不通：" + $script:CapText) }
Say ("node : " + $script:CapText)

if (-not (Test-Path $PkgPath)) { Fail ("这里不像仓库根目录：找不到 " + $PkgPath) }
try {
  $Pkg = Get-Content $PkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Fail ("package.json 解析失败：" + $_.Exception.Message)
}
if (-not $Pkg.name) { Fail "package.json 里没有 name，无法推断仓库名。" }
Say ("包名 : " + $Pkg.name + " " + $Pkg.version)

# ── [2/6] 初始化 / 确认仓库与分支 main ─────────────────────────────────────
Step 2 "初始化 / 确认仓库与分支 main"

if (Test-Path $GitDir) {
  Say "已存在 .git，跳过 git init"
} else {
  Say "没有 .git，正在 git init -b main …"
  & git init -b main
  if ($LASTEXITCODE -ne 0) {
    Note "当前 git 不支持 init -b（版本较老），改用 git init + symbolic-ref"
    & git init
    if ($LASTEXITCODE -ne 0) { Fail "git init 失败" }
    & git symbolic-ref HEAD refs/heads/main
    if ($LASTEXITCODE -ne 0) { Fail "设置分支 main 失败" }
  }
  Say "已初始化仓库，默认分支 main"
}

Invoke-Cap "git rev-parse --abbrev-ref HEAD"
$currentBranch = if ($script:CapCode -eq 0) { $script:CapText } else { "" }
if (-not $currentBranch -or $currentBranch -eq "HEAD") {
  & git symbolic-ref HEAD refs/heads/main
  if ($LASTEXITCODE -ne 0) { Fail "设置分支 main 失败" }
  Say "空仓库：分支设为 main"
} elseif ($currentBranch -ne "main") {
  & git branch -M main
  if ($LASTEXITCODE -ne 0) { Fail ("把分支 " + $currentBranch + " 改名为 main 失败") }
  Say ("分支已改名：" + $currentBranch + " → main")
} else {
  Say "当前分支：main"
}

# ── [3/6] git 身份 ─────────────────────────────────────────────────────────
Step 3 "检查 git 身份（user.name / user.email）"

Invoke-Cap "git config --get user.name"
$userName = if ($script:CapCode -eq 0) { $script:CapText } else { "" }
Invoke-Cap "git config --get user.email"
$userEmail = if ($script:CapCode -eq 0) { $script:CapText } else { "" }

if (-not $userName -or -not $userEmail) {
  Warn "git 还没配置提交身份（user.name / user.email）。先运行下面两条，再重跑本脚本："
  Warn '  git config --global user.name "你的名字"'
  Warn '  git config --global user.email "你的邮箱"'
  Fail ("缺少 git 身份配置（user.name=" + $userName + ", user.email=" + $userEmail + "）")
}
Say ("user.name  : " + $userName)
Say ("user.email : " + $userEmail)

# ── [4/6] origin + 仓库身份 ────────────────────────────────────────────────
Step 4 "校正 origin 与仓库元数据（owner/repo）"

Invoke-Cap "git remote get-url origin"
$originUrl = if ($script:CapCode -eq 0) { $script:CapText } else { "" }

if (-not $Owner) {
  $repoUrlInPkg = ""
  if ($Pkg.repository -is [string]) { $repoUrlInPkg = [string]$Pkg.repository }
  elseif ($Pkg.repository) { $repoUrlInPkg = [string]$Pkg.repository.url }
  $ownerFromPkg = ""
  $matchPkg = [regex]::Match([string]$repoUrlInPkg, "github[.]com[/:]([A-Za-z0-9_.-]+)/")
  if ($matchPkg.Success) { $ownerFromPkg = $matchPkg.Groups[1].Value }
  if ($ownerFromPkg) {
    $Owner = $ownerFromPkg
    Note ("owner 取自 package.json：" + $Owner)
  } elseif ($originUrl -match "github[.]com[/:]([A-Za-z0-9_.-]+)/") {
    $Owner = $Matches[1]
    Note ("owner 取自 git remote：" + $Owner)
  } else {
    $Owner = "wgica"
    Note ("owner 兜底为：" + $Owner)
  }
}
if (-not $Repo) {
  $Repo = [string]$Pkg.name
  Note ("repo 取自 package.json name：" + $Repo)
}
if (-not $Owner -or $Owner -notmatch "^[A-Za-z0-9_.-]+$") { Fail ("owner 不合法：" + $Owner) }
if (-not $Repo -or $Repo -notmatch "^[A-Za-z0-9_.-]+$") { Fail ("repo 不合法：" + $Repo) }
if (-not $Message) { $Message = "chore: publish v" + $Pkg.version }

$RemoteUrl = "https://github.com/" + $Owner + "/" + $Repo + ".git"
$RepoPage = "https://github.com/" + $Owner + "/" + $Repo
Say ("目标仓库 : " + $Owner + "/" + $Repo)
Say ("提交信息 : " + $Message)

if ($originUrl) {
  $oldTrimmed = ($originUrl.Trim().TrimEnd("/")) -replace "[.]git$", ""
  $newTrimmed = ($RemoteUrl.Trim().TrimEnd("/")) -replace "[.]git$", ""
  if ($oldTrimmed -ne $newTrimmed) {
    & git remote set-url origin $RemoteUrl
    if ($LASTEXITCODE -ne 0) { Fail "设置 origin 失败" }
    Say ("origin 已改：" + $originUrl + " → " + $RemoteUrl)
  } else {
    Say ("origin 已是 " + $RemoteUrl)
  }
} else {
  & git remote add origin $RemoteUrl
  if ($LASTEXITCODE -ne 0) { Fail "添加 origin 失败" }
  Say ("已添加 origin → " + $RemoteUrl)
}

$setRepo = Join-Path $Root (Join-Path "scripts" "set-repo.mjs")
if (-not (Test-Path $setRepo)) {
  Note "没有 scripts/set-repo.mjs，跳过仓库身份校验（只改 git remote）"
} else {
  Invoke-Cap ("node scripts/set-repo.mjs " + $Owner + " " + $Repo + " --dry-run")
  if ($script:CapCode -ne 0) { Fail ("仓库身份校验失败：" + $script:CapText) }
  if ($script:CapText -match "无需修改") {
    Say "package.json / README.md 的仓库身份已是目标状态"
  } else {
    Invoke-Cap ("node scripts/set-repo.mjs " + $Owner + " " + $Repo)
    if ($script:CapCode -ne 0) { Fail ("改写仓库身份失败：" + $script:CapText) }
    Say "已按目标 owner/repo 统一改写 package.json 与 README.md："
    Write-CapText "  "
  }
}

# ── [5/6] add + commit ─────────────────────────────────────────────────────
Step 5 "暂存并提交"

$nodeModules = Join-Path $Root "node_modules"
if (Test-Path $nodeModules) {
  & git check-ignore -q node_modules
  if ($LASTEXITCODE -ne 0) {
    Warn "node_modules 没有被 .gitignore 忽略，继续执行会把整个依赖目录提交上去。"
    Warn "请先在仓库根目录的 .gitignore 里加一行：node_modules/"
    Fail "node_modules 未被忽略，已停止（未做任何提交）。"
  }
  Say "node_modules 已被 .gitignore 忽略"
}

& git add -A
if ($LASTEXITCODE -ne 0) { Fail "git add -A 失败" }

Invoke-Cap "git status --porcelain"
if ($script:CapCode -ne 0) { Fail ("git status 失败：" + $script:CapText) }
$stagedEntries = @()
if ($script:CapText) { $stagedEntries = @($script:CapText -split "\r?\n" | Where-Object { $_.Trim() }) }
$stagedCount = $stagedEntries.Count

if ($stagedCount -eq 0) {
  Say "工作区没有变更，跳过提交"
} else {
  Say ("将提交 " + $stagedCount + " 个条目（新增 / 修改 / 删除）")
  $msgFile = Join-Path $GitDir "dsh-publish-msg.txt"
  [System.IO.File]::WriteAllText($msgFile, $Message, (New-Object System.Text.UTF8Encoding($false)))
  Invoke-Cap "git commit -F .git/dsh-publish-msg.txt"
  $commitCode = $script:CapCode
  Remove-Item $msgFile -Force -ErrorAction SilentlyContinue
  if ($commitCode -ne 0) { Fail "git commit 失败（可能是没配 user.name/user.email，或存在冲突）" }
  Write-CapText "  "
  Invoke-Cap "git log --oneline -1"
  if ($script:CapCode -eq 0) { Say ("最近提交: " + $script:CapText) }
}

# ── [6/6] push ─────────────────────────────────────────────────────────────
Step 6 "推送到 GitHub"

if ($NoPush) {
  Say "已指定 -NoPush：跳过 push"
  Write-Host ""
  Write-Host "√ 本地准备完成（未 push）" -ForegroundColor Green
  Say ("origin  : " + $RemoteUrl)
  Say "分支    : main"
  Invoke-Cap "git log --oneline -1"
  if ($script:CapCode -eq 0) {
    Say ("最近提交: " + $script:CapText)
  } else {
    Say "最近提交: （还没有提交）"
  }
  Note "之后直接运行 publish.cmd 即可推送到 GitHub。"
  Write-Host ""
  exit 0
}

function New-GitHubRepo {
  if (-not $Token) { return $false }
  $description = [string]$Pkg.description
  if ($description.Length -gt 300) { $description = $description.Substring(0, 297) + "..." }
  $body = @{
    name         = $Repo
    description  = $description
    private      = $false
    has_issues   = $true
    has_wiki     = $false
    has_projects = $false
    auto_init    = $false
  } | ConvertTo-Json
  $headers = @{
    Authorization          = "Bearer " + $Token
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "dsh-codex-effort-slider-ultra-publish"
  }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
  try {
    $created = Invoke-RestMethod -Method Post -Uri "https://api.github.com/user/repos" -Headers $headers -Body $body -ContentType "application/json"
    Say ("已通过 GitHub REST API 创建仓库：" + $created.html_url)
    return $true
  } catch {
    $detail = Redact $_.Exception.Message
    $status = 0
    try { $status = [int]$_.Exception.Response.StatusCode } catch { }
    if ($status -eq 422) {
      Say "GitHub 说仓库已存在（HTTP 422），直接重试 push"
      return $true
    }
    Say ("REST 建仓失败（HTTP " + $status + "）：" + $detail)
    return $false
  }
}

function New-RepoPromptUrl {
  $description = [string]$Pkg.description
  if ($description.Length -gt 160) { $description = $description.Substring(0, 157) + "..." }
  return "https://github.com/new?name=" + [uri]::EscapeDataString($Repo) + "&description=" + [uri]::EscapeDataString($description) + "&visibility=public"
}

# 第一次尝试
Invoke-Cap "git push -u origin main"
$pushCode = $script:CapCode
$pushText = $script:CapText
if ($pushCode -eq 0) {
  Say "push 成功"
} else {
  Note "push 失败，git 输出如下："
  Write-CapText "    "
}

if ($pushCode -ne 0) {
  $looksLikeMissingRepo = ($pushText -match "not found|does not exist|Repository not found|404|Permission to .* denied|could not read Username|terminal prompts disabled|Authentication failed|Invalid username or password|Support for password authentication|Unable to access")

  if (-not $looksLikeMissingRepo) {
    Fail "push 失败，且不像是「仓库不存在 / 认证失败」问题，已停止。请检查上面的 git 输出。"
  }

  if ($Token) {
    Say "检测到 -Token：尝试用 GitHub REST API 创建仓库 " + $Owner + "/" + $Repo + " …"
    if (New-GitHubRepo) {
      $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:" + $Token))
      [Environment]::SetEnvironmentVariable("GIT_CONFIG_COUNT", "1", "Process")
      [Environment]::SetEnvironmentVariable("GIT_CONFIG_KEY_0", "http.extraHeader", "Process")
      [Environment]::SetEnvironmentVariable("GIT_CONFIG_VALUE_0", ("Authorization: Basic " + $basic), "Process")
      Invoke-Cap "git push -u origin main"
      [Environment]::SetEnvironmentVariable("GIT_CONFIG_COUNT", $null, "Process")
      [Environment]::SetEnvironmentVariable("GIT_CONFIG_KEY_0", $null, "Process")
      [Environment]::SetEnvironmentVariable("GIT_CONFIG_VALUE_0", $null, "Process")
      $pushCode = $script:CapCode
      $pushText = $script:CapText
      if ($pushCode -eq 0) {
        Say "push 成功（-Token 只在本进程内用作临时认证头，没有写进任何文件）"
      } else {
        Note "带 -Token 的 push 仍然失败："
        Write-CapText "    "
      }
    }
  }

  if ($pushCode -ne 0) {
    $newUrl = New-RepoPromptUrl
    Say ("需要先在 GitHub 上创建仓库：" + $RepoPage)
    Say ("正在打开建仓页面：" + $newUrl)
    try { Start-Process $newUrl } catch { Note "自动打开浏览器失败，请手动打开上面的地址" }
    Note "建仓页上不要勾 Add a README / Add .gitignore / license，否则会多出一个提交，push 会被拒绝。"
    Note "首次 push 可能会弹出 Git Credential Manager 登录窗口，按提示授权即可。"

    $attempt = 0
    while ($pushCode -ne 0 -and $attempt -lt 3) {
      $attempt = $attempt + 1
      if ([Console]::IsInputRedirected) {
        Fail ("当前不是交互式终端，无法等待你建仓。" + [Environment]::NewLine + "  1. 打开 " + $newUrl + " ，点 Create repository（不要勾 Add a README）" + [Environment]::NewLine + "  2. 回到终端重新运行 publish.cmd" + [Environment]::NewLine + "也可以带 -Token 让脚本自动建仓。")
      }
      Write-Host ""
      Write-Host ("  建好仓库后按回车重试 push（第 {0}/3 次）…" -f $attempt) -ForegroundColor Yellow
      Read-Host | Out-Null
      Invoke-Cap "git push -u origin main"
      $pushCode = $script:CapCode
      $pushText = $script:CapText
      if ($pushCode -eq 0) {
        Say "push 成功"
      } else {
        Note "重试仍失败："
        Write-CapText "    "
      }
    }
  }

  if ($pushCode -ne 0) {
    Warn "push 仍然失败（已重试 3 次）。可能原因："
    Warn ("  - 仓库还没建：" + $RepoPage)
    Warn "  - 认证没通过：重新运行，按弹出的 Git Credential Manager 窗口登录，或带上 -Token"
    Warn "  - 远程已经有内容（例如在网页上初始化过 README），需要先 git pull --rebase 再推"
    Fail "推送失败。本地 commit 已经完成，不会丢东西；处理完直接重跑本脚本即可续上。"
  }
}

# ── 完成 ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "√ 已发布到 GitHub" -ForegroundColor Green
Say ("仓库    : " + $RepoPage)
Say ("origin  : " + $RemoteUrl)
Say "分支    : main"
Invoke-Cap "git log --oneline -1"
if ($script:CapCode -eq 0) {
  Say ("最近提交: " + $script:CapText)
} else {
  Say "最近提交: （还没有提交）"
}
Write-Host ""
exit 0
