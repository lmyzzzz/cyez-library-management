const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const manifestName = "release-manifest.json";
const checksumName = "SHA256SUMS.txt";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function identity(root, sha) {
  const { version } = JSON.parse(
    await fs.readFile(
      path.join(root, "record-only/apps/teacher/package.json"),
      "utf8",
    ),
  );
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Installer releases require a stable X.Y.Z version");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid build commit");
  return {
    version,
    commit: sha,
    filename: `cyez-library-${version}-x64-setup.exe`,
  };
}

async function readInstaller(filename) {
  if (!(await fs.lstat(filename)).isFile())
    throw new Error("Installer must be a regular file");
  const bytes = await fs.readFile(filename);
  if (bytes.length < 2 || bytes.subarray(0, 2).toString() !== "MZ")
    throw new Error("Missing Windows executable header");
  return bytes;
}

// This runs only after the real packaged Electron tests pass on Windows.
async function prepareRelease(root, sha) {
  const release = await identity(root, sha);
  const bytes = await readInstaller(
    path.join(root, "record-only/release", release.filename),
  );
  const manifest = { ...release, size: bytes.length, sha256: hash(bytes) };
  const directory = path.join(root, "record-only/release/publication");
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(
    path.join(root, "record-only/release", release.filename),
    path.join(directory, release.filename),
  );
  await fs.writeFile(
    path.join(directory, manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(directory, checksumName),
    `${manifest.sha256}  ${release.filename}\n`,
  );
  return manifest;
}

async function optional(request) {
  try {
    return (await request()).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error; // Never interpret authentication or service failures as absence.
  }
}

async function ensureTag(github, repo, tag, sha) {
  const ref = `tags/${tag}`;
  const existing = await optional(() =>
    github.rest.git.getRef({ ...repo, ref }),
  );
  if (!existing) {
    await github.rest.git.createRef({ ...repo, ref: `refs/${ref}`, sha });
    return;
  }
  let object = existing.object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
    object = (await github.rest.git.getTag({ ...repo, tag_sha: object.sha }))
      .data.object;
  }
  if (object.type !== "commit" || object.sha !== sha)
    throw new Error(
      `${tag} already points to another commit; use a new version`,
    );
}

async function publishRelease({
  github,
  context,
  core,
  root = process.cwd(),
  directory = path.join(root, "release-artifact"),
}) {
  if (
    context.ref !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(context.eventName)
  )
    throw new Error("Installer publication is restricted to main");
  const expected = await identity(root, context.sha);
  const manifestBytes = await fs.readFile(path.join(directory, manifestName));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value)
      throw new Error(`Installer artifact ${key} does not match this CI run`);
  }
  const installer = await readInstaller(
    path.join(directory, expected.filename),
  );
  if (manifest.size !== installer.length || manifest.sha256 !== hash(installer))
    throw new Error("Installer artifact checksum mismatch");
  const checksum = await fs.readFile(path.join(directory, checksumName));
  if (checksum.toString() !== `${manifest.sha256}  ${expected.filename}\n`)
    throw new Error("Checksum file does not match installer");

  const repo = context.repo;
  const tag = `v${expected.version}`;
  let release = await optional(() =>
    github.rest.repos.getReleaseByTag({ ...repo, tag }),
  );
  if (release && !release.draft) {
    core.info(`${tag} is already published; keeping its existing assets.`);
    core.setOutput("release-url", release.html_url);
    return { skipped: true, url: release.html_url };
  }
  if (release && release.target_commitish !== context.sha)
    throw new Error(
      `${tag} draft belongs to another commit; use a new version`,
    );

  // The tag binds a draft to the verified SHA, including on interrupted retries.
  await ensureTag(github, repo, tag, context.sha);
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const body = [
    `Windows x64 安装包：\`${expected.filename}\`。`,
    "",
    `来源提交：${context.sha}`,
    `验证流水线：[record-only](${runUrl})（服务端、Docker 全链路、Windows 客户端全部通过）。`,
    "",
    `SHA-256：\`${manifest.sha256}\`；也可下载 SHA256SUMS.txt 核对。`,
    "安装包当前未签名，安装升级与生产接入说明见 record-only/docs/operations.md。",
  ].join("\n");
  if (!release) {
    release = (
      await github.rest.repos.createRelease({
        ...repo,
        tag_name: tag,
        target_commitish: context.sha,
        name: `图书馆使用登记 ${tag}`,
        body,
        draft: true,
        prerelease: false,
      })
    ).data;
  }
  const assets = [
    { name: expected.filename, data: installer },
    { name: checksumName, data: checksum },
    { name: manifestName, data: manifestBytes },
  ];
  const existingAssets = await github.paginate(
    github.rest.repos.listReleaseAssets,
    { ...repo, release_id: release.id, per_page: 100 },
  );
  for (const asset of assets) {
    const existing = existingAssets.find((item) => item.name === asset.name);
    if (existing?.digest === `sha256:${hash(asset.data)}`) continue;
    // Only unpublished drafts may have interrupted/partial assets replaced.
    if (existing)
      await github.rest.repos.deleteReleaseAsset({
        ...repo,
        asset_id: existing.id,
      });
    await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: release.id,
      name: asset.name,
      data: asset.data,
      headers: { "content-type": "application/octet-stream" },
    });
  }
  release = (
    await github.rest.repos.updateRelease({
      ...repo,
      release_id: release.id,
      body,
      draft: false,
      prerelease: false,
      make_latest: "legacy",
    })
  ).data;
  core.info(`Published ${release.html_url}`);
  core.setOutput("release-url", release.html_url);
  return { skipped: false, url: release.html_url };
}

module.exports = { prepareRelease, publishRelease };
if (require.main === module) {
  prepareRelease(
    path.resolve(__dirname, "../.."),
    process.env.GITHUB_SHA,
  ).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
