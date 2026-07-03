import * as core from "@actions/core";
import * as github from "@actions/github";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type GitHubContext = {
  actor?: string;
  apiUrl?: string;
  eventName: string;
  graphqlUrl?: string;
  payload?: {
    before?: string;
    pull_request?: {
      number?: number;
      head?: { ref?: string; sha?: string };
      base?: { ref?: string; sha?: string };
    };
  };
  ref: string;
  repo: {
    owner: string;
    repo: string;
  };
  runAttempt?: number;
  runId?: number;
  serverUrl?: string;
  sha: string;
  workflow?: string;
};

type CoreLike = Pick<
  typeof core,
  "debug" | "getInput" | "info" | "setFailed" | "setSecret" | "warning"
>;

type FetchLike = typeof fetch;
type GitExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export type ActionConfig = {
  duckpostEndpoint: string;
  includeDiffMetadata: boolean;
  productionBranch: string;
  timeoutMs: number;
};

const DEFAULT_DUCKPOST_ENDPOINT = "https://duckpost.app/api/ai-release-jobs";
const TRUSTED_DUCKPOST_HOSTS = new Set(["duckpost.app"]);

export type DiffMetadata =
  | {
      available: true;
      baseRef: string;
      commits: Array<{ sha: string; subject: string }>;
      filesChanged: string[];
      headSha: string;
      mergeBase: string;
      shortStat: string | null;
    }
  | {
      available: false;
      reason: string;
      shallow?: boolean;
    };

export type DuckPostPayload = {
  before_sha?: string | null;
  changed_files: Array<{
    additions?: number;
    deletions?: number;
    filename: string;
    status?: string;
  }>;
  commit_sha: string;
  commits: Array<{ message: string; sha: string }>;
  compare_url?: string | null;
  diff_summary: string;
  event_name: "pull_request" | "push" | "workflow_dispatch";
  idempotency_key: string;
  pull_request_number?: number;
  release_branch: string;
  repository_name: string;
  repository_owner: string;
};

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

export function parseBooleanInput(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new ActionError(`Invalid boolean input: ${value}`);
}

export function parseTimeoutMs(value: string): number {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new ActionError("timeout-ms must be an integer between 1000 and 300000.");
  }
  const timeoutMs = Number(normalized);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new ActionError("timeout-ms must be an integer between 1000 and 300000.");
  }
  return timeoutMs;
}

function hasUnsafeBranchCharacter(value: string): boolean {
  if (/[\s~^:?*[\\\]]/u.test(value)) {
    return true;
  }
  for (const char of value) {
    const codePoint = char.charCodeAt(0);
    if (codePoint <= 31 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

export function normalizeBranchInput(input: string, label: string): string {
  let branch = input.trim();
  if (branch.startsWith("refs/heads/")) {
    branch = branch.slice("refs/heads/".length);
  }

  if (!branch) {
    throw new ActionError(`${label} is required.`);
  }

  if (branch.length > 255) {
    throw new ActionError(`${label} is too long.`);
  }

  const invalid =
    branch === "HEAD" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    hasUnsafeBranchCharacter(branch);

  if (invalid) {
    throw new ActionError(
      `${label} must be a valid branch name, not a ref expression or unsafe value.`,
    );
  }

  return branch;
}

export function validateProductionBranch(productionBranchInput: string) {
  return normalizeBranchInput(productionBranchInput, "production-branch");
}

export function validateDuckPostEndpoint(input: string): string {
  const endpoint = input.trim() || DEFAULT_DUCKPOST_ENDPOINT;
  let parsed: URL;

  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ActionError("duckpost-endpoint must be a valid HTTPS URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new ActionError("duckpost-endpoint must use HTTPS.");
  }

  if (!TRUSTED_DUCKPOST_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new ActionError("duckpost-endpoint must use a trusted DuckPost host.");
  }

  return parsed.toString();
}

export function readConfig(actionCore: Pick<CoreLike, "getInput">): ActionConfig {
  const productionBranch = validateProductionBranch(
    actionCore.getInput("production-branch", { required: true }),
  );

  return {
    duckpostEndpoint: validateDuckPostEndpoint(actionCore.getInput("duckpost-endpoint")),
    includeDiffMetadata: parseBooleanInput(actionCore.getInput("include-diff-metadata") || "true"),
    productionBranch,
    timeoutMs: parseTimeoutMs(actionCore.getInput("timeout-ms") || "30000"),
  };
}

export function readDuckPostToken(env: NodeJS.ProcessEnv): string {
  const token = env.DUCKPOST_TOKEN?.trim();
  if (!token) {
    throw new ActionError("DUCKPOST_TOKEN environment variable is required.");
  }
  return token;
}

export function createIdempotencyKey(
  context: GitHubContext,
  productionBranch: string,
): string {
  const headSha = payloadHeadSha(context);
  const eventIdentity =
    context.eventName === "pull_request" && typeof context.payload?.pull_request?.number === "number"
      ? `pull_request:${context.payload.pull_request.number}:${headSha}`
      : `${context.eventName}:${context.ref}:${headSha}`;

  return [
    "github",
    `${context.repo.owner}/${context.repo.repo}`,
    eventIdentity,
    productionBranch,
  ].join(":");
}

function eventName(context: GitHubContext): DuckPostPayload["event_name"] {
  if (
    context.eventName === "pull_request" ||
    context.eventName === "push" ||
    context.eventName === "workflow_dispatch"
  ) {
    return context.eventName;
  }
  throw new ActionError(`Unsupported GitHub event: ${context.eventName}`);
}

function payloadHeadSha(context: GitHubContext): string {
  if (context.eventName === "pull_request") {
    return usableCommitSha(context.payload?.pull_request?.head?.sha) ?? context.sha;
  }
  return context.sha;
}

export function shouldProcessContext(
  context: GitHubContext,
  productionBranch: string,
): { process: true } | { process: false; reason: string } {
  if (context.eventName === "pull_request") {
    const baseRef = context.payload?.pull_request?.base?.ref;
    if (baseRef !== productionBranch) {
      return {
        process: false,
        reason: `Skipping DuckPost release notes because pull request base ${baseRef ?? "(unknown)"} does not match ${productionBranch}.`,
      };
    }
    return { process: true };
  }

  const productionRef = `refs/heads/${productionBranch}`;
  if (context.eventName === "push") {
    if (context.ref !== productionRef) {
      return {
        process: false,
        reason: `Skipping DuckPost release notes because push ref ${context.ref} does not match ${productionRef}.`,
      };
    }
    return { process: true };
  }

  if (context.eventName === "workflow_dispatch") {
    if (context.ref !== productionRef) {
      return {
        process: false,
        reason: `Skipping DuckPost release notes because workflow_dispatch ref ${context.ref} does not match ${productionRef}.`,
      };
    }
    return { process: true };
  }

  return {
    process: false,
    reason: `Skipping DuckPost release notes because ${context.eventName} is not a supported event.`,
  };
}

export function buildPayload(
  context: GitHubContext,
  config: Pick<ActionConfig, "productionBranch">,
  diff: DiffMetadata | null,
): DuckPostPayload {
  const idempotencyKey = createIdempotencyKey(
    context,
    config.productionBranch,
  );
  const pullRequest = context.payload?.pull_request;
  const normalizedEventName = eventName(context);
  const headSha = payloadHeadSha(context);
  const beforeSha =
    diff?.available === true
      ? diff.mergeBase
      : pullRequest?.base?.sha ?? null;
  const compareUrl =
    beforeSha && context.serverUrl
      ? `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/compare/${beforeSha}...${headSha}`
      : null;
  const commits =
    diff?.available === true && diff.commits.length > 0
      ? diff.commits.slice(0, 100).map((commit) => ({
          message: commit.subject,
          sha: commit.sha,
        }))
      : [{
          message: `${context.eventName} on ${context.ref}`,
          sha: headSha,
        }];
  const diffSummary =
    diff === null
      ? "Diff metadata collection disabled by action input."
      : diff.available
        ? [
            diff.shortStat,
            diff.filesChanged.length > 0
              ? `Changed files: ${diff.filesChanged.slice(0, 200).join(", ")}`
              : null,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n") || "No git diff summary available."
        : diff.reason;

  return {
    before_sha: beforeSha,
    changed_files:
      diff?.available === true
        ? diff.filesChanged.slice(0, 200).map((filename) => ({
            filename,
            status: "modified",
          }))
        : [],
    commit_sha: headSha,
    commits,
    compare_url: compareUrl,
    diff_summary: diffSummary,
    event_name: normalizedEventName,
    idempotency_key: idempotencyKey,
    ...(typeof pullRequest?.number === "number"
      ? { pull_request_number: pullRequest.number }
      : {}),
    release_branch: config.productionBranch,
    repository_name: context.repo.repo,
    repository_owner: context.repo.owner,
  };
}

async function git(
  gitExec: GitExec,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await gitExec("git", args);
  return stdout.trim();
}

function parseGitLog(stdout: string): Array<{ sha: string; subject: string }> {
  if (!stdout.trim()) return [];
  const commits: Array<{ sha: string; subject: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [sha, ...subjectParts] = line.split("\t");
    if (!sha) continue;
    commits.push({
      sha,
      subject: subjectParts.join("\t"),
    });
  }
  return commits;
}

function usableCommitSha(value: string | undefined): string | null {
  const sha = value?.trim();
  if (!sha) return null;
  if (!/^[a-f0-9]{40}$/iu.test(sha)) return null;
  if (/^0{40}$/u.test(sha)) return null;
  return sha;
}

function pushBeforeSha(context: GitHubContext): string | null {
  if (context.eventName !== "push") return null;
  return usableCommitSha(context.payload?.before);
}

export async function collectDiffMetadata(
  productionBranch: string,
  context: GitHubContext,
  gitExec: GitExec = execFile,
): Promise<DiffMetadata> {
  try {
    const isShallow = await git(gitExec, ["rev-parse", "--is-shallow-repository"]);
    if (isShallow === "true") {
      return {
        available: false,
        reason: "Repository is shallow. Use actions/checkout with fetch-depth: 0 to include diff metadata.",
        shallow: true,
      };
    }

    const headSha = await git(gitExec, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${context.sha || "HEAD"}^{commit}`,
    ]);
    const beforeSha = pushBeforeSha(context);
    let baseRef: string | null = null;
    let mergeBase: string | null = null;

    if (beforeSha) {
      try {
        baseRef = await git(gitExec, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${beforeSha}^{commit}`,
        ]);
        mergeBase = baseRef;
      } catch {
        baseRef = null;
      }
    }

    if (!baseRef) {
      const candidateBaseRefs = [
        `refs/remotes/origin/${productionBranch}^{commit}`,
        `refs/heads/${productionBranch}^{commit}`,
      ];

      for (const candidate of candidateBaseRefs) {
        try {
          baseRef = await git(gitExec, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            candidate,
          ]);
          break;
        } catch {
          continue;
        }
      }
    }

    if (!baseRef) {
      return {
        available: false,
        reason: `Could not resolve production branch ${productionBranch}. Ensure checkout includes the production branch with fetch-depth: 0.`,
      };
    }

    mergeBase ??= await git(gitExec, ["merge-base", baseRef, headSha]);
    const range = `${mergeBase}..${headSha}`;
    const filesChangedOutput = await git(gitExec, ["diff", "--name-only", range]);
    const commitsOutput = await git(gitExec, ["log", "--format=%H%x09%s", range]);
    const shortStat = await git(gitExec, ["diff", "--shortstat", range]);

    return {
      available: true,
      baseRef,
      commits: parseGitLog(commitsOutput),
      filesChanged: filesChangedOutput ? filesChangedOutput.split("\n") : [],
      headSha,
      mergeBase,
      shortStat: shortStat || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: `Could not collect git diff metadata: ${message}`,
    };
  }
}

export async function postToDuckPost(
  config: Pick<ActionConfig, "duckpostEndpoint" | "timeoutMs">,
  token: string,
  payload: DuckPostPayload,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(config.duckpostEndpoint, {
      body: JSON.stringify(payload),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": payload.idempotency_key,
      },
      method: "POST",
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      const suffix = responseText ? `: ${responseText.slice(0, 500)}` : "";
      throw new ActionError(`DuckPost request failed with HTTP ${response.status}${suffix}`);
    }
  } catch (error) {
    if (error instanceof ActionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ActionError(`DuckPost request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function run(
  actionCore: CoreLike = core,
  context: GitHubContext = github.context,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
  gitExec: GitExec = execFile,
): Promise<void> {
  try {
    const config = readConfig(actionCore);
    const decision = shouldProcessContext(context, config.productionBranch);
    if (!decision.process) {
      actionCore.info(decision.reason);
      return;
    }

    const token = readDuckPostToken(env);
    actionCore.setSecret(token);

    const diff = config.includeDiffMetadata
      ? await collectDiffMetadata(config.productionBranch, context, gitExec)
      : null;

    if (diff && !diff.available) {
      actionCore.warning(diff.reason);
    }

    const payload = buildPayload(context, config, diff);
    actionCore.info(
      `Requesting DuckPost release notes for ${payload.repository_owner}/${payload.repository_name} ${config.productionBranch}.`,
    );
    await postToDuckPost(config, token, payload, fetchImpl);
    actionCore.info("DuckPost release note generation request accepted.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    actionCore.setFailed(message);
  }
}

if (process.env.VITEST !== "true") {
  void run();
}
