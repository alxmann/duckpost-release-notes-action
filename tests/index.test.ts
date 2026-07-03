import { describe, expect, it, vi } from "vitest";
import {
  buildPayload,
  collectDiffMetadata,
  parseTimeoutMs,
  postToDuckPost,
  readConfig,
  readDuckPostToken,
  run,
  shouldProcessContext,
  validateDuckPostEndpoint,
  validateProductionBranch,
  type GitHubContext,
} from "../src/index.js";

const context: GitHubContext = {
  actor: "octocat",
  apiUrl: "https://api.github.com",
  eventName: "push",
  graphqlUrl: "https://api.github.com/graphql",
  payload: {},
  ref: "refs/heads/main",
  repo: { owner: "duckpost", repo: "app" },
  runAttempt: 1,
  runId: 12345,
  serverUrl: "https://github.com",
  sha: "abc123",
  workflow: "Release notes",
};

function createCore(inputs: Record<string, string>) {
  return {
    debug: vi.fn(),
    getInput: vi.fn((name: string) => inputs[name] ?? ""),
    info: vi.fn(),
    setFailed: vi.fn(),
    setSecret: vi.fn(),
    warning: vi.fn(),
  };
}

describe("auth", () => {
  it("requires DUCKPOST_TOKEN", () => {
    expect(() => readDuckPostToken({})).toThrow("DUCKPOST_TOKEN");
    expect(() => readDuckPostToken({ DUCKPOST_TOKEN: "   " })).toThrow("DUCKPOST_TOKEN");
  });

  it("masks the token before network calls and never logs it", async () => {
    const core = createCore({
      "production-branch": "main",
      "duckpost-endpoint": "https://duckpost.app/api/ai-release-jobs",
      "include-diff-metadata": "false",
      "timeout-ms": "30000",
    });
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));

    await run(
      core,
      context,
      { DUCKPOST_TOKEN: "super-secret-token" },
      fetchImpl,
      vi.fn(),
    );

    expect(core.setSecret).toHaveBeenCalledWith("super-secret-token");
    expect(core.setFailed).not.toHaveBeenCalled();

    const logged = [
      ...core.info.mock.calls.flat(),
      ...core.warning.mock.calls.flat(),
      ...core.debug.mock.calls.flat(),
    ].join("\n");
    expect(logged).not.toContain("super-secret-token");
  });
});

describe("branch validation", () => {
  it("normalizes refs/heads prefixes", () => {
    expect(validateProductionBranch("refs/heads/main")).toBe("main");
  });

  it.each([
    ["feature with space"],
    ["main..prod"],
    ["main~prod"],
    ["main^prod"],
    ["main:prod"],
    ["main?prod"],
    ["main*prod"],
    ["main[prod"],
    ["main\\prod"],
    ["main@{prod"],
    ["/main"],
    ["main/"],
    ["main.lock"],
    ["HEAD"],
    ["-main"],
  ])("rejects unsafe branch value %s", (branch) => {
    expect(() => validateProductionBranch(branch)).toThrow("production-branch");
  });
});

describe("payload", () => {
  it("builds the expected DuckPost payload shape", () => {
    const diff = {
      available: true as const,
      baseRef: "aaa111",
      commits: [{ sha: "bbb222", subject: "Ship release notes" }],
      filesChanged: ["src/index.ts"],
      headSha: "abc123",
      mergeBase: "aaa111",
      shortStat: "1 file changed, 2 insertions(+)",
    };

    expect(buildPayload(context, { productionBranch: "main" }, diff)).toEqual({
      before_sha: "aaa111",
      changed_files: [{ filename: "src/index.ts", status: "modified" }],
      commit_sha: "abc123",
      commits: [{ message: "Ship release notes", sha: "bbb222" }],
      compare_url: "https://github.com/duckpost/app/compare/aaa111...abc123",
      diff_summary: "1 file changed, 2 insertions(+)\nChanged files: src/index.ts",
      event_name: "push",
      idempotency_key: "github:duckpost/app:push:refs/heads/main:abc123:main",
      release_branch: "main",
      repository_name: "app",
      repository_owner: "duckpost",
    });
  });

  it("falls back to pull request base SHA when git diff metadata is unavailable", () => {
    const prContext: GitHubContext = {
      ...context,
      eventName: "pull_request",
      ref: "refs/pull/42/merge",
      payload: {
        pull_request: {
          number: 42,
          base: { ref: "main", sha: "aaa111" },
          head: { ref: "release/1.2.3", sha: "abc123" },
        },
      },
    };

    const payload = buildPayload(prContext, { productionBranch: "main" }, null);
    expect(payload.before_sha).toBe("aaa111");
    expect(payload.event_name).toBe("pull_request");
    expect(payload.pull_request_number).toBe(42);
    expect(payload.commits).toEqual([
      { message: "pull_request on refs/pull/42/merge", sha: "abc123" },
    ]);
  });

  it("uses the pull request head SHA in the DuckPost payload", () => {
    const headSha = "2222222222222222222222222222222222222222";
    const prContext: GitHubContext = {
      ...context,
      eventName: "pull_request",
      ref: "refs/pull/42/merge",
      sha: "1111111111111111111111111111111111111111",
      payload: {
        pull_request: {
          number: 42,
          base: {
            ref: "main",
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          head: {
            ref: "feature/release",
            sha: headSha,
          },
        },
      },
    };

    const payload = buildPayload(prContext, { productionBranch: "main" }, null);
    expect(payload.commit_sha).toBe(headSha);
    expect(payload.compare_url).toBe(
      `https://github.com/duckpost/app/compare/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...${headSha}`,
    );
    expect(payload.commits).toEqual([
      { message: "pull_request on refs/pull/42/merge", sha: headSha },
    ]);
    expect(payload.idempotency_key).toBe(`github:duckpost/app:pull_request:42:${headSha}:main`);
  });
});

describe("idempotency and request", () => {
  it("keeps the same idempotency key across reruns", () => {
    const firstPayload = buildPayload(
      { ...context, runAttempt: 1 },
      { productionBranch: "main" },
      null,
    );
    const rerunPayload = buildPayload(
      { ...context, runAttempt: 2 },
      { productionBranch: "main" },
      null,
    );

    expect(rerunPayload.idempotency_key).toBe(firstPayload.idempotency_key);
  });

  it("sends idempotency key in the payload and header", async () => {
    const payload = buildPayload(
      context,
      { productionBranch: "main" },
      null,
    );
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));

    await postToDuckPost(
      { duckpostEndpoint: "https://duckpost.app/api/ai-release-jobs", timeoutMs: 30000 },
      "token-123",
      payload,
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://duckpost.app/api/ai-release-jobs",
      expect.objectContaining({
        body: expect.stringContaining(payload.idempotency_key),
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
          "Idempotency-Key": payload.idempotency_key,
        }),
        method: "POST",
      }),
    );
  });

  it("fails on network errors without leaking the token", async () => {
    const payload = buildPayload(
      context,
      { productionBranch: "main" },
      null,
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    await expect(
      postToDuckPost(
        { duckpostEndpoint: "https://duckpost.app/api/ai-release-jobs", timeoutMs: 30000 },
        "secret-token",
        payload,
        fetchImpl,
      ),
    ).rejects.toThrow("ECONNRESET");
  });

  it("fails on non-2xx responses", async () => {
    const payload = buildPayload(
      context,
      { productionBranch: "main" },
      null,
    );

    await expect(
      postToDuckPost(
        { duckpostEndpoint: "https://duckpost.app/api/ai-release-jobs", timeoutMs: 30000 },
        "secret-token",
        payload,
        vi.fn(async () => new Response("invalid request", { status: 400 })),
      ),
    ).rejects.toThrow("HTTP 400");
  });
});

describe("endpoint validation", () => {
  it("accepts the trusted DuckPost HTTPS endpoint", () => {
    expect(validateDuckPostEndpoint("")).toBe("https://duckpost.app/api/ai-release-jobs");
    expect(validateDuckPostEndpoint("https://duckpost.app/api/ai-release-jobs")).toBe(
      "https://duckpost.app/api/ai-release-jobs",
    );
  });

  it.each([
    ["http://duckpost.app/api/ai-release-jobs"],
    ["https://evil.example/api/ai-release-jobs"],
    ["not a url"],
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => validateDuckPostEndpoint(endpoint)).toThrow("duckpost-endpoint");
  });
});

describe("diff metadata", () => {
  it("returns a shallow-repository warning instead of guessing", async () => {
    const gitExec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.join(" ") === "rev-parse --is-shallow-repository") {
        return { stdout: "true\n", stderr: "" };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    await expect(collectDiffMetadata("main", context, gitExec)).resolves.toEqual({
      available: false,
      reason: "Repository is shallow. Use actions/checkout with fetch-depth: 0 to include diff metadata.",
      shallow: true,
    });
  });

  it("collects changed files, commits, and shortstat from git", async () => {
    const gitExec = vi.fn(async (_file: string, args: readonly string[]) => {
      const command = args.join(" ");
      switch (command) {
        case "rev-parse --is-shallow-repository":
          return { stdout: "false\n", stderr: "" };
        case "rev-parse --verify --end-of-options abc123^{commit}":
          return { stdout: "abc123\n", stderr: "" };
        case "rev-parse --verify --end-of-options refs/remotes/origin/main^{commit}":
          return { stdout: "aaa111\n", stderr: "" };
        case "merge-base aaa111 abc123":
          return { stdout: "base000\n", stderr: "" };
        case "diff --name-only base000..abc123":
          return { stdout: "src/index.ts\nREADME.md\n", stderr: "" };
        case "log --format=%H%x09%s base000..abc123":
          return { stdout: "bbb222\tAdd action\nccc333\tAdd tests\n", stderr: "" };
        case "diff --shortstat base000..abc123":
          return { stdout: " 2 files changed, 10 insertions(+)\n", stderr: "" };
        default:
          throw new Error(`Unexpected git args: ${command}`);
      }
    });

    await expect(collectDiffMetadata("main", context, gitExec)).resolves.toEqual({
      available: true,
      baseRef: "aaa111",
      commits: [
        { sha: "bbb222", subject: "Add action" },
        { sha: "ccc333", subject: "Add tests" },
      ],
      filesChanged: ["src/index.ts", "README.md"],
      headSha: "abc123",
      mergeBase: "base000",
      shortStat: "2 files changed, 10 insertions(+)",
    });
  });

  it("uses the push before SHA as the production branch base", async () => {
    const pushContext: GitHubContext = {
      ...context,
      payload: {
        before: "1111111111111111111111111111111111111111",
      },
      sha: "2222222222222222222222222222222222222222",
    };
    const gitExec = vi.fn(async (_file: string, args: readonly string[]) => {
      const command = args.join(" ");
      switch (command) {
        case "rev-parse --is-shallow-repository":
          return { stdout: "false\n", stderr: "" };
        case "rev-parse --verify --end-of-options 2222222222222222222222222222222222222222^{commit}":
          return { stdout: "2222222222222222222222222222222222222222\n", stderr: "" };
        case "rev-parse --verify --end-of-options 1111111111111111111111111111111111111111^{commit}":
          return { stdout: "1111111111111111111111111111111111111111\n", stderr: "" };
        case "diff --name-only 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222":
          return { stdout: "apps/api/src/routes/ai-integrations.ts\n", stderr: "" };
        case "log --format=%H%x09%s 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222":
          return {
            stdout: "2222222222222222222222222222222222222222\tFix release workflow\n",
            stderr: "",
          };
        case "diff --shortstat 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222":
          return { stdout: " 1 file changed, 1 insertion(+)\n", stderr: "" };
        default:
          throw new Error(`Unexpected git args: ${command}`);
      }
    });

    await expect(collectDiffMetadata("main", pushContext, gitExec)).resolves.toEqual({
      available: true,
      baseRef: "1111111111111111111111111111111111111111",
      commits: [
        {
          sha: "2222222222222222222222222222222222222222",
          subject: "Fix release workflow",
        },
      ],
      filesChanged: ["apps/api/src/routes/ai-integrations.ts"],
      headSha: "2222222222222222222222222222222222222222",
      mergeBase: "1111111111111111111111111111111111111111",
      shortStat: "1 file changed, 1 insertion(+)",
    });
    expect(gitExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["refs/remotes/origin/main^{commit}"]),
    );
  });
});

describe("config", () => {
  it("reads validated config from action inputs", () => {
    expect(
      readConfig(
        createCore({
          "production-branch": "refs/heads/main",
          "duckpost-endpoint": "https://duckpost.app/api/ai-release-jobs",
          "include-diff-metadata": "false",
          "timeout-ms": "15000",
        }),
      ),
    ).toEqual({
      duckpostEndpoint: "https://duckpost.app/api/ai-release-jobs",
      includeDiffMetadata: false,
      productionBranch: "main",
      timeoutMs: 15000,
    });
  });

  it.each(["15000ms", "1.5", "  ", "999", "300001"])(
    "rejects non-strict timeout-ms value %s",
    (timeout) => {
      expect(() => parseTimeoutMs(timeout)).toThrow("timeout-ms");
    },
  );
});

describe("event gating", () => {
  it("processes only supported production branch events", () => {
    expect(shouldProcessContext(context, "main")).toEqual({ process: true });
    expect(
      shouldProcessContext(
        {
          ...context,
          eventName: "pull_request",
          ref: "refs/pull/7/merge",
          payload: {
            pull_request: {
              number: 7,
              base: { ref: "main" },
              head: { ref: "feature", sha: context.sha },
            },
          },
        },
        "main",
      ),
    ).toEqual({ process: true });
    expect(
      shouldProcessContext(
        {
          ...context,
          eventName: "workflow_dispatch",
          ref: "refs/heads/main",
        },
        "main",
      ),
    ).toEqual({ process: true });
  });

  it("skips wrong branch and unsupported events before posting", async () => {
    const core = createCore({
      "production-branch": "main",
      "duckpost-endpoint": "https://duckpost.app/api/ai-release-jobs",
      "include-diff-metadata": "true",
      "timeout-ms": "30000",
    });
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));
    const gitExec = vi.fn();

    await run(
      core,
      { ...context, ref: "refs/heads/dev" },
      {},
      fetchImpl,
      gitExec,
    );

    expect(core.info).toHaveBeenCalledWith(
      "Skipping DuckPost release notes because push ref refs/heads/dev does not match refs/heads/main.",
    );
    expect(core.setSecret).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gitExec).not.toHaveBeenCalled();

    const unsupportedCore = createCore({
      "production-branch": "main",
      "duckpost-endpoint": "https://duckpost.app/api/ai-release-jobs",
      "include-diff-metadata": "true",
      "timeout-ms": "30000",
    });
    await run(
      unsupportedCore,
      { ...context, eventName: "issues", ref: "refs/heads/main" },
      {},
      fetchImpl,
      gitExec,
    );

    expect(unsupportedCore.info).toHaveBeenCalledWith(
      "Skipping DuckPost release notes because issues is not a supported event.",
    );
    expect(unsupportedCore.setFailed).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips pull requests whose base branch does not match production", () => {
    expect(
      shouldProcessContext(
        {
          ...context,
          eventName: "pull_request",
          ref: "refs/pull/9/merge",
          payload: {
            pull_request: {
              number: 9,
              base: { ref: "dev" },
              head: { ref: "feature", sha: context.sha },
            },
          },
        },
        "main",
      ),
    ).toEqual({
      process: false,
      reason: "Skipping DuckPost release notes because pull request base dev does not match main.",
    });
  });
});
