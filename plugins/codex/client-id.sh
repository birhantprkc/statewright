#!/usr/bin/env bash

# Resolve one opaque identity shared by the host's MCP proxy and hooks.
# Never use cwd: concurrent sessions commonly operate in the same checkout.
statewright_hash_client_material() {
  local material="$1"
  local digest=""
  if command -v shasum >/dev/null 2>&1; then
    digest=$(printf '%s' "$material" | LC_ALL=C shasum -a 256 2>/dev/null | awk '{print substr($1, 1, 32)}' || true)
  fi
  if [ -z "$digest" ] && command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$material" | LC_ALL=C sha256sum 2>/dev/null | awk '{print substr($1, 1, 32)}' || true)
  fi
  if [ -z "$digest" ]; then
    digest=$(printf '%s' "$material" | LC_ALL=C cksum | awk '{print $1}')
  fi
  printf '%s' "$digest"
}

statewright_managed_client_id() {
  local control_dir="${STATEWRIGHT_ROUTE_CONTROL_DIR:-}"
  local identity_file client_id
  [ -n "$control_dir" ] || return 1
  identity_file="$control_dir/identity.json"
  [ -r "$identity_file" ] || return 1
  client_id=$(jq -r 'if (.client_id | type) == "string" and (.client_id | test("^swc_[0-9a-f]{32}$")) then .client_id else empty end' "$identity_file" 2>/dev/null || true)
  [ -n "$client_id" ] || return 1
  printf '%s' "$client_id"
}

statewright_codex_resume_material() {
  local command_line="$1"
  printf '%s\n' "$command_line" | awk '
    { for (field_index = 1; field_index < NF; field_index += 1) if ($field_index == "resume") { print "codex-thread:" $(field_index + 1); exit } }
  '
}

statewright_codex_top_level_command() {
  case "$1" in
    agents|app|app-server|apply|archive|cloud|completion|debug|delete|doctor|e|exec|exec-server|features|fork|help|login|logout|mcp|mcp-server|migrate-rollouts|plugin|queue|remote-control|resume|review|sandbox|unarchive|update)
      return 0
      ;;
  esac
  return 1
}

# Classify the actual Codex process command, not arbitrary ancestor text. A
# direct package-manager install commonly appears as either `codex ...` or
# `node /path/to/codex ...`; shell-script shims appear as `bash /path/codex`.
statewright_codex_one_shot_command() {
  local command_line="$1"
  local -a fields=()
  local index=0 codex_index=-1 argument basename candidate
  read -r -a fields <<< "$command_line"

  while [ "$index" -lt "${#fields[@]}" ] && [ "$index" -lt 2 ]; do
    basename="${fields[$index]##*/}"
    case "$basename" in
      codex|codex.js)
        codex_index="$index"
        break
        ;;
    esac
    index=$((index + 1))
  done
  [ "$codex_index" -ge 0 ] || return 1

  index=$((codex_index + 1))
  while [ "$index" -lt "${#fields[@]}" ]; do
    argument="${fields[$index]}"
    case "$argument" in
      --)
        return 1
        ;;
      -i|--image)
        index=$((index + 1))
        while [ "$index" -lt "${#fields[@]}" ]; do
          candidate="${fields[$index]}"
          if [ "$candidate" = "--" ] || [[ "$candidate" == -* ]] || statewright_codex_top_level_command "$candidate"; then
            break
          fi
          index=$((index + 1))
        done
        continue
        ;;
      -a|--ask-for-approval|-C|--cd|-c|--config|--disable|--enable|--local-provider|-m|--model|-p|--profile|--remote|--remote-auth-token-env|-s|--sandbox|--add-dir)
        index=$((index + 2))
        continue
        ;;
      --*=*|-*)
        index=$((index + 1))
        continue
        ;;
      exec|e|review)
        return 0
        ;;
      *)
        return 1
        ;;
    esac
  done
  return 1
}

statewright_codex_one_shot_ancestor() {
  local pid="${1:-${PPID:-0}}"
  local depth=0 command_line parent_pid
  while [ "$pid" -gt 1 ] 2>/dev/null && [ "$depth" -lt 12 ]; do
    command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if statewright_codex_one_shot_command "$command_line"; then
      return 0
    fi
    parent_pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
    [ -n "$parent_pid" ] || break
    pid="$parent_pid"
    depth=$((depth + 1))
  done
  return 1
}

statewright_register_codex_root_session() {
  local session_id="$1"
  local client_id="$2"
  local control_dir="${STATEWRIGHT_ROUTE_CONTROL_DIR:-}"
  local registration lock_dir temporary
  [ -n "$control_dir" ] && [ -n "$session_id" ] && [ -n "$client_id" ] || return 0
  statewright_codex_one_shot_ancestor && return 0
  registration="$control_dir/codex-root-session.json"
  [ -e "$registration" ] && return 0
  lock_dir="$control_dir/.codex-root-session.lock"
  mkdir "$lock_dir" 2>/dev/null || return 0
  if [ ! -e "$registration" ]; then
    temporary="$lock_dir/registration.json"
    jq -n --arg session_id "$session_id" --arg client_id "$client_id" \
      '{version: 1, session_id: $session_id, client_id: $client_id}' > "$temporary" && \
      chmod 600 "$temporary" && mv "$temporary" "$registration"
  fi
  rmdir "$lock_dir" 2>/dev/null || true
}

statewright_host_process_material() {
  local host="$1"
  local pid="${PPID:-0}"
  local depth=0
  local command_name command_line parent_pid started material

  while [ "$pid" -gt 1 ] 2>/dev/null && [ "$depth" -lt 12 ]; do
    command_name=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if [ "$host" = "codex" ]; then
      material=$(statewright_codex_resume_material "$command_line")
      if [ -n "$material" ]; then
        printf '%s' "$material"
        return 0
      fi
    fi
    case "$command_name" in
      *codex*|*claude*|*opencode*|*omx*)
        started=$(ps -p "$pid" -o lstart= 2>/dev/null || true)
        printf 'process:%s:%s:%s' "$command_name" "$pid" "$started"
        return 0
        ;;
    esac
    parent_pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
    [ -n "$parent_pid" ] || break
    pid="$parent_pid"
    depth=$((depth + 1))
  done

  return 1
}

statewright_client_id() {
  local host="$1"
  local hook_session="${2:-}"
  local managed_id material="${STATEWRIGHT_CLIENT_ID:-${STATEWRIGHT_MCP_SESSION_ID:-}}"
  local host_session=""

  managed_id=$(statewright_managed_client_id || true)
  if [ -n "$managed_id" ]; then
    printf '%s' "$managed_id"
    return 0
  fi

  if [ -z "$material" ]; then
    case "$host" in
      claude)
        host_session="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
        ;;
      *)
        host_session="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}"
        ;;
    esac
    [ -n "$host_session" ] && material="${host}-thread:${host_session}"
  fi

  # Hooks provide the durable thread ID directly. The stdio proxy derives the
  # same value from `codex resume <thread>` below.
  if [ -z "$material" ] && [ -n "$hook_session" ]; then
    material="${host}-thread:${hook_session}"
  fi
  if [ -z "$material" ]; then
    material=$(statewright_host_process_material "$host" || true)
  fi
  if [ -z "$material" ]; then
    material="${hook_session:-process:${PPID:-0}}"
  fi

  printf 'swc_%s' "$(statewright_hash_client_material "$material")"
}
