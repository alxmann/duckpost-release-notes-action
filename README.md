# DuckPost Release Notes Action

Standalone GitHub Action that sends GitHub repository context to the DuckPost backend so DuckPost can generate release notes for pull requests targeting a production branch.

This action is intentionally thin:

- Reads `DUCKPOST_TOKEN` from the environment and masks it with GitHub Actions secret masking.
- Validates the `production-branch` input before making a request.
- Collects GitHub Actions context from `@actions/github`.
- Optionally collects local git diff metadata when the checkout has full history.
- Sends one authenticated `POST` request to the DuckPost backend with an idempotency key.
- Does not call OpenAI or any model provider.

## Usage

```yaml
name: DuckPost release notes

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  release-notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: duckpost/duckpost-release-notes-action@v1
        env:
          DUCKPOST_TOKEN: ${{ secrets.DUCKPOST_TOKEN }}
        with:
          production-branch: main
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `production-branch` | yes | | Production branch that pull requests target, for example `main`. |
| `duckpost-endpoint` | no | `https://duckpost.app/api/ai-release-jobs` | DuckPost backend endpoint. |
| `include-diff-metadata` | no | `true` | Whether to include local git diff metadata. |
| `timeout-ms` | no | `30000` | Backend request timeout. |

## Environment

`DUCKPOST_TOKEN` is required. The action calls `core.setSecret(token)` before logging runtime status and never writes the token into logs.

## Payload

The action posts JSON with this shape:

```json
{
  "repository_owner": "duckpost",
  "repository_name": "app",
  "release_branch": "main",
  "event_name": "pull_request",
  "pull_request_number": 42,
  "commit_sha": "abc123",
  "before_sha": "base000",
  "compare_url": "https://github.com/duckpost/app/compare/base000...abc123",
  "idempotency_key": "github:duckpost/app:12345:1:abc123:main",
  "changed_files": [
    { "filename": "src/index.ts", "status": "modified" }
  ],
  "commits": [
    { "sha": "def456", "message": "Ship release notes" }
  ],
  "diff_summary": "1 file changed, 2 insertions(+)"
}
```

When available, local git metadata is flattened into `changed_files`, `commits`, `before_sha`, `compare_url`, and `diff_summary`.

## Development

```sh
npm install
npm test
npm run build
npm run bundle
```

`npm run bundle` writes `dist/index.js`, which is the file referenced by `action.yml`.

## Security Notes

- Branch inputs reject unsafe ref expressions, whitespace, path traversal-like branch values, and glob metacharacters.
- The action sends the DuckPost token only in the `Authorization` header.
- The idempotency key is sent in both the JSON body and the `Idempotency-Key` header.
- Network and HTTP errors fail the action.
- There are no OpenAI dependencies and no OpenAI API calls.
