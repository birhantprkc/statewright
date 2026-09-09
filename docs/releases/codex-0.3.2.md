# Statewright Codex Plugin 0.3.2

Statewright Codex Plugin 0.3.2 is a recovery and isolation release for managed
Codex sessions. It does not change the Claude Code plugin version.

## What changed

- A managed resume can recognize two specific Codex history failures: an
  interrupted paginated rollout write and a state-database pointer left at a
  deleted Statewright App Server directory. Statewright explains the repair,
  asks before changing anything, creates a private backup, and modifies only
  the validated session records.
- Codex homes supplied by the caller remain intact. Statewright discards a
  `CODEX_HOME` only when it can prove that the path belongs to one of its own
  ephemeral managed children.
- Resident App Servers and resumed client identities are scoped to the
  canonical project working directory. Nested reviewers and stale child
  processes cannot claim the parent session's route.
- The managed launcher has a project-scoped App Server shutdown command and
  offers an explicit selection when multiple matching residents exist.
- Provider-aware model ladders carry the selected provider and reasoning level
  through managed restart boundaries.
- Native Codex token telemetry remains attached to the authoritative session
  across a routed child restart.

## Safety boundary

History repair remains fail-closed. Statewright does not rewrite an unknown,
mixed-schema, identity-mismatched, or non-canonical rollout. On Windows, where
the native writer lock cannot be proven with the same mechanism, automatic
history repair remains unavailable and guard mode stays active.

## Validation contract

The release is cut only from the current `main` commit after the complete local
plugin suite and the exact-commit GitHub CI, Windows managed-client canary, and
authenticated macOS/Linux production transport canary pass. The tag workflow
then packages the Codex plugin, attests its provenance, and runs the packaged
archive against production on macOS and Linux before publishing the release.

## Recovery command

If a project-scoped resident App Server must be stopped before retrying a
resume, run:

```bash
ascodex --kill-app-server
```

Statewright asks before terminating a single match and offers an explicit
choice when several residents match the current project.
