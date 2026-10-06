#!/usr/bin/env bash
# Lux - Git post-commit hook
# Automatically syncs index after corpus commits

# Configuration
LUX_CLI="${LUX_CLI:-lux}"
LUX_SKIP_SYNC="${LUX_SKIP_SYNC:-${LUX_SKIP_REBUILD:-}}"
LUX_LOG_FILE="${LUX_LOG_FILE:-}"
LUX_SYNC_TIMEOUT="${LUX_SYNC_TIMEOUT:-${LUX_REBUILD_TIMEOUT:-300}}"  # 5 minutes default

# Logging function
log() {
    local level="$1"
    shift
    local msg="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    if [ -n "$LUX_LOG_FILE" ]; then
        echo "[$timestamp] [$level] $msg" >> "$LUX_LOG_FILE"
    fi

    # Always output to stderr for visibility
    if [ "$level" = "ERROR" ]; then
        echo "Error: $msg" >&2
    elif [ "$level" = "WARN" ]; then
        echo "Warning: $msg" >&2
    fi
}

emit_hook_event() {
    local outcome="$1"
    local reason="$2"
    local exit_code="${3:-0}"
    local message="${4:-}"

    if command -v "$LUX_CLI" > /dev/null 2>&1; then
        "$LUX_CLI" --corpus "$repo_root" usage hook-event \
            --outcome "$outcome" \
            --reason "$reason" \
            --changed-count "${changed_count:-0}" \
            --exit-code "$exit_code" \
            --timeout-seconds "$LUX_SYNC_TIMEOUT" \
            --message "$message" \
            > /dev/null 2>&1 || true
    fi
}

# Error exit handler - always exits with 0 to avoid blocking commits
handle_error() {
    local msg="$1"
    local exit_code="${2:-1}"
    log "ERROR" "$msg (exit code: $exit_code)"
    emit_hook_event "error" "sync_failed" "$exit_code" "$msg"
    echo "✗ Lux hook error: $msg" >&2
    echo "  The commit succeeded, but index sync failed." >&2
    echo "  Run 'lux index sync' manually to catch the index up." >&2
    exit 0  # Never fail the commit
}

# Check if sync should be skipped
if [ -n "$LUX_SKIP_SYNC" ]; then
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    changed_count=0
    log "INFO" "Sync skipped (LUX_SKIP_SYNC or legacy LUX_SKIP_REBUILD is set)"
    emit_hook_event "skipped" "env_skip" 0 "LUX_SKIP_SYNC or LUX_SKIP_REBUILD is set"
    exit 0
fi

# Check if commit message indicates skip
commit_msg=$(git log -1 --pretty=%B)
if echo "$commit_msg" | grep -qE '\[skip.?lux\]|\[lux.?skip\]|\[no.?index\]'; then
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    changed_count=0
    log "INFO" "Sync skipped (commit message contains skip directive)"
    emit_hook_event "skipped" "message_skip" 0 "commit message contains skip directive"
    exit 0
fi

# Detect changed files in the last commit
# Use git show for compatibility with initial commits (git diff-tree fails on commits with no parent)
changed_files=$(git show --name-only --pretty="" HEAD 2>&1)
if [ $? -ne 0 ]; then
    handle_error "Failed to detect changed files in commit" $?
fi

# Validate that we got actual file paths (not empty or error message)
if [ -z "$changed_files" ]; then
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    changed_count=0
    log "WARN" "No files detected in commit, skipping sync"
    emit_hook_event "skipped" "no_files" 0 "no files detected in commit"
    exit 0
fi

# Check if any indexable content changed.
# Exclude only clearly non-content paths; docs/, notes/, module markdown, etc. should sync.
indexable_changed=$(echo "$changed_files" | grep -vE '^(\.git/|\.lux/|node_modules/|vendor/|dist/|build/)' | grep -E '\.(md|mdx|txt|rst|php|ts|tsx|js|jsx|py|go|rs|java)$' || true)

if [ -z "$indexable_changed" ]; then
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    changed_count=0
    log "INFO" "No indexable content changes detected, skipping sync"
    emit_hook_event "skipped" "no_indexable_changes" 0 "no indexable content changes detected"
    exit 0
fi

changed_count=$(echo "$indexable_changed" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$changed_count" -eq 0 ]; then
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    log "WARN" "Indexable change detection produced zero files, skipping sync"
    emit_hook_event "skipped" "zero_indexable_changes" 0 "indexable change detection produced zero files"
    exit 0
fi

log "INFO" "Detected $changed_count indexable file(s) changed"

# Check if lux CLI is available
if ! command -v "$LUX_CLI" &> /dev/null; then
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    log "ERROR" "lux CLI not found. Cannot sync index."
    log "INFO" "Install lux or set LUX_CLI environment variable."
    emit_hook_event "error" "cli_missing" 127 "lux CLI not found"
    echo "Warning: lux CLI not found. Run 'npm install -g .' to install." >&2
    exit 0  # Don't fail the commit
fi

# Verify lux CLI is executable
if ! "$LUX_CLI" --version &> /dev/null; then
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    log "ERROR" "lux CLI found but not executable or misconfigured"
    emit_hook_event "error" "cli_unusable" 126 "lux CLI not executable or misconfigured"
    echo "Warning: lux CLI not working. Check your installation." >&2
    exit 0  # Don't fail the commit
fi

# Resolve the repository root explicitly. Git normally executes hooks from the
# worktree root, but passing --corpus makes Lux's root/DB contract visible and
# avoids accidental parent/nested-repo ambiguity.
repo_root=$(git rev-parse --show-toplevel 2>&1)
if [ $? -ne 0 ] || [ -z "$repo_root" ]; then
    handle_error "Failed to resolve git repository root" $?
fi

# Attempt to sync index with timeout
log "INFO" "Starting index sync for $repo_root (timeout: ${LUX_SYNC_TIMEOUT}s)..."

# Create temporary file for sync output
sync_output=$(mktemp)
trap "rm -f $sync_output" EXIT

run_with_timeout() {
    if command -v timeout >/dev/null 2>&1; then
        timeout "$LUX_SYNC_TIMEOUT" "$@"
        return $?
    fi

    if command -v gtimeout >/dev/null 2>&1; then
        gtimeout "$LUX_SYNC_TIMEOUT" "$@"
        return $?
    fi

    if command -v python3 >/dev/null 2>&1; then
        python3 - "$LUX_SYNC_TIMEOUT" "$@" <<'PY'
import subprocess
import sys

timeout_seconds = int(sys.argv[1])
command = sys.argv[2:]
completed = subprocess.run(command, timeout=timeout_seconds)
sys.exit(completed.returncode)
PY
        return $?
    fi

    "$@"
}

# Run sync with timeout
if run_with_timeout "$LUX_CLI" --corpus "$repo_root" index sync --quiet > "$sync_output" 2>&1; then
    sync_exit=0
else
    sync_exit=$?
fi

# Handle different failure scenarios
if [ $sync_exit -eq 0 ]; then
    # A sync that succeeded with warnings prints `Warning:` lines and a ⚠ closing line even under
    # --quiet; relay them rather than reporting a clean sync.
    warning_count=$(grep -c '^Warning: ' "$sync_output" || true)
    if [ "$warning_count" -gt 0 ] || grep -q '^⚠ ' "$sync_output"; then
        log "INFO" "Index synced with $warning_count warning(s)"
        emit_hook_event "success" "sync_warnings" 0 "index sync completed with $warning_count warning(s)"
        grep -E '^(Warning: |⚠ )' "$sync_output" >&2
        echo "⚠ Lux index synced with $warning_count warning(s) ($changed_count file(s) updated)" >&2
        exit 0
    fi
    log "INFO" "Index synced successfully"
    emit_hook_event "success" "sync_success" 0 "index sync completed"
    echo "✓ Lux index synced ($changed_count file(s) updated)" >&2
    exit 0
elif [ $sync_exit -eq 124 ] || [ $sync_exit -eq 143 ]; then
    # Timeout (124 from timeout command, 143 from SIGTERM)
    handle_error "Index sync timed out after ${LUX_SYNC_TIMEOUT}s" $sync_exit
elif [ $sync_exit -eq 1 ]; then
    # Generic error - try to extract meaningful message
    if [ -s "$sync_output" ]; then
        error_msg=$(head -5 "$sync_output" | tr '\n' ' ')
        log "ERROR" "Index sync failed: $error_msg"
        cat "$sync_output" >&2
    else
        log "ERROR" "Index sync failed with no output"
    fi
    handle_error "Index sync failed" $sync_exit
else
    # Other error codes
    log "ERROR" "Index sync failed with unexpected exit code $sync_exit"
    [ -s "$sync_output" ] && cat "$sync_output" >&2
    handle_error "Index sync failed unexpectedly" $sync_exit
fi
