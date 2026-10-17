# Platform templates

One folder per platform, each with its template in that platform's own format. They all describe the same container, so the facts they must agree on live in one file, [`deploy.json`](deploy.json): the image, the port, the data directory, the health check, the name, links and icon, and the catalogue of optional `OPENTODO_*` variables a template may offer, with their defaults and descriptions.

| Platform | Folder | Image | Status |
| --- | --- | --- | --- |
| CapRover | [`caprover/`](caprover/) | `release` | Paste it as a one-click template; the official list wants 1k+ GitHub stars, so a third-party repository first |
| CasaOS / ZimaOS | [`casaos/`](casaos/) | `release` | Ready to submit to the CasaOS app store; install as a custom app meanwhile |
| Coolify | [`coolify/`](coolify/) | `stable` | Pending in Coolify's service list; paste it as Docker Compose meanwhile |
| Cosmos Cloud | [`cosmos/`](cosmos/) | `stable` | Ready to submit to the official servapps market; install as a custom compose meanwhile |
| Dokploy | [`dokploy/`](dokploy/) | `stable` | Ready to submit to Dokploy templates; usable now as a templates base URL |
| Easypanel | [`easypanel/`](easypanel/) | `release` | Ready to submit to Easypanel templates; set up as an app service meanwhile |
| Fly.io | [`fly/`](fly/) | `stable` | No store: `fly launch --copy-config` with the file from this repository |
| Kubernetes (Helm) | [`helm/`](helm/) | `release` | Published to `oci://ghcr.io/pixari/charts/opentodo` by `.github/workflows/helm.yml` from the next release; install from a clone meanwhile |
| Podman Quadlet | [`podman/`](podman/) | `stable` | No store: copy the two unit files; `podman auto-update` follows `stable` |
| Portainer | [`portainer/`](portainer/) | `stable` | Usable now as an App Templates URL; ready to submit to the community list |
| Render | [`render/`](render/) | `stable` | Usable now with the Deploy to Render button (Blueprint path `deploy/render/render.yaml`) |
| Runtipi | [`runtipi/`](runtipi/) | `release` | Our own app store, [`pixari/opentodo-runtipi`](https://github.com/pixari/opentodo-runtipi), published from `upstream/` |
| Synology (Container Manager) | [`synology/`](synology/) | `stable` | Usable now as a Container Manager project; Synology has no container store |
| TrueNAS Community Edition | [`truenas/`](truenas/) | `release` | Ready to submit to the community train; install via YAML meanwhile |
| Umbrel | [`umbrel/`](umbrel/) | `release-digest` | Ready to submit to the Umbrel App Store |
| Unraid | [`unraid/`](unraid/) | `stable` | Listed in Community Applications (**Apps**), from [`pixari/opentodo-unraid`](https://github.com/pixari/opentodo-unraid) |

## Checks

`make check` (and CI) runs `node scripts/deploy-check.mjs`. For every folder here it loads `scripts/deploy/<folder>.mjs`, which parses that platform's format and applies the shared rules in `scripts/deploy/common.mjs`:

- the image follows the platform's policy (the **Image** column): `stable` is `ghcr.io/pixari/opentodo:stable` (`tag` in `deploy.json`), `release` is the latest release in `CHANGELOG.md`, `release-digest` is that release plus its multi-arch index digest; and the release job in `.github/workflows/ci.yml` still publishes `stable`;
- the container port is 8080 and the data is mounted on `/data`;
- every `OPENTODO_*` variable is in the catalogue and read by `internal/config`, with the catalogue's default, and none is required;
- the essential variables (base URL, setup token, sign-up, trusted proxies) are offered.

A folder without a checker fails the run. Tests: `node --test scripts/deploy/*.test.mjs`.

## Adding a platform

1. Add the variable to `deploy.json` first if the platform should offer one that is not catalogued yet (the check refuses it otherwise).
2. Create `deploy/<platform>/` with the template and a `README.md` (how to install before it is listed, how to submit it).
3. Add `scripts/deploy/<platform>.mjs` exporting `check(ctx)` and `summary`. Parse the format strictly (YAML files go through the one shared parser, `scripts/deploy/yaml.mjs`: pick the profile that matches what the platform's file may use, or add one there with tests in `yaml.test.mjs`; never write another YAML parser), check what is specific to the platform, and pass `{ image, port, dataTarget, variables, policy }` to `checkShared()`. `unraid.mjs` is a short example. Add tests in `scripts/deploy/<platform>.test.mjs`.
4. Add `docs/self-hosting/<platform>.md` and list it in `docs/README.md`, and add a row to the table above.

## On a release

Templates on `stable` need no change: the release job moves the tag to the new version (release candidates leave it alone), so those installs get the release through their platform's update button.

Templates on `release` or `release-digest` are for stores that refuse moving tags or offer updates only when a version changes. Preparing a release fails `make check` until they name the new version; after the release job has published the image, `node scripts/deploy/pin.mjs` writes the new digests (`--check` lists stale ones). Then copy each `upstream/` to its store, as its folder's README says. The Helm chart (`helm/opentodo/Chart.yaml`) also names the release: bump `version`, `appVersion` and the `artifacthub.io/images` tag; the release tag publishes it. The **Promote stable** workflow (Actions → Promote stable → Run workflow, with a version such as `0.6.1`) points `stable` at an older release to roll back, without rebuilding.
