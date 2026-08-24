import path from "node:path"
import { Process } from "@/util/process"
import type { Compose } from "@opencode-ai/schema/compose"
import { composeWorktreeDigest } from "./worktree-digest"

export type GitFinishResult = {
  message: string
  prURL?: string
  removeWorktree: boolean
  deleteBranch: boolean
  forceRemove: boolean
}

export class ComposeGitFinishError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ComposeGitFinishError"
  }
}

function output(result: Process.TextResult) {
  return result.stderr.toString("utf8").trim() || result.text.trim()
}

function message(runInfo: Compose.Info, chinese: string, english: string) {
  return runInfo.language === "en" ? english : chinese
}

async function run(command: string[], cwd: string) {
  const result = await Process.text(command, { cwd, nothrow: true })
  if (result.code !== 0) throw new ComposeGitFinishError(output(result) || `命令执行失败：${command.join(" ")}`)
  return result
}

async function existingPR(branch: string, cwd: string) {
  const result = await Process.text(["gh", "pr", "view", branch, "--json", "url", "--jq", ".url"], {
    cwd,
    nothrow: true,
  }).catch(() => undefined)
  if (!result || result.code !== 0) return
  return result.text.trim().split(/\r?\n/).findLast(Boolean)
}

function requireBranch(runInfo: Compose.Info) {
  const branch = runInfo.git.branch
  if (!branch || !branch.startsWith("workmesh/compose/")) {
    throw new ComposeGitFinishError(
      message(runInfo, "Compose 运行没有可收尾的 WorkMesh 分支", "The Compose run has no WorkMesh branch to finish"),
    )
  }
  return branch
}

function requireWorktree(runInfo: Compose.Info) {
  const worktree = runInfo.git.worktree
  if (!worktree)
    throw new ComposeGitFinishError(
      message(runInfo, "Compose 运行没有可收尾的 Worktree", "The Compose run has no worktree to finish"),
    )
  const expected = path.resolve(runInfo.projectRoot, ".workmesh", "worktrees")
  const resolved = path.resolve(worktree)
  const relative = path.relative(expected, resolved)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ComposeGitFinishError(
      message(
        runInfo,
        "Compose Worktree 不在项目的 .workmesh/worktrees 目录中",
        "The Compose worktree is outside the project's .workmesh/worktrees directory",
      ),
    )
  }
  return resolved
}

async function commitReviewedTree(runInfo: Compose.Info) {
  const worktree = requireWorktree(runInfo)
  const tree = runInfo.git.reviewedTreeHash
  if (!tree) throw new ComposeGitFinishError(message(runInfo, "Compose 运行缺少已审查 Git tree", "Missing reviewed Git tree"))
  const head = (await run(["git", "rev-parse", "HEAD"], worktree)).text.trim()
  const headTree = (await run(["git", "rev-parse", "HEAD^{tree}"], worktree)).text.trim()
  if (headTree === tree) return worktree
  const subject = runInfo.task.replace(/\s+/g, " ").trim().slice(0, 72) || runInfo.id
  const commit = (
    await run(["git", "commit-tree", tree, "-p", head, "-m", `feat(compose): ${subject}`], worktree)
  ).text.trim()
  const branch = requireBranch(runInfo)
  await run(["git", "update-ref", `refs/heads/${branch}`, commit, head], worktree)
  await run(["git", "reset", "--mixed", commit], worktree)
  return worktree
}

export async function executeGitFinish(runInfo: Compose.Info, action: Compose.FinishAction): Promise<GitFinishResult> {
  if (runInfo.phase !== "awaiting_finish" || runInfo.status !== "awaiting_finish") {
    throw new ComposeGitFinishError(
      message(
        runInfo,
        "只有等待收尾确认的 Compose 运行可以执行 Git 操作",
        "Only a Compose run awaiting finish confirmation may perform Git operations",
      ),
    )
  }
  if (action === "keep") {
    return {
      message: message(
        runInfo,
        `已保留 Compose 分支和 Worktree：${runInfo.git.branch ?? runInfo.id}`,
        `Kept Compose branch and worktree: ${runInfo.git.branch ?? runInfo.id}`,
      ),
      removeWorktree: false,
      deleteBranch: false,
      forceRemove: false,
    }
  }

  const branch = requireBranch(runInfo)
  const worktree = requireWorktree(runInfo)

  if (action === "discard") {
    return {
      message: message(runInfo, `已放弃 Compose 运行：${runInfo.id}`, `Discarded Compose run: ${runInfo.id}`),
      removeWorktree: true,
      deleteBranch: true,
      forceRemove: true,
    }
  }

  if (!runInfo.git.reviewedTreeHash || (await composeWorktreeDigest(worktree)) !== runInfo.git.reviewedTreeHash) {
    throw new ComposeGitFinishError(
      message(
        runInfo,
        "Compose 工作树在 Review 通过后发生变化，拒绝执行 Git 收尾",
        "The Compose worktree changed after review; Git finish was refused",
      ),
    )
  }

  await commitReviewedTree(runInfo)

  if (action === "push") {
    await run(["git", "push", "--set-upstream", "origin", branch], worktree)
    return {
      message: message(runInfo, `已推送分支：${branch}`, `Pushed branch: ${branch}`),
      removeWorktree: true,
      deleteBranch: false,
      forceRemove: false,
    }
  }

  if (action === "create_pr") {
    const base = runInfo.git.baseBranch
    if (!base)
      throw new ComposeGitFinishError(
        message(runInfo, "Compose 运行缺少 PR 的目标分支", "The Compose run has no PR base branch"),
      )
    await run(["git", "push", "--set-upstream", "origin", branch], worktree)
    const knownURL = await existingPR(branch, worktree)
    const created = knownURL
      ? undefined
      : await run(["gh", "pr", "create", "--base", base, "--head", branch, "--fill"], worktree).catch(async (error) => {
          const recoveredURL = await existingPR(branch, worktree)
          if (recoveredURL) return { text: recoveredURL }
          const detail = error instanceof Error ? error.message : String(error)
          throw new ComposeGitFinishError(
            message(
              runInfo,
              `创建 PR 失败；已保留并推送 Compose 分支，不会自动降级为其他收尾方式。\n${detail}`,
              `Failed to create the PR. The pushed Compose branch is preserved and no fallback finish action was used.\n${detail}`,
            ),
            { cause: error },
          )
        })
    const prURL = knownURL ?? created?.text.trim().split(/\r?\n/).findLast(Boolean)
    return {
      message: prURL
        ? message(runInfo, `已创建 PR：${prURL}`, `Created PR: ${prURL}`)
        : message(runInfo, `已创建 ${branch} 的 PR`, `Created a PR for ${branch}`),
      prURL,
      removeWorktree: true,
      deleteBranch: false,
      forceRemove: false,
    }
  }

  const base = runInfo.git.baseBranch
  if (!base)
    throw new ComposeGitFinishError(
      message(runInfo, "Compose 运行缺少本地合并的目标分支", "The Compose run has no local merge base branch"),
    )
  const current = (await run(["git", "branch", "--show-current"], runInfo.projectRoot)).text.trim()
  if (current !== base) {
    throw new ComposeGitFinishError(
      message(
        runInfo,
        `当前分支为 ${current || "detached HEAD"}，请切换到 ${base} 后再执行本地合并`,
        `The current branch is ${current || "detached HEAD"}; switch to ${base} before merging locally`,
      ),
    )
  }
  const rootStatus = await run(["git", "status", "--porcelain=v1"], runInfo.projectRoot)
  if (rootStatus.text.trim())
    throw new ComposeGitFinishError(
      message(
        runInfo,
        "项目主 Worktree 存在未提交改动，不能安全执行本地合并",
        "The primary project worktree has uncommitted changes, so a local merge is not safe",
      ),
    )
  await run(["git", "merge", "--no-ff", branch], runInfo.projectRoot)
  return {
    message: message(runInfo, `已将 ${branch} 本地合并到 ${base}`, `Merged ${branch} locally into ${base}`),
    removeWorktree: true,
    deleteBranch: true,
    forceRemove: false,
  }
}
