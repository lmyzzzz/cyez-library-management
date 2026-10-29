# cyez-ui vendored artifacts

Source: https://github.com/lmyzzzz/cyez-ui

Pinned source commit: `0a1d4f4fa9affecb2eaf83e978c1e9b1557c7043`.

Built on Windows with Node 22.22.2 and upstream pnpm 10.33.0:

```text
pnpm install --frozen-lockfile
pnpm run build:packages
npm pack ./packages/ui --pack-destination ../../vendor
npm pack ./packages/electron --pack-destination ../../vendor
```

| Artifact | SHA-256 |
| --- | --- |
| series-ui-0.1.0.tgz | 1adffd21564d27e3b8ce0f0b081c87e452d1c7925df4bcf63a195c292885dac1 |
| series-electron-0.1.0.tgz | c0509155e2f029e8eee797099128162bd50ba42457f4e5ba253d13f3db274e8f |

Both archives include their upstream LICENSE and NOTICE.md. Usage authorization is confirmed in the formal project decisions. Archives are consumed with Yarn `file:` dependencies and checksummed by `yarn.lock`. Upstream tests are not counted as this product's validation.
