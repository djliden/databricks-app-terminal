#!/usr/bin/env bash
# shellcheck shell=bash

__dbx_terminal_type_name="codex"
__dbx_terminal_type_cmd="${DBX_APP_TERMINAL_CODEX_CMD:-codex}"

if [[ "${DBX_APP_TERMINAL_TYPE_NO_AUTO_EXEC:-0}" != "1" ]] && command -v "$__dbx_terminal_type_cmd" >/dev/null 2>&1; then
  exec "$__dbx_terminal_type_cmd"
fi

printf '\n[session-type:%s] CLI "%s" was not auto-started.\n' "$__dbx_terminal_type_name" "$__dbx_terminal_type_cmd"
printf '[session-type:%s] Staying in shell. Run `%s` when ready.\n\n' "$__dbx_terminal_type_name" "$__dbx_terminal_type_cmd"

unset __dbx_terminal_type_name __dbx_terminal_type_cmd
