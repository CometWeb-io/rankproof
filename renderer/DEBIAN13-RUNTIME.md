# Debian 13 arm64 dependency runtime

`Dockerfile.debian13` extends the public Python base pinned in
`debian13-runtime-lock.json`. Browser and Playwright assets remain separate,
versioned, read-only mounts. This recipe installs the full 32-package dependency
closure, including Mesa/LLVM, with normal `dpkg` configuration. It does not skip
maintainer scripts, force dependencies, install recommended packages or contact a
repository during the build.

To reproduce the package inputs:

1. Have the exact `python@sha256:27e044f7e01fea05c1760324d58fc5360a0767b9ef098e74ddaf8c70b8f46d26`
   image locally available. Check it with `docker image inspect`; do not substitute
   a mutable tag or another architecture.
2. Create a private build directory containing a copy of the lock file and a
   `debs/` directory. Use a disposable instance of that base with signed official
   Debian `trixie`, `trixie-updates` and `trixie-security` indexes. Run
   `apt-get update` without unauthenticated options, followed by `apt-get download`
   for every exact `Package=Version` listed in the lock. Store archives under their
   `downloadFile` names in `debs/`. No browser, credentials or Docker socket needs
   to enter that package-download container.
3. Build with the following command, replacing the context directory:

```sh
docker build --pull=false --network=none \
  -f renderer/Dockerfile.debian13 \
  -t rankproof-renderer-debian13:local /absolute/private/build-context
```

The build verifies every archive's SHA-256 and size before installing it, checks
all installed versions and requires an empty `dpkg --audit`. It embeds the lock
at `/usr/local/share/rankproof/debian13-runtime-lock.json`. The archives are
read-only build mounts and do not become a separate retained image layer.
If an old exact package disappears from the live mirrors, retrieve that exact
archive through a reviewed Debian snapshot; never silently upgrade or bypass the
hash check. The lock records the signed-index and Debian keyring hashes used when
these package inputs were selected.

The measured archive total was 43,116,852 bytes, with 204,502,016 bytes of declared
installed package size. BuildKit reported an approximately 209 MB added layer.
The output image digest belongs to that specific build; this recipe pins package
inputs and does not promise identical image bytes across builders or timestamps.

Successful `ldd`, Chromium `--version` and Playwright module loading establish only
runtime dependencies. They do not qualify browser sandboxing, network policy,
request/CPU/RAM limits, robots compliance, adversarial pages or measurement quality.
The executor's separate real-browser qualification remains required. This recipe
covers `linux/arm64`; it makes no `amd64` or remote-deployment claim.
