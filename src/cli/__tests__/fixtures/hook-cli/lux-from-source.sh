#!/usr/bin/env bash
# Runs this checkout's CLI, as compiled for the test run (LUX_TEST_CLI_ENTRY), for
# post-commit-hook.test.ts to pass as LUX_CLI. Checked in for the same reason as stub-lux.sh.
# LUX_TEST_NODE is the test process's node, so the hook runs the CLI on the same Node the suite uses
# rather than whichever `node` is first on PATH.
root="$(cd "$(dirname "$0")/../../../../.." && pwd)"
cd "$root" && exec "${LUX_TEST_NODE:?LUX_TEST_NODE must name the node binary}" "${LUX_TEST_CLI_ENTRY:?LUX_TEST_CLI_ENTRY must name the compiled CLI}" "$@"
