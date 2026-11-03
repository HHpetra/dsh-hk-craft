#requires -Version 7.0
<#
.SYNOPSIS
把 Matt Pocock skills 同步到本仓库的 .cursor/skills/：默认优先用本机副本。

.DESCRIPTION
- 来源优先级：显式 -Source → 本机 -Local（默认 ~/.agents/skills）→ GitHub（-Repo / -Ref）。
  本机装过 skills 就直接复制，只有本机没有时才下载，避免无谓的网络依赖。
- 目标：-Root 下 .cursor/skills/<name>/SKILL.md。
- 先删后拷：不会残留改名后的旧目录；同步后请把 .cursor/skills 的 diff 一起提交。
- skill 副本是**入库**的（不要 gitignore），云端 agent 才能从仓库里读到。

.PARAMETER Root
项目根目录，默认为脚本所在目录的上一级。

.PARAMETER Local
本机 skills 根目录，默认 ~/.agents/skills。存在就优先使用，不存在才走 GitHub。

.PARAMETER Source
显式指定 skills 根目录（优先级最高，离线 / 内网镜像用）。

.PARAMETER Repo
GitHub 仓库，owner/name 形式，默认 mattpocock/skills。

.PARAMETER Ref
分支或 tag，默认 main（也接受 refs/heads/x、refs/tags/v1）。

.PARAMETER Skills
只同步这些 skill；默认取官方工程流所需的一整套。

.EXAMPLE
pwsh scripts/sync-cursor-skills.ps1

.EXAMPLE
pwsh scripts/sync-cursor-skills.ps1 -Local D:\mirror\skills
#>
param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$Local = (Join-Path $HOME '.agents/skills'),
  [string]$Source = '',
  [string]$Repo = 'mattpocock/skills',
  [string]$Ref = 'main',
  [string[]]$Skills = @(
    'ask-matt', 'code-review', 'codebase-design', 'diagnosing-bugs', 'domain-modeling',
    'grill-me', 'grill-with-docs', 'grilling', 'implement', 'implement-spec',
    'improve-codebase-architecture', 'pr', 'prototype', 'research', 'retro',
    'setup-matt-pocock-skills', 'tdd', 'to-spec', 'to-tickets', 'triage',
    'wayfinder', 'wizard'
  )
)

$ErrorActionPreference = 'Stop'

function Resolve-SkillsRoot {
  if ($Source) {
    if (-not (Test-Path $Source)) { throw "找不到 -Source 指定的目录：$Source" }
    return (Resolve-Path $Source).Path
  }

  if (Test-Path $Local) {
    Write-Host "使用本机 skills：$((Resolve-Path $Local).Path)"
    return (Resolve-Path $Local).Path
  }

  Write-Host "本机没有 $Local，改从 GitHub 拉取"
  $refPath = if ($Ref -match '^refs/') { $Ref }
             elseif ($Ref -match '^\d+\.\d+') { "refs/tags/$Ref" }
             else { "refs/heads/$Ref" }
  $base = ($Ref -replace '^refs/(heads|tags)/', '')
  $url = "https://codeload.github.com/$Repo/zip/$refPath"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("mp-skills-" + [guid]::NewGuid().ToString('N'))
  $zip = "$tmp.zip"

  Write-Host "下载 $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $top = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $top) { throw "解压后没有顶层目录，检查 Ref：$Ref" }

    $candidate = Join-Path $top.FullName 'skills'
    if (-not (Test-Path $candidate)) {
      throw "在 $($top.Name) 下没找到 skills/ 目录；仓库结构可能变了，请检查 $Repo@$base"
    }
    return $candidate
  }
  catch {
    throw "本机没有 $Local，GitHub 下载也失败：$($_.Exception.Message.Trim())。可用 -Local 或 -Source 指定离线目录。"
  }
  finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
}

$skillsRoot = Resolve-SkillsRoot
$dest = Join-Path (Resolve-Path $Root).Path '.cursor/skills'
New-Item -ItemType Directory -Force $dest | Out-Null
$copied = 0
$missing = @()

foreach ($s in $Skills) {
  $from = Join-Path $skillsRoot $s
  if (-not (Test-Path $from)) { $missing += $s; continue }
  $to = Join-Path $dest $s
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $from $to -Recurse
  $copied++
}

Write-Host ("完成：复制 {0} 个技能目录到 {1}{2}。" -f $copied, $dest, $(if ($missing) { "（源缺失 $($missing.Count) 个：$($missing -join ', ')）" } else { '' }))
Write-Host "副本已入库（非 gitignore），升级后请连同 .cursor/skills 的 diff 一起提交。"
