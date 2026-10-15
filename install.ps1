#Requires -Version 5.1
<#
    dsh-prompt-adapt 一键安装器（Windows / PowerShell）

    ── 为什么需要它 ────────────────────────────────────────────────────────
    三条"官方"路线各自卡在一个前置条件上：
      · `dsh plugin --profile <p> add dsh-prompt-adapt`  → 已发布到 npm，这条现在能用
        （走 `registry.npmmirror.com` 镜像；桌面 profile 除外，见下面第三条）；
      · `dsh plugin --profile <p> add github:FABAGV/...` → pnpm 会先跑 `git ls-remote`，
        本机没有 git 就直接失败（安装 github: spec 必须有 git）；
      · 桌面客户端（profile = desktop）由 Electron 独占，启动器里有一句
        `rejectElectronProfile()` 会**直接拒绝**这个 profile 名。

    这个脚本把"下载 → 装进 profile → 登记成 bundle"三步合成一件事，并且：
      · 走 GitHub 加速镜像（实测国内直连 codeload 只有 30-50 KB/s，镜像 300+ KB/s）；
      · 用 DSH 自带的 node + pnpm（与插件管理器同一套，lockfile 版本一致）；
      · 把 tgz 留在 profile 目录内并作为**本地文件依赖**安装 —— 之后任何一次
        `pnpm install` 都不需要网络，也不会因为镜像失效而重装失败。

    ── 用法 ────────────────────────────────────────────────────────────────
        .\install.ps1                      # 自动挑 profile（desktop 优先），装默认版本
        .\install.ps1 -Profile web         # 指定 profile
        .\install.ps1 -Tag main            # 装 main 分支最新代码（不依赖 release）
        .\install.ps1 -File .\dsh-prompt-adapt-0.1.1.tgz   # 用本地 tgz
        .\install.ps1 -Uninstall           # 卸载（保留用户数据 ~/.dsh/prompt-adapt）
        .\install.ps1 -WhatIf              # 只打印会做什么
#>
[CmdletBinding()]
param(
    # 目标 profile 名；不传则按 $env:DSH_PROFILE → desktop → web 的顺序猜
    [string]$Profile,

    # GitHub release tag（默认桶里那个）；`main` = 直接用分支归档，不依赖 release
    [string]$Tag = 'v0.1.1',

    # 下载通道：auto 依次尝试 ghproxy → ghfast → ghproxynet → 直连
    [ValidateSet('auto', 'ghproxy', 'ghfast', 'ghproxynet', 'direct')]
    [string]$Mirror = 'auto',

    # 直接给一个 tgz URL（仍会套用镜像前缀）
    [string]$Url,

    # 直接给一个本地 tgz 路径
    [string]$File,

    [switch]$Uninstall,

    # 代理做 TLS 中间人时 node 需要 --use-system-ca 才信得过系统证书；默认自动。
    [switch]$NoProxyCa,

    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 默认只协商 TLS 1.0/1.1，对 gh-proxy 这类只支持 TLS 1.2+ 的
# CDN 会报 "Could not create SSL/TLS secure channel"。PowerShell 7 上这句是空操作。
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$PackageName = 'dsh-prompt-adapt'
$Repo        = 'FABAGV/dsh-prompt-adapt'

# ── 输出小工具 ────────────────────────────────────────────────────────────
function Say([string]$Message, [string]$Kind = 'info') {
    $tag = switch ($Kind) { 'warn' { '!' } 'err' { 'x' } 'ok' { '+' } default { '-' } }
    Write-Host ("  {0} {1}" -f $tag, $Message)
}
function Step([string]$Message) { Write-Host "`n== $Message" -ForegroundColor Cyan }

<#
    安全读属性 / 环境变量。

    本脚本开了 `Set-StrictMode -Version Latest`：访问**不存在的属性**会直接抛错，
    而 profile 的 package.json 完全可能没有 `dsh` / `dsh.profile` / `bundles`
    （新初始化的 profile 就有 dependencies 但没有 dsh 段）。所以一律走这两个取值器，
    不要写 `$obj.a.b.c`。
#>
function Get-Prop($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}
function Get-EnvOrNull([string]$Name) {
    return [System.Environment]::GetEnvironmentVariable($Name, 'Process')
}

# ── 路径解析 ──────────────────────────────────────────────────────────────
function Resolve-DshHome {
    $home_ = Get-EnvOrNull 'DSH_HOME'
    if ($home_) { return $home_ }
    return (Join-Path $env:USERPROFILE '.dsh')
}

function Resolve-ProfileDir([string]$Name) {
    $home_ = Resolve-DshHome
    $dir = Join-Path (Join-Path $home_ 'profiles') $Name
    if (-not (Test-Path -LiteralPath $dir)) {
        throw "profile 不存在：$dir`n  先让 DSH 初始化这个 profile（例如跑一次 `dsh $Name --help`），或换 -Profile。"
    }
    return $dir
}

function Resolve-ProfileName([string]$Requested) {
    if ($Requested) { return $Requested }
    $fromEnv = Get-EnvOrNull 'DSH_PROFILE'
    if ($fromEnv) { return $fromEnv }
    $profiles = Join-Path (Resolve-DshHome) 'profiles'
    foreach ($candidate in @('desktop', 'web')) {
        if (Test-Path -LiteralPath (Join-Path $profiles $candidate)) { return $candidate }
    }
    throw "猜不出 profile：$profiles 下没有 desktop/web，也没有 DSH_PROFILE。用 -Profile 指定。"
}

<#
    找 node 与 pnpm。

    优先用 DSH 自带的运行时（打包版桌面端）：
      · pnpm 版本与插件管理器用的一致 —— lockfile 格式、nodeLinker 语义都不会漂；
      · 用户没装 node/pnpm 也能跑（这台机器上很常见）。
    找不到才退回 PATH 上的 node/pnpm。
#>
function Resolve-RuntimeTools {
    # 打包版桌面端把 node/pnpm 放在 resources\runtime 下：
    #   primary-runtime\dependencies\node\bin\node.exe   （真 node.exe，runtime.json 里记的那个）
    #   primary-runtime\dependencies\pnpm\bin\pnpm.cjs   （pnpm 11.7.0，与插件管理器同一个）
    # 注意 resources\runtime\bin\node.cmd 不是独立 node —— 它靠 ELECTRON_RUN_AS_NODE 转发，
    # 直接拿来当解释器用不了，所以不列入候选。
    $runtimes = @()
    foreach ($base in @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:PROGRAMFILES)) {
        if (-not $base) { continue }
        $runtimes += @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'resources\runtime' } |
            Where-Object { Test-Path -LiteralPath $_ })
    }
    foreach ($root in $runtimes) {
        $node = Join-Path $root 'primary-runtime\dependencies\node\bin\node.exe'
        $pnpm = Join-Path $root 'primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
        if ((Test-Path -LiteralPath $pnpm) -and (Test-Path -LiteralPath $node)) {
            return [pscustomobject]@{ Node = $node; Pnpm = $pnpm; Source = "DSH 自带运行时 ($root)" }
        }
    }
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($nodeCmd -and $pnpmCmd) {
        return [pscustomobject]@{ Node = $nodeCmd.Source; Pnpm = $pnpmCmd.Source; Source = 'PATH' }
    }
    throw "找不到 node/pnpm：既没有 DSH 自带运行时，PATH 上也没有。"
}

# ── 下载（镜像优先）────────────────────────────────────────────────────────
$MirrorPrefixes = [ordered]@{
    ghproxy    = 'https://gh-proxy.com/'
    ghfast     = 'https://ghfast.top/'
    ghproxynet = 'https://ghproxy.net/'
    direct     = ''
}

function Get-TarballUrl([string]$TagName) {
    if ($Url) { return $Url }
    if ($TagName -eq 'main') {
        # 分支归档：release 还没建好时也能装（pnpm 能处理"单一顶层目录"的 tar.gz）
        return "https://github.com/$Repo/archive/refs/heads/main.tar.gz"
    }
    $version = $TagName -replace '^v', ''
    return "https://github.com/$Repo/releases/download/$TagName/$PackageName-$version.tgz"
}

function Invoke-Download([string]$Target, [string]$Destination) {
    $order = if ($Mirror -eq 'auto') { @('ghproxy', 'ghfast', 'ghproxynet', 'direct') } else { @($Mirror) }
    $errors = @()
    foreach ($name in $order) {
        $prefix = $MirrorPrefixes[$name]
        $proxied = "$prefix$Target"
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $progressBackup = $ProgressPreference
            $ProgressPreference = 'SilentlyContinue'   # 进度条会让大文件下载慢一个数量级
            Invoke-WebRequest -Uri $proxied -OutFile $Destination -TimeoutSec 300 -UseBasicParsing
            $ProgressPreference = $progressBackup
            $sw.Stop()
            $kb = [Math]::Round((Get-Item -LiteralPath $Destination).Length / 1KB)
            Say "$name 通道成功：$kb KB / $($sw.ElapsedMilliseconds) ms" ok
            return
        } catch {
            $sw.Stop()
            $errors += "$name → $($_.Exception.Message)"
            Say "$name 通道失败（$($sw.ElapsedMilliseconds) ms），换下一个" warn
        }
    }
    throw "所有下载通道都失败：`n  " + ($errors -join "`n  ")
}

# ── profile 清单读写 ──────────────────────────────────────────────────────
<#
    往 `dsh.profile.bundles` 里登记/移除本插件。

    与插件管理器的 `writeProfileBundles()` 保持一致：整份清单重写、2 空格缩进、
    末尾换行。追加到**末尾**（不插队）—— 顺序决定配置层的优先级，插队会改变
    已有插件的行为。
#>
function Update-Bundles([string]$ProfileDir, [string]$Name, [bool]$Enable, [string]$Node) {
    $manifestPath = Join-Path $ProfileDir 'package.json'
    # ⚠️ PowerShell 5.1 的 Get-Content 默认按 ANSI 读文件，这里必须显式 -Encoding UTF8
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

    $dsh = Get-Prop $manifest 'dsh'
    if (-not $dsh) {
        $dsh = [pscustomobject]@{}
        $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue $dsh -Force
    }
    $profileSection = Get-Prop $dsh 'profile'
    if (-not $profileSection) {
        $profileSection = [pscustomobject]@{}
        $dsh | Add-Member -NotePropertyName profile -NotePropertyValue $profileSection -Force
    }
    $bundles = @(Get-Prop $profileSection 'bundles')
    $bundles = @($bundles | Where-Object { $_ })

    if ($Enable) {
        if ($bundles -contains $Name) { Say "bundles 里已经有 $Name（不动顺序）"; return }
        $bundles = $bundles + @($Name)
    } else {
        if ($bundles -notcontains $Name) { Say "bundles 里本来就没有 $Name"; return }
        $bundles = @($bundles | Where-Object { $_ -ne $Name })
    }

    if ($WhatIf) { Say "（WhatIf）会写 package.json：bundles = $($bundles -join ', ')"; return }

    # 为什么借 node 重写而不是 ConvertTo-Json：
    #   宿主自己的 `writeProfileBundles()` 是 `JSON.stringify(manifest, undefined, 2) + "\n"`，
    #   而 PowerShell 5.1 的 ConvertTo-Json 会写成 4 空格缩进 + 冒号对齐（`"name":  "x"`），
    #   还会把路径里的反斜杠转义成 `\\`。文件仍然合法，但和 App 的写法不一致，
    #   用户下次在插件页点一下开关就会看到整份文件被重排。用 node 走同一条序列化路径。
    $helper = Join-Path $env:TEMP 'dsh-prompt-adapt-bundles.cjs'
    $helperSource = @'
const fs = require('node:fs')
const [file, action, name] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const current = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
const exists = current.includes(name)
manifest.dsh.profile.bundles = action === 'add'
  ? (exists ? current : [...current, name])
  : current.filter((entry) => entry !== name)
fs.writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`)
process.stdout.write(JSON.stringify(manifest.dsh.profile.bundles))
'@
    [System.IO.File]::WriteAllText($helper, $helperSource, (New-Object System.Text.UTF8Encoding($false)))
    try {
        $action = if ($Enable) { 'add' } else { 'remove' }
        $result = & $Node $helper $manifestPath $action $Name
        if ($LASTEXITCODE -ne 0) { throw "重写 package.json 失败（node 退出码 $LASTEXITCODE）" }
        Say "package.json 已更新：bundles = $($result -join ', ')" ok
    } finally {
        Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Pnpm([string]$Node, [string]$Pnpm, [string[]]$PnpmArgs, [string]$WorkingDir) {
    # `--use-system-ca`：走代理（Clash 之类做 TLS 中间人）时 node 默认不认系统证书库，
    # 会报 UNABLE_TO_GET_ISSUER_CERT_LOCALLY。这个开关让 node 用 Windows 证书库。
    $argv = @()
    if (-not $NoProxyCa) { $argv += '--use-system-ca' }
    $argv += @($Pnpm)
    $argv += $PnpmArgs
    Write-Verbose ("pnpm 调用：node " + ($argv -join ' '))
    # ⚠️ 必须真的切到 profile 目录再跑 pnpm：`file:` 这种相对 spec 是相对**项目目录**
    # 解析的。工作目录不对时 pnpm 会去调用者的 cwd 找 tgz（实测 ENOENT）。
    Push-Location -LiteralPath $WorkingDir
    try {
        & $Node @argv
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) { throw "pnpm 退出码 $code（参数：$($PnpmArgs -join ' ')）" }
}

# ── 主流程 ────────────────────────────────────────────────────────────────
$profileName = Resolve-ProfileName $Profile
$profileDir  = Resolve-ProfileDir  $profileName

Say "DSH_HOME   = $(Resolve-DshHome)"
Say "profile    = $profileName"
Say "profile 目录 = $profileDir"
if ($profileName -eq 'desktop') {
    Say "desktop profile 由桌面客户端独占：CLI 的 `dsh plugin` 会拒绝它，所以这里直接改文件（与插件管理器做的事相同）" warn
}

$tools = Resolve-RuntimeTools
Say "node/pnpm  = $($tools.Source)"

if ($Uninstall) {
    Step "卸载 $PackageName"
    $installed = Join-Path $profileDir "node_modules\$PackageName"
    if (-not (Test-Path -LiteralPath $installed)) { Say "没有装（$installed 不存在）"; return }
    if ($WhatIf) { Say "（WhatIf）会 pnpm remove $PackageName 并把它从 bundles 移除"; return }
    Update-Bundles -ProfileDir $profileDir -Name $PackageName -Enable $false -Node $tools.Node
    Invoke-Pnpm -Node $tools.Node -Pnpm $tools.Pnpm -PnpmArgs @('remove', $PackageName) -WorkingDir $profileDir
    Say "已卸载。用户数据（画像/自定义文本）仍在 $(Join-Path (Resolve-DshHome) 'prompt-adapt')，需要的话手动删。" ok
    return
}

Step "1/4 取包"
$packageDir = Join-Path $profileDir '.dsh-packages'
$localTgz = $null
if ($File) {
    if (-not (Test-Path -LiteralPath $File)) { throw "本地文件不存在：$File" }
    $source = (Resolve-Path -LiteralPath $File).Path
    if (-not $WhatIf) { New-Item -ItemType Directory -Force -Path $packageDir | Out-Null }
    # ⚠️ 必须把包**复制进 profile 内**再装：第 2 步交给 pnpm 的是相对路径
    # （`.dsh-packages/xxx.tgz`），相对路径是相对 profile 目录解析的 —— 直接拿外部
    # 绝对路径当"已有文件"会得到一个指向不存在位置的 spec（实测 pnpm ENOENT）。
    $localTgz = Join-Path $packageDir (Split-Path $source -Leaf)
    Say "用本地文件：$source"
    if ($WhatIf) {
        Say "（WhatIf）会把它复制到 $localTgz"
    } elseif ((Get-FileHash -LiteralPath $source).Hash -ne $(if (Test-Path -LiteralPath $localTgz) { (Get-FileHash -LiteralPath $localTgz).Hash } else { '' })) {
        Copy-Item -LiteralPath $source -Destination $localTgz -Force
        Say "已复制到 profile 内：$localTgz" ok
    } else {
        Say "profile 内已有同样的包，跳过复制：$localTgz"
    }
} else {
    $targetUrl = Get-TarballUrl $Tag
    $leaf = Split-Path $targetUrl -Leaf
    if (-not $WhatIf) { New-Item -ItemType Directory -Force -Path $packageDir | Out-Null }
    $localTgz = Join-Path $packageDir $leaf
    Say "目标：$targetUrl"
    if ($WhatIf) {
        Say "（WhatIf）会下载到 $localTgz"
    } elseif (Test-Path -LiteralPath $localTgz) {
        Say "本地已有同版本包，跳过下载（想重下就删掉它）：$localTgz"
    } else {
        try {
            Invoke-Download -Target $targetUrl -Destination $localTgz
        } catch {
            # 默认 tag 指向的那个 release 可能还没建出来（或镜像还没同步到它）。
            # 只在"调用者没显式指定版本"时回退到分支归档：显式点了某个版本却装成
            # 另一个版本，比直接失败更糟。
            if ($PSBoundParameters.ContainsKey('Tag')) { throw }
            Say "默认版本取不到（release 可能还没建），回退到 main 分支归档" warn
            $targetUrl = Get-TarballUrl 'main'
            $localTgz = Join-Path $packageDir (Split-Path $targetUrl -Leaf)
            Invoke-Download -Target $targetUrl -Destination $localTgz
        }
    }
}

Step "2/4 装进 profile"
# 关键取舍：以**本地文件**依赖安装（`file:.dsh-packages/xxx.tgz`），而不是记录镜像 URL。
#   · 镜像 URL 会写进 package.json/lockfile —— 哪天镜像挂了，以后每次 pnpm install 都失败；
#   · file: 依赖把 tgz 留在 profile 内，之后离线可重装，且被 pnpm 的 lockfile 正常记账
#     （插件管理器下次做包操作时不会把它当"没有清单引用的残留"清掉）。
$relativeTgz = ".dsh-packages/" + (Split-Path $localTgz -Leaf)
if ($WhatIf) {
    Say "（WhatIf）会在 $profileDir 执行：pnpm add $relativeTgz"
} else {
    Invoke-Pnpm -Node $tools.Node -Pnpm $tools.Pnpm -PnpmArgs @('add', $relativeTgz) -WorkingDir $profileDir
}

Step "3/4 登记为 bundle"
Update-Bundles -ProfileDir $profileDir -Name $PackageName -Enable $true -Node $tools.Node

Step "4/4 校验"
if (-not $WhatIf) {
    $manifestPath = Join-Path $profileDir "node_modules\$PackageName\package.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "安装后找不到 $manifestPath —— pnpm 可能失败了" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $entry = Join-Path $profileDir "node_modules\$PackageName\lib\index.js"
    if (-not (Test-Path -LiteralPath $entry)) { throw "包不完整：缺 $entry" }
    $clientOk = Test-Path -LiteralPath (Join-Path $profileDir "node_modules\$PackageName\lib\client.js")
    Say "$($manifest.name)@$($manifest.version) 已就位（宿主入口 + 客户端半边：$clientOk）" ok
}

Write-Host ""
Say "完成。生效方式：" ok
if ($profileName -eq 'desktop') {
    Say "  桌面客户端：**刷新页面**（设置 → AI 适配）；没出现就重启客户端。"
} else {
    Say "  重启用这个 profile 的宿主进程。"
}
Say "  插件数据在 $(Join-Path (Resolve-DshHome) 'prompt-adapt')（卸载不会删）。"
