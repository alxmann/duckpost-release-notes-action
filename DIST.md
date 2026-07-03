# Bundled Distribution Strategy

`action.yml` points at `dist/index.js` because GitHub Actions run JavaScript actions from committed JavaScript, not TypeScript source.

Use `npm run bundle` before publishing a release tag. The bundle command runs:

```sh
ncc build src/index.ts --target es2022 --minify --source-map --out dist
```

Commit the generated `dist/` directory with release commits/tags. Keep `src/`, tests, and `dist/` in sync by running `npm run ci` before tagging.

CI runs `npm run ci` and then fails if `dist/` has any uncommitted changes.

The package intentionally depends only on `@actions/core` and `@actions/github` at runtime. It does not include OpenAI SDKs or any model-provider client.
