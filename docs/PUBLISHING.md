# Publishing checklist

Everything that has to happen to release a version of the MCP server. Most of it is automated by pushing a tag; the npm and registry steps are manual because they need your logins.

The first release is the one most likely to hit a snag (names, permissions, 2FA), so do it before the public announcement and check each step.

## 1. Before you start

```bash
cd mcp-server
npm ci
npm run lint && npm run typecheck && npm test        # all green
docker build --target mcp -t issuewatcher-mcp:test .
IW_DOCKER_IMAGE=issuewatcher-mcp:test node --test build/__tests__/mcp-docker.test.js
npm run package:mcp                                   # stages ./dist-mcp
```

## 2. Set the version

Change it in **two** places (a test fails if they differ):

- `mcp-server/package.json` -> `"version"`
- `mcp-server/packaging/server.json` -> `"version"` and `packages[0].version`

Commit and push, and wait for CI to pass.

## 3. Publish to npm (manual)

The package is `issuewatcher-mcp` (checked free on 2026-10-29). Publish the **staged** folder, not the repo root: the repo root has the email digest's dependencies.

```bash
npm login                                   # needs your npm account and 2FA
cd mcp-server
npm run build && npm run package:mcp
cd dist-mcp
npm pack --dry-run                          # read the file list: about 22 files, 3 dependencies
npm publish --access public
```

Check it from a clean folder:

```bash
cd $(mktemp -d)
npx -y issuewatcher-mcp --version           # prints the version you just published
```

## 4. Tag the release (triggers the automation)

```bash
git tag -a vX.Y.Z -m "IssueWatcher vX.Y.Z"
git push origin vX.Y.Z
```

The `Release` workflow then:
- builds and pushes the **digest** image to `ghcr.io/mac146/issuewatcher`
- builds and pushes the **MCP server** image to `ghcr.io/mac146/issuewatcher-mcp`
- builds the **Claude Desktop bundle** (`issuewatcher-X.Y.Z.mcpb`) and attaches it to the GitHub release

Afterwards open <https://github.com/users/mac146/packages> and make both container packages **public** (new packages are private by default). Check anonymously:

```bash
docker pull ghcr.io/mac146/issuewatcher-mcp:X.Y.Z
```

## 5. Official MCP Registry (manual)

The registry only stores metadata; it checks that the npm package really belongs to you via `mcpName` (already set by the staging script to `io.github.mac146/issuewatcher`). It is in preview, so details can change: if a step fails, read <https://github.com/modelcontextprotocol/registry>.

```bash
brew install mcp-publisher                  # or download the binary from the registry releases
cd mcp-server/packaging
mcp-publisher login github                  # opens a GitHub device login
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.mac146/issuewatcher"
```

Common failures: "Registry validation failed for package" (the npm package must already be published and contain `mcpName`); "permission" errors (the name must start with `io.github.<your GitHub username>/`); description over 100 characters.

## 6. Directories (manual, one by one)

Listing makes the server findable; it does not by itself bring users, so do it after the demo exists. For each, use the repo URL, the README, the icon (`mcp-server/packaging/mcpb/icon.png`) and the one-line description.

- Glama, PulseMCP, mcp.so
- The `awesome-mcp-servers` list (a pull request)
- Claude's extension directory: submit the `.mcpb` (needs the icon and the privacy policy, `docs/PRIVACY.md`). Check the current submission form first; remote servers are preferred there.

## 7. After the release

- [ ] Run `npx -y issuewatcher-mcp --check` on a machine that has never seen the project.
- [ ] Install the `.mcpb` in Claude Desktop from the GitHub release page and ask a question.
- [ ] Watch the first week: npm downloads, GitHub stars and issues, and feedback. The success and stop criteria are in [DECISIONS.md](../DECISIONS.md) (D-036).
