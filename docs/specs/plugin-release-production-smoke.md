# Plugin release production smoke

Statewright treats plugin release confidence as three different claims. Keeping
them separate prevents a source-level success from being reported as proof that
the downloadable package or a native host session works.

## Required release evidence

Every commit used for a Codex or Claude Code release must have both of these
successful workflow runs at the exact commit:

1. `Plugin Production Canary` runs the Codex, Claude Code, Cursor, Pi,
   OpenCode, and OMX source transports on `ubuntu-24.04` and `macos-14`.
2. `Windows Plugin Canary` runs the Codex and Claude managed-client bootstrap,
   route lifecycle, and authenticated production gateway check on
   `windows-2022`.

The release gate inspects the named jobs and the Windows production step. A
workflow whose overall conclusion is green cannot satisfy the gate if a matrix
job is absent or the production step was skipped. Only `push` runs qualify as
release evidence. Manual replays are diagnostic and can never satisfy the
publication gate, because a dispatch workflow ref and its separately selected
checkout ref have different identities in GitHub Actions.

After those commit-bound checks pass, `Plugin Release` builds the Codex or
Claude ZIP once, signs a GitHub/Sigstore build-provenance attestation, uploads it
as an internal workflow artifact, and exercises that same ZIP against production
on macOS and Linux. Publication is a separate job that depends on both
artifact-smoke jobs. The job summary records the source commit and ZIP SHA-256.

All production calls are read-only. Codex, Claude Code, Cursor, and the Windows
managed bridge perform MCP `initialize`, `tools/list`, and
`statewright_get_status`. Pi and OMX initialize their direct clients and call
`statewright_get_status`; OpenCode initializes its adapter and relays the status
call. The dedicated API key exists only in the step that makes those calls.
Pull requests never receive it, and the Windows check does not pass it to a
Codex or Claude child process.

## Replay a version or commit

Run workflows from the current `main` control plane. The requested ref must
resolve to a commit in trusted `main` history before the production credential
is exposed.

To exercise any supported source transport at a tag or commit on macOS and
Linux:

```sh
gh workflow run plugin-version-canary.yml --ref main \
  -f release_ref=codex-v0.3.1 \
  -f plugin=codex \
  -f evidence_mode=source
```

For an attested Codex or Claude ZIP, select `release-artifact` and use its
matching tag namespace:

```sh
gh workflow run plugin-version-canary.yml --ref main \
  -f release_ref=claude-vX.Y.Z \
  -f plugin=claude \
  -f evidence_mode=release-artifact
```

To repeat the Windows managed-client and production check at that source:

```sh
gh workflow run windows-plugin-canary.yml --ref main \
  -f release_ref=claude-v0.3.1
```

The same dispatches are available as Task targets:

```sh
task canary:plugin-version REF=codex-vX.Y.Z PLUGIN=codex MODE=release-artifact
task canary:plugin-version:windows REF=codex-v0.3.1
```

## Boundaries

- Source mode covers Codex, Claude Code, Cursor, Pi, OpenCode, and OMX.
- Release-artifact mode covers Codex and Claude Code because those are the only
  plugin ZIPs currently published by this repository. It verifies the archive's
  GitHub attestation, signer workflow, tag source ref, source commit, and hosted
  runner before extraction. Older unattested releases fail closed.
- Windows currently proves the managed Codex and Claude transport from source;
  it does not install a release ZIP.
- These checks do not authenticate to the vendor's interactive Codex, Claude,
  Cursor, Pi, OpenCode, or OMX session.
- OMP is intentionally absent until Statewright has an OMP adapter and a
  canary that exercises it. It must not be inferred from Pi support.
