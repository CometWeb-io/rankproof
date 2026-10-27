# Isolated JavaScript renderer

RankProof's optional renderer executes real Chromium JavaScript behind Docker deny-all networking and a bounded parent-side resource broker. A configured, exact Debian 13 Linux ARM64 runtime is qualified for the supported public-web profile. The ordinary raw-HTML scan remains unchanged, and rendering stays unavailable when no qualified runtime is configured.

`renderIsolatedPage(url, runtime)` lives in `src/lib/backlinks/rendered-executor.server.ts`. Runtime configuration belongs to the trusted operator. `RENDERER_RUNTIME` pins the immutable image, Chromium 151.0.7922.34/revision 1234, Playwright 1.62.0 and complete browser/driver asset tree hashes. Unknown images, changed assets, root execution and browser/driver version mismatches fail closed.

## Exact qualified runtime and local setup

The reviewed local build is **Linux ARM64 only**:

```text
sha256:961f5d79e7d6255a718eb446b7d57db5deabc258d4e525e655a3034c2f17930b
```

[Dockerfile.debian13](Dockerfile.debian13) uses an immutable public Python/Debian 13 base. [debian13-runtime-lock.json](debian13-runtime-lock.json) records all 32 signed Debian archive versions and SHA-256 values. The offline build context contains that lock plus the corresponding `debs/` directory. The recipe verifies every archive, installs the complete dependency closure normally, and checks `dpkg --audit`. Build inputs are pinned; this local image ID is not a promise of bit-identical rebuilds on another host. Another image/build requires review and qualification before registration.

Browser and driver assets are supplied separately, matched to the hashes below, and mounted read-only. RankProof never downloads them automatically or puts the binaries in its npm package. The reviewed local setup uses:

```text
/private/tmp/rankproof-renderer-browser-1234/chrome-linux
/private/tmp/rankproof-renderer-browser-1234/driver
```

The browser came from the [official Chromium headless-shell revision 1234 archive](https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-headless-shell-linux-arm64.zip). The driver is the matching Playwright 1.62.0 Linux ARM64 driver/Node payload. Complete-tree hashes use sorted relative file paths, a NUL separator and each file's SHA-256 bytes; symlinks and nonregular asset files are refused.

| Payload                |       Bytes | SHA-256                                                            |
| ---------------------- | ----------: | ------------------------------------------------------------------ |
| Browser archive        | 116,380,215 | `b03443e1e1a60d06e07b6cdfe650b8c2bfcbb3db497d2b652f73dc6912f4ae15` |
| Extracted browser tree | 356,265,387 | `01f17a7b05a02c00243cb0f78e086478a708a52e4f786a61d990fb2540808106` |
| Driver tree            | 135,319,739 | `f8122fdfe04343b788ea96cc5d02cbe1e4edf0a7163ffa4bbd7b79a3c49c8b31` |

For the reviewed local setup, an explicit CLI request is:

```json
{
  "url": "https://example.com/",
  "runtime": {
    "image": "sha256:961f5d79e7d6255a718eb446b7d57db5deabc258d4e525e655a3034c2f17930b",
    "browserDir": "/private/tmp/rankproof-renderer-browser-1234/chrome-linux",
    "driverDir": "/private/tmp/rankproof-renderer-browser-1234/driver",
    "qualification": "qualified-public-web"
  }
}
```

Save this as a local request file, then use `rankproof render request.json --out private-render.json`. The CLI creates a fresh private output file; rendered HTML can contain page data and should be reviewed before sharing.

`renderIsolatedFixture()` also supports the old registered compatibility image. That profile accepts authored `.example` URLs at **every** resource, robots and redirect hop, before DNS or I/O. Supplying a JSON qualification label never enables an unknown image or upgrades that old profile to public-web execution.

## Enforced boundary and limits

Each invocation creates its own container and checks actual Docker settings before starting it:

- `--network none`, private IPC, read-only root filesystem, UID/GID 65534, dropped capabilities and no-new-privileges.
- Exactly three read-only mounts contain the pinned browser directory, driver directory and worker file. The image environment is cleared before Node and Chromium start. No Docker socket, host network/IPC, credentials or sibling directories are mounted.
- Aggregate cgroup RAM/swap ceiling 256 MiB, PID ceiling 128, CPU quota 0.25 CPU, bounded 32 MiB tmpfs, independent inner `timeout --signal=KILL 14s`, and parent watchdog 15 seconds. The quota and inner deadline conservatively bound aggregate CPU below the reported five-second CPU budget.
- Chromium's inner sandbox remains enabled. The seccomp policy is the [Playwright v1.62.0 Docker profile](https://github.com/microsoft/playwright/blob/v1.62.0/utils/docker/seccomp_profile.json) with one additional `chroot` syscall allowance for its inner user namespace. Outer capabilities remain empty. The upstream policy is distributed under [Apache-2.0](PLAYWRIGHT-LICENSE.txt).

Typed parent-controlled JSON IPC admits public HTTP GET/HEAD text resources through pinned DNS, public-address validation, robots checks, and request/response/redirect budgets. Public IPv6 admission excludes local-use NAT64, site-local and documented non-global ranges; checked IPv4 translations retain their address checks.

At most 40 actual HTTP attempts include robots and redirects. A response reserves up to two million bytes of decoded capacity before I/O, within an eight-million-byte aggregate capacity budget. Complete responses refund unused capacity; partial, failed, oversized or undecodable responses retain their reservation. Repeated failures therefore cannot reset the budget. Exact decoded bytes stay `null` if any response size is unknown; TCP wire bytes and transport read-ahead are unmeasured.

Main-document redirects preserve the actual fetched resource URL. Redirected subresources, POST, image/font/media requests, service workers and WebSockets are disabled by this bounded profile. Refused resources appear in coverage. WebRTC has no OS egress route. Main HTTP errors, incomplete/non-HTML responses and recognized browser challenges fail closed, using the same HTML admission helper as the raw verifier. A recognized challenge generated by JavaScript also fails admission.

## Evidence and measurement cohort

Results preserve `rawHtml`, `renderedHtml`, separate hashes and two URL identities:

- `rawUrl` is the actual fetched main resource URL.
- `finalUrl` is the DOM document URL, including a same-origin SPA route or fragment. A History API change does not fabricate an HTTP redirect or request.

The result records its fixed request/browser profile and digest: RankProof/Chromium 151 user-agent, `en-US,en;q=0.9` negotiation, per-resource Accept headers, locale `en-US`, timezone `UTC`, viewport 1280×720, and a 350 ms settle interval. Robots negotiation is recorded separately. Capture start/end timestamps identify the actual snapshot window after `domcontentloaded` and the fixed settle wait.

`coverage.settled` describes the observed broker window. Future timers and asynchronous JavaScript may remain. A captured anchor does not establish search-engine indexability; a bounded snapshot does not prove exhaustive rendered-page absence. Runtime qualification, capture quality, indexing and backlink verification remain separate. The raw-HTML verifier never silently promotes this DOM snapshot to a confirmed backlink.

## Reproduce the authored qualification cases

With the reviewed image and assets already available:

```sh
RANKPROOF_RENDERER_ASSETS=/private/tmp/rankproof-renderer-browser-1234 \
RANKPROOF_RENDERER_IMAGE=sha256:961f5d79e7d6255a718eb446b7d57db5deabc258d4e525e655a3034c2f17930b \
  node --experimental-strip-types --test \
  src/lib/backlinks/rendered-executor.test.ts \
  src/lib/backlinks/rendered-executor.integration.test.ts
```

Without the asset variable, Docker integration cases are explicitly skipped. Unit and transport checks still run. Actual-browser cases cover dynamic anchors, scripts/fetch, navigation and SPA URL identity, SSRF/robots/private DNS, compatibility-scope escape refusal, WebSocket-only blocked coverage, HTTP/JavaScript challenges, output overflow, CPU deadlines, RAM pressure and invocation-specific cleanup. The public-profile case uses authored responses through mocked pinned host HTTP; it is not a benchmark of arbitrary live sites. Qualification covers this exact image/assets/controls on the tested Docker host, with independent review. AMD64, other hosts, full pentesting and broad accuracy/scale claims require their own evidence.
