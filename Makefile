VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

CLI_PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

# The extension's two store packages (OpenSpec change extension-v2, design D7):
# extension/build.mjs writes them from extension/manifest.src.json.
EXT_ZIPS := dist/opentodo-browser-extension-chrome.zip dist/opentodo-browser-extension-firefox.zip
# Pinned development tool, fetched by npx; never a dependency of the repository.
WEB_EXT := web-ext@10.7.0
SKILL_ZIP := dist/opentodo-agent-skill.zip
MCP_SKILL_ZIP := dist/opentodo-mcp-skill.zip

.PHONY: brand-icons site-bundle all web server cli cli-release cli-smoke skill extension android build run dev test test-go test-web test-extension check lint staticcheck clean docker openspec-validate layout-check ux-audit docs docs-check templates templates-check docs-screenshots screens docs-site-check coolify-check coolify-smoke deploy-check storybook ui-check ui-baselines ui-lint web-lint i18n-check repo-check fmt-check ci-checks e2e

all: build

## Build the web app into internal/web/dist (embedded by the Go binary).
web:
	cd web && npm ci --no-audit --no-fund && npm run build

## Build the server binary (expects `make web` to have run).
server:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/opentodo ./cmd/opentodo

## Build the `ot` command-line client for this machine (not part of the container image).
cli:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/ot ./cmd/ot

## Cross-compile `ot` for every release platform into dist/.
cli-release:
	@mkdir -p dist
	@for p in $(CLI_PLATFORMS); do \
	  os=$${p%/*}; arch=$${p#*/}; ext=""; [ "$$os" = windows ] && ext=.exe; \
	  echo "  ot $$os/$$arch"; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags="$(LDFLAGS)" -o dist/ot-$$os-$$arch$$ext ./cmd/ot || exit 1; \
	done

## End-to-end check of the CLI against a freshly started local server.
cli-smoke: server cli
	./scripts/cli-smoke.sh

## Zip the agent skills into dist/ for the release: the CLI skill
## (skills/opentodo-cli/SKILL.md, also embedded in `ot skill`) and the MCP skill
## (skills/opentodo-mcp/SKILL.md, also in the Claude Code plugin).
skill:
	@mkdir -p dist && rm -f $(SKILL_ZIP) $(MCP_SKILL_ZIP)
	cd skills && zip -q -X ../$(SKILL_ZIP) opentodo-cli/SKILL.md
	cd skills && zip -q -X ../$(MCP_SKILL_ZIP) opentodo-mcp/SKILL.md
	@echo "  $(SKILL_ZIP) ($$(wc -c < $(SKILL_ZIP)) bytes)"
	@echo "  $(MCP_SKILL_ZIP) ($$(wc -c < $(MCP_SKILL_ZIP)) bytes)"

## Test the browser extension, build its Chrome and Firefox packages into dist/
## (refusing host permissions, content scripts or a version missing from
## extension/CHANGELOG.md) and lint the Firefox one with web-ext, which fails on
## errors only. web-ext reads every manifest as Firefox's, so the Chrome package is
## checked by extension/build.test.js instead. Not part of the container image.
extension: test-extension
	node extension/build.mjs
	npx --yes $(WEB_EXT) lint --source-dir dist/extension-firefox --output text

## The Android app (native-shells): unit tests, lint, the AndroidX-only dependency
## check, translations, store metadata and a debug APK. Needs JDK 17+ and the
## Android SDK (ANDROID_HOME); not part of `make check`. See mobile/README.md.
android:
	@command -v java >/dev/null 2>&1 || { echo "make android needs a JDK 17+ and the Android SDK (see mobile/README.md)"; exit 1; }
	cd mobile/android && ./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:checkDependencies :app:checkTranslations :app:checkStoreMetadata :app:assembleDebug :app:assembleDebugAndroidTest
	@echo "  mobile/android/app/build/outputs/apk/debug/app-debug.apk ($$(wc -c < mobile/android/app/build/outputs/apk/debug/app-debug.apk) bytes)"

build: web server

## Layout check (mobile-layout): every screen and overlay at 360/390/768 px in
## Chromium and WebKit against a throwaway server on :18080. Needs Playwright
## (npm i -g playwright@1.56.1 && playwright install chromium webkit);
## ENGINES=chromium limits it to one engine.
layout-check: build
	@d=$$(mktemp -d); OPENTODO_DATA_DIR=$$d OPENTODO_ADDR=127.0.0.1:18080 ./bin/opentodo >$$d/server.log 2>&1 & pid=$$!; \
	  for i in $$(seq 1 30); do curl -fsS 127.0.0.1:18080/healthz >/dev/null 2>&1 && break; sleep 0.3; done; \
	  OPENTODO_URL=http://127.0.0.1:18080 node scripts/e2e-layout.mjs layout-report; s=$$?; kill $$pid; rm -rf $$d; exit $$s

## Interface audit (ux-audit-three-widths): every screen of scripts/ux-audit/screens.json
## at 360/768/1280 px, light and dark, English and German, against a throwaway server
## on a free port; writes ux-audit-report/index.html and report.json. Needs Playwright
## with Chromium. ONLY, WIDTHS, THEMES, LANGS, CONCURRENCY, OUT_DIR narrow it, TEXT_SIZE=20
## (or 24) sets the browser's text size;
## UX_AUDIT_STRICT=1 fails on budget, overflow and story-coverage findings.
ux-audit: build
	node scripts/ux-audit/tour.mjs
	@echo "report: $${OUT_DIR:-ux-audit-report}/index.html"

## Design workbench (design-language): Storybook on http://localhost:6006.
storybook:
	cd web && npm run storybook

## UI gates over the static workbench: axe-core (WCAG 2.2 AA) on every story in light
## and dark, then visual regression against web/src/ui/__screenshots__. Needs Playwright
## and @playwright/test $(PLAYWRIGHT_VERSION) installed globally (as CI does); override
## PLAYWRIGHT_NODE_PATH to use another install.
PLAYWRIGHT_VERSION := 1.56.1
# The image CI's UI check runs in, pinned by digest (OpenSpec ci-release-gates).
PLAYWRIGHT_IMAGE := mcr.microsoft.com/playwright:v$(PLAYWRIGHT_VERSION)-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a
PLAYWRIGHT_NODE_PATH ?= $(shell npm root -g)
ui-check:
	cd web && npm run build-storybook
	node scripts/ui-check/a11y.mjs
	node scripts/ui-check/motion.mjs
	cd scripts/ui-check && NODE_PATH=$(PLAYWRIGHT_NODE_PATH) node $(PLAYWRIGHT_NODE_PATH)/@playwright/test/cli.js test -c playwright.config.ts

## Regenerate the visual baselines inside the pinned Playwright image, because font
## rendering differs per OS. web/node_modules stays the host's (anonymous volume).
## Without Docker, run the "UI baselines" workflow and commit its artifact instead.
ui-baselines:
	docker run --rm -v "$(CURDIR)":/work -v /work/web/node_modules -w /work \
	  $(PLAYWRIGHT_IMAGE) bash -euc '\
	    npm i -g --no-audit --no-fund @playwright/test@$(PLAYWRIGHT_VERSION) >/dev/null; \
	    cd web && npm ci --no-audit --no-fund >/dev/null && npm run build-storybook; \
	    cd ../scripts/ui-check && NODE_PATH=$$(npm root -g) playwright test -c playwright.config.ts --update-snapshots=all; \
	    chown -R $(shell id -u):$(shell id -g) /work/web/src/ui/__screenshots__'

## Run the production binary locally on :8080 with ./data.
run: build
	./bin/opentodo

## Development: Go API on :8080 plus Vite dev server on :5173 with hot reload.
dev:
	@echo "Starting API on :8080 and Vite on :5173 (Ctrl+C stops both)"
	@trap 'kill 0' INT; \
	  go run ./cmd/opentodo & \
	  (cd web && npm run dev) & \
	  wait

test: test-go test-web test-extension

test-go:
	go test ./...

test-web:
	cd web && npm test

test-extension:
	cd extension && npm test
	node --test scripts/brand-icons.test.mjs

lint:
	go vet ./...
	cd web && npm run typecheck

## Static analysis of the Go code (test-integrity), pinned so CI and laptops agree.
## Needs the web build in internal/web/dist (make web), like go test. The tool is built
## with the go.mod toolchain (not the minimum Go it asks for), because it must read the
## standard library of the Go that compiles the code.
STATICCHECK_VERSION := v0.8.2
staticcheck:
	GOTOOLCHAIN=$$(go env GOVERSION) go run honnef.co/go/tools/cmd/staticcheck@$(STATICCHECK_VERSION) ./...

## The OpenSpec CLI at an exact version (CI runs it through this target; Dependabot does not
## see npx, so bump it by hand).
OPENSPEC_VERSION := 1.13.2
openspec-validate:
	npx --yes @fission-ai/openspec@$(OPENSPEC_VERSION) validate --all --strict

## Everything CI runs.
## Documentation (user-documentation): build the docs site into dist/docs-site, regenerate the in-app help
## bundle web/src/generated/help.json and the keyboard guide's tables from docs/.
docs: templates
	cd web && npm run docs:build

## The template library (template-library): templates/ compiled into
## web/src/generated/templates.json for the app and the site bundle.
templates:
	node scripts/templates-build.mjs

## Every template valid (templates/README.md), its tests, and the compiled file current.
templates-check:
	node --test scripts/templates-check.test.mjs
	node scripts/templates-check.mjs
	node scripts/templates-build.mjs --check

## Front matter, links, anchors, images, spec coverage, help ids, generated files.
docs-check:
	cd web && npm run docs:check

## Screenshots of the user guide (docs/images/*.webp, light and dark) from the seeded
## demo data. Needs Playwright with Chromium (CHROMIUM_PATH to use another binary).
HASH := \#
DOCS_VERSION := $(shell sed -n 's/^$(HASH)$(HASH) \[\([0-9][0-9.]*\)\].*/\1/p' CHANGELOG.md | head -1)
docs-screenshots: web
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$(DOCS_VERSION)" -o bin/opentodo-docs ./cmd/opentodo
	OPENTODO_BIN=bin/opentodo-docs node scripts/docs-screenshots.mjs
	$(MAKE) docs

## Before/after screenshots of the core screens (ux-overhaul O4): the seeded demo fixture at
## 1280×800 and 390×844, light and dark, as PNGs in dist/screens/ (OUT_DIR to write elsewhere).
screens: web
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$(DOCS_VERSION)" -o bin/opentodo-docs ./cmd/opentodo
	OPENTODO_BIN=bin/opentodo-docs node scripts/screens.mjs

## Site bundle (site-bundle): docs site, screenshots, tokens, icons, changelog and
## manifest for the website repository, in dist/opentodo-site-bundle-<version>/ and
## its .tar.gz. VERSION defaults to `git describe`.
site-bundle: build
	node scripts/site-bundle.mjs --bin bin/opentodo $(if $(SITE_VERSION),--version $(SITE_VERSION),)

## Docs website in a browser: sideways scrolling, axe-core, search, no-JS (needs
## Playwright with Chromium and `npm ci` in web/ for axe-core).
docs-site-check:
	node scripts/e2e-docs.mjs docs-report

## Coolify one-click template (deploy/coolify/): conventions, release tag, variables, upstream copies;
## `docker compose config` when Docker is available.
coolify-check:
	node --test scripts/coolify-template-check.test.mjs scripts/site-bundle.test.mjs
	node scripts/coolify-template-check.mjs

## Also starts the template's image with Docker and probes it (pulls ghcr.io/pixari/opentodo).
coolify-smoke:
	node scripts/coolify-template-check.mjs --smoke

## Every platform template in deploy/ against deploy/deploy.json and its platform's rules
## (Coolify, Unraid); see deploy/README.md.
deploy-check:
	node --test scripts/coolify-template-check.test.mjs scripts/deploy/*.test.mjs scripts/site-bundle.test.mjs
	node scripts/deploy-check.mjs

## CI path filter cases, the shared Go toolchain (go.mod, Dockerfile, CI) and compose defaults;
## the brand rasters rendered from the current brand.svg (sidebar-v2 D3).
repo-check:
	node --test scripts/repo-checks.test.mjs scripts/brand-icons.test.mjs

## Every brand raster (app icons, favicon, extension icons) from web/src/ui/icons/brand.svg.
brand-icons:
	node scripts/brand-icons.mjs

check: lint web-lint staticcheck test fmt-check ui-lint i18n-check docs-check templates-check openspec-validate deploy-check repo-check

## The parts of `make check` that CI runs in its Checks job (the others run in the web,
## server and extension jobs; scripts/repo-checks.test.mjs keeps the two lists whole).
ci-checks: fmt-check ui-lint i18n-check templates-check openspec-validate deploy-check repo-check

## gofmt gate: no Go file may need formatting.
fmt-check:
	@out=$$(gofmt -l cmd internal skills); if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

## Browser end-to-end checks (two devices, offline edits converging, saved views, the
## decrypting MCP bridge) against a throwaway server on :18081 each. Expects `make build`
## (it builds bin/ot itself); needs Playwright with Chromium.
e2e: cli
	@for s in e2e-smoke e2e-views e2e-mcp-decrypt; do \
	  d=$$(mktemp -d); OPENTODO_DATA_DIR=$$d OPENTODO_ADDR=127.0.0.1:18081 ./bin/opentodo >$$d/server.log 2>&1 & pid=$$!; \
	  for i in $$(seq 1 30); do curl -fsS 127.0.0.1:18081/healthz >/dev/null 2>&1 && break; sleep 0.3; done; \
	  echo "== $$s"; OPENTODO_URL=http://127.0.0.1:18081 node scripts/$$s.mjs; st=$$?; kill $$pid; wait $$pid 2>/dev/null; \
	  if [ $$st -ne 0 ]; then cat $$d/server.log; rm -rf $$d; exit $$st; fi; rm -rf $$d; \
	done
	@echo "== e2e-network"; OPENTODO_BIN=./bin/opentodo node scripts/e2e-network.mjs

## Design-system check (ui-primitives): stories for every shared component, no
## emoji or glyph icons in web/src/app.
ui-lint:
	node --test scripts/ui-check.test.mjs scripts/ux-audit/ux-audit.test.mjs
	node scripts/ui-check.mjs
	node scripts/ux-audit/stories.mjs

## React hooks lint (web-lint-and-test-hygiene): Rules of Hooks and effect
## dependencies as errors; every remaining suppression carries its reason.
web-lint:
	cd web && npm run lint

## Translation catalogs (app-localization): every shipped catalog complete, no stale
## or malformed entries, placeholders as in the source; script tests included.
i18n-check:
	node --test scripts/i18n/extract.test.mjs scripts/i18n/untranslated.test.mjs scripts/i18n-check.test.mjs
	node scripts/i18n-check.mjs

docker:
	docker build --build-arg VERSION=$(VERSION) -t opentodo:$(VERSION) .

clean:
	rm -rf bin web/dist internal/web/dist/* && touch internal/web/dist/.gitkeep
