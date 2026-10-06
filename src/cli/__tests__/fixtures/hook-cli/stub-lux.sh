#!/usr/bin/env bash
# Stand-in `lux` for post-commit-hook.test.ts: `index sync` prints the files named by
# STUB_SYNC_STDOUT / STUB_SYNC_STDERR and exits 0; every other command just exits 0. Each call's
# arguments are appended, one call per line, to STUB_ARGS_LOG when it is set.
# Checked in rather than written per test: macOS scans each newly created executable on its first
# run. That costs a few hundred milliseconds on an idle machine, but a stub written per test pays it
# on every case, and during a loaded full-suite run it exceeded the per-call timeout.
if [ -n "$STUB_ARGS_LOG" ]; then echo "$*" >> "$STUB_ARGS_LOG"; fi
case " $* " in
  *" --version "*) echo 0.0.0 ;;
  *" index sync "*)
    cat "$STUB_SYNC_STDOUT"
    cat "$STUB_SYNC_STDERR" >&2
    ;;
esac
exit 0
