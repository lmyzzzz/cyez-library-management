const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { prepareRelease, publishRelease } = require("./release.cjs");

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const digest = (data) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;
const missing = () => {
  throw Object.assign(new Error("Not found"), { status: 404 });
};

async function fixture(t, version = "1.2.3") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cyez-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "record-only/apps/teacher"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, "record-only/release"));
  await fs.writeFile(
    path.join(root, "record-only/apps/teacher/package.json"),
    JSON.stringify({ version }),
  );
  const filename = `cyez-library-${version}-x64-setup.exe`;
  const bytes = Buffer.from("MZ test executable fixture\0\xff", "latin1");
  await fs.writeFile(path.join(root, "record-only/release", filename), bytes);
  return {
    root,
    directory: path.join(root, "record-only/release/publication"),
    filename,
    bytes,
  };
}

function githubFixture() {
  const state = {
    release: null,
    ref: null,
    assets: [],
    writes: [],
    fail: null,
  };
  const data = (value) => ({ data: value });
  const write = (method, effect) => async (args) => {
    state.writes.push(method);
    if (state.fail === method) throw new Error("Injected API failure");
    return data(effect(args));
  };
  const github = {
    rest: {
      git: {
        getRef: async () => (state.ref ? data(state.ref) : missing()),
        createRef: write("createRef", (args) => {
          state.ref = { object: { type: "commit", sha: args.sha } };
          return state.ref;
        }),
        getTag: async () => data({ object: { type: "commit", sha } }),
      },
      repos: {
        getReleaseByTag: async () =>
          state.release ? data(state.release) : missing(),
        createRelease: write("createRelease", (args) => {
          state.release = {
            ...args,
            id: 1,
            html_url: "https://github.com/test/repo/releases/tag/v1.2.3",
          };
          return state.release;
        }),
        listReleaseAssets: async () => data(state.assets),
        uploadReleaseAsset: write("uploadReleaseAsset", (args) => {
          const asset = {
            id: state.assets.length + 10,
            name: args.name,
            digest: digest(args.data),
            bytes: args.data,
          };
          state.assets.push(asset);
          return asset;
        }),
        deleteReleaseAsset: write("deleteReleaseAsset", (args) => {
          state.assets = state.assets.filter(
            (item) => item.id !== args.asset_id,
          );
        }),
        updateRelease: write("updateRelease", (args) => {
          Object.assign(state.release, args);
          return state.release;
        }),
      },
    },
    paginate: async (method, args) => (await method(args)).data,
  };
  return {
    github,
    state,
    context: {
      sha,
      ref: "refs/heads/main",
      eventName: "push",
      serverUrl: "https://github.com",
      runId: 42,
      repo: { owner: "test", repo: "repo" },
    },
    core: { info() {}, setOutput() {} },
  };
}

test("publishes the verified binary, checksum and manifest after staging a draft", async (t) => {
  const files = await fixture(t);
  const manifest = await prepareRelease(files.root, sha);
  assert.equal(manifest.commit, sha);
  assert.equal(manifest.size, files.bytes.length);
  const api = githubFixture();
  const result = await publishRelease({ ...files, ...api });
  assert.equal(result.skipped, false);
  assert.equal(api.state.ref.object.sha, sha);
  assert.equal(api.state.release.tag_name, "v1.2.3");
  assert.equal(api.state.release.draft, false);
  assert.deepEqual(api.state.assets[0].bytes, files.bytes);
  assert.deepEqual(
    api.state.assets.map((asset) => asset.name),
    [files.filename, "SHA256SUMS.txt", "release-manifest.json"],
  );
  assert.deepEqual(api.state.writes, [
    "createRef",
    "createRelease",
    "uploadReleaseAsset",
    "uploadReleaseAsset",
    "uploadReleaseAsset",
    "updateRelease",
  ]);
});

test("published versions are never overwritten, even by a later main commit", async (t) => {
  const files = await fixture(t);
  await prepareRelease(files.root, sha);
  const api = githubFixture();
  await publishRelease({ ...files, ...api });
  api.state.writes.length = 0;
  api.context.sha = otherSha;
  await prepareRelease(files.root, otherSha);
  assert.equal((await publishRelease({ ...files, ...api })).skipped, true);
  assert.deepEqual(api.state.writes, []);
  assert.equal(api.state.ref.object.sha, sha);
});

test("an upload failure leaves a draft that a same-commit retry can finish", async (t) => {
  const files = await fixture(t);
  await prepareRelease(files.root, sha);
  const api = githubFixture();
  api.state.fail = "uploadReleaseAsset";
  await assert.rejects(publishRelease({ ...files, ...api }), /Injected/);
  assert.equal(api.state.release.draft, true);
  api.state.fail = null;
  api.state.assets.push({
    id: 99,
    name: files.filename,
    digest: "sha256:partial",
  });
  await publishRelease({ ...files, ...api });
  assert.equal(api.state.assets.length, 3);
  assert.ok(api.state.writes.includes("deleteReleaseAsset"));
  assert.equal(api.state.release.draft, false);
});

test("retry after finalization failure reuses already uploaded assets", async (t) => {
  const files = await fixture(t);
  await prepareRelease(files.root, sha);
  const api = githubFixture();
  api.state.fail = "updateRelease";
  await assert.rejects(publishRelease({ ...files, ...api }), /Injected/);
  api.state.fail = null;
  api.state.writes.length = 0;
  await publishRelease({ ...files, ...api });
  assert.deepEqual(api.state.writes, ["updateRelease"]);
});

test("rejects a mismatched commit, version, binary or checksum before writes", async (t) => {
  for (const kind of ["commit", "version", "binary", "checksum"]) {
    const files = await fixture(t);
    const manifest = await prepareRelease(files.root, sha);
    if (kind === "commit" || kind === "version") {
      manifest[kind] = kind === "commit" ? otherSha : "9.9.9";
      await fs.writeFile(
        path.join(files.directory, "release-manifest.json"),
        JSON.stringify(manifest),
      );
    } else {
      await fs.appendFile(
        path.join(
          files.directory,
          kind === "binary" ? files.filename : "SHA256SUMS.txt",
        ),
        "corrupted",
      );
    }
    const api = githubFixture();
    await assert.rejects(publishRelease({ ...files, ...api }), /match/);
    assert.deepEqual(api.state.writes, []);
  }
});

test("tag or draft from another commit cannot be reused", async (t) => {
  const files = await fixture(t);
  await prepareRelease(files.root, sha);
  for (const kind of ["tag", "draft"]) {
    const api = githubFixture();
    if (kind === "tag")
      api.state.ref = { object: { type: "commit", sha: otherSha } };
    else api.state.release = { draft: true, target_commitish: otherSha };
    await assert.rejects(
      publishRelease({ ...files, ...api }),
      /another commit/,
    );
    assert.deepEqual(api.state.writes, []);
  }
});

test("an annotated tag is accepted only when it resolves to the build commit", async (t) => {
  const files = await fixture(t);
  await prepareRelease(files.root, sha);
  const api = githubFixture();
  api.state.ref = { object: { type: "tag", sha: otherSha } };
  await publishRelease({ ...files, ...api });
  assert.ok(!api.state.writes.includes("createRef"));
});

test("API permission errors stop publication instead of being treated as a missing release", async (t) => {
  const files = await fixture(t);
  await prepareRelease(files.root, sha);
  const api = githubFixture();
  api.github.rest.repos.getReleaseByTag = async () => {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  };
  await assert.rejects(publishRelease({ ...files, ...api }), /Forbidden/);
  assert.deepEqual(api.state.writes, []);
});

test("PR, tag and non-main events cannot publish", async (t) => {
  const files = await fixture(t);
  for (const change of [
    { eventName: "pull_request" },
    { ref: "refs/tags/v1.2.3" },
    { ref: "refs/heads/feature" },
  ]) {
    const api = githubFixture();
    Object.assign(api.context, change);
    await assert.rejects(publishRelease({ ...files, ...api }), /restricted/);
    assert.deepEqual(api.state.writes, []);
  }
});

test("preparation rejects invalid versions, missing binaries and non-executables", async (t) => {
  for (const version of ["01.2.3", "1.2.3-beta.1", "1.2", "1.2.3+meta"]) {
    const files = await fixture(t, version);
    await assert.rejects(prepareRelease(files.root, sha), /stable/);
  }
  const files = await fixture(t);
  await assert.rejects(prepareRelease(files.root, "main"), /commit/);
  await fs.writeFile(
    path.join(files.root, "record-only/release", files.filename),
    "invalid",
  );
  await assert.rejects(prepareRelease(files.root, sha), /executable/);
  await fs.unlink(path.join(files.root, "record-only/release", files.filename));
  await assert.rejects(prepareRelease(files.root, sha), /ENOENT/);
});
