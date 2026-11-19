#!/bin/bash
set -e

# RemitLend Build Script
# This script builds and optimizes the Soroban smart contracts.

# Navigate to the contracts directory
cd "$(dirname "$0")/../contracts"

echo "Building contracts..."
cargo build --target wasm32-unknown-unknown --release

echo "Contracts built successfully."

# Check if stellar/soroban CLI is available for optimization
if command -v stellar &> /dev/null; then
    echo "Optimizing contracts with stellar CLI..."
    for wasm in target/wasm32-unknown-unknown/release/*.wasm; do
        [[ "$wasm" == *.optimized.wasm ]] && continue
        out="${wasm%.wasm}.optimized.wasm"
        echo "Optimizing ${wasm} -> ${out}"
        stellar contract optimize --wasm "$wasm" --wasm-out "$out"
    done
elif command -v soroban &> /dev/null; then
    echo "Optimizing contracts with soroban CLI..."
    for wasm in target/wasm32-unknown-unknown/release/*.wasm; do
        [[ "$wasm" == *.optimized.wasm ]] && continue
        out="${wasm%.wasm}.optimized.wasm"
        echo "Optimizing ${wasm} -> ${out}"
        soroban contract optimize --wasm "$wasm" --wasm-out "$out"
    done
else
    echo "WARNING: stellar/soroban CLI not found. Skipping optimization."
    echo "Compiled WASM files are in target/wasm32-unknown-unknown/release/"
fi

# ---------------------------------------------------------------------------
# Release bundle (issue #870)
#
# Produces a single immutable bundle directory that traces every artifact back
# to one build: git revision, lockfile digests, test results, generated API
# schema digests, WASM hashes, and a deployment manifest.
#
# Usage:
#   scripts/build.sh bundle [--out <dir>] [--skip-tests] [--skip-schema]
#   scripts/build.sh verify-bundle <bundle-dir>
#
# The bundle is written to dist/release-bundles/<short-sha>-<utc-timestamp>
# by default. A `manifest.json` records SHA-256 digests of every artifact plus
# the source revision; `verify-bundle` recomputes them and fails on divergence.
# See docs/DEPLOYMENT.md for the bundle format and validation evidence.
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

sha256_of() {
    # Prints the SHA-256 hex digest of a file, or "MISSING" if absent.
    local f="$1"
    if [[ -f "$f" ]]; then
        if command -v sha256sum &> /dev/null; then
            sha256sum "$f" | awk '{print $1}'
        elif command -v shasum &> /dev/null; then
            shasum -a 256 "$f" | awk '{print $1}'
        else
            echo "ERROR: no sha256sum/shasum available" >&2
            return 1
        fi
    else
        echo "MISSING"
    fi
}

json_escape() {
    # Minimal JSON string escaping for values we embed.
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

git_revision() {
    if git -C "$REPO_ROOT" rev-parse HEAD &> /dev/null; then
        git -C "$REPO_ROOT" rev-parse HEAD
    else
        echo "UNKNOWN"
    fi
}

git_dirty() {
    if git -C "$REPO_ROOT" rev-parse HEAD &> /dev/null; then
        if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
            echo "true"
        else
            echo "false"
        fi
    else
        echo "unknown"
    fi
}

# Collect WASM hashes by reusing scripts/verify-wasm-hashes.sh when present.
collect_wasm_hashes() {
    local out_file="$1"
    local verify_script="$REPO_ROOT/scripts/verify-wasm-hashes.sh"
    : > "$out_file"
    if [[ -x "$verify_script" || -f "$verify_script" ]]; then
        # verify-wasm-hashes.sh prints "<sha256>  <path>" lines; capture them.
        if bash "$verify_script" --print-hashes > "$out_file" 2>/dev/null; then
            return 0
        fi
        # Fall back to plain invocation output if --print-hashes unsupported.
        if bash "$verify_script" > "$out_file" 2>/dev/null; then
            return 0
        fi
    fi
    # Fallback: hash any built WASM artifacts directly.
    local wasm_dir="$REPO_ROOT/contracts/target/wasm32-unknown-unknown/release"
    if [[ -d "$wasm_dir" ]]; then
        local wasm
        for wasm in "$wasm_dir"/*.wasm; do
            [[ -e "$wasm" ]] || continue
            echo "$(sha256_of "$wasm")  ${wasm#"$REPO_ROOT"/}" >> "$out_file"
        done
    fi
    return 0
}

# Generate API schema digests (OpenAPI / generated schema artifacts).
collect_schema_digests() {
    local out_file="$1"
    : > "$out_file"
    local candidates=(
        "$REPO_ROOT/backend/openapi.json"
        "$REPO_ROOT/backend/openapi.yaml"
        "$REPO_ROOT/backend/schema/openapi.json"
        "$REPO_ROOT/contracts/target/schema"
        "$REPO_ROOT/frontend/src/api/schema.json"
    )
    local c
    for c in "${candidates[@]}"; do
        if [[ -f "$c" ]]; then
            echo "$(sha256_of "$c")  ${c#"$REPO_ROOT"/}" >> "$out_file"
        elif [[ -d "$c" ]]; then
            local f
            while IFS= read -r f; do
                echo "$(sha256_of "$f")  ${f#"$REPO_ROOT"/}" >> "$out_file"
            done < <(find "$c" -type f | sort)
        fi
    done
    return 0
}

run_tests() {
    # Runs test suites and records pass/fail + log location. Returns 0 on
    # success, non-zero on failure so the bundle step can fail closed.
    local bundle_dir="$1"
    local status=0
    local log="$bundle_dir/test-results.log"
    : > "$log"

    echo "Running contract tests..." | tee -a "$log"
    if ( cd "$REPO_ROOT/contracts" && cargo test --release ) >> "$log" 2>&1; then
        echo "contracts: PASS" >> "$log"
    else
        echo "contracts: FAIL" >> "$log"
        status=1
    fi

    if [[ -f "$REPO_ROOT/backend/package.json" ]]; then
        echo "Running backend tests..." | tee -a "$log"
        if ( cd "$REPO_ROOT/backend" && npm test --silent ) >> "$log" 2>&1; then
            echo "backend: PASS" >> "$log"
        else
            echo "backend: FAIL" >> "$log"
            status=1
        fi
    fi

    if [[ -f "$REPO_ROOT/frontend/package.json" ]]; then
        echo "Running frontend tests..." | tee -a "$log"
        if ( cd "$REPO_ROOT/frontend" && npm test --silent ) >> "$log" 2>&1; then
            echo "frontend: PASS" >> "$log"
        else
            echo "frontend: FAIL" >> "$log"
            status=1
        fi
    fi

    return $status
}

cmd_bundle() {
    local out_root="$REPO_ROOT/dist/release-bundles"
    local skip_tests=0
    local skip_schema=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --out) out_root="$2"; shift 2 ;;
            --skip-tests) skip_tests=1; shift ;;
            --skip-schema) skip_schema=1; shift ;;
            *) echo "ERROR: unknown bundle option: $1" >&2; return 2 ;;
        esac
    done

    local rev short_rev ts bundle_dir
    rev="$(git_revision)"
    short_rev="${rev:0:12}"
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    bundle_dir="$out_root/${short_rev}-${ts}"

    if [[ -e "$bundle_dir" ]]; then
        echo "ERROR: bundle directory already exists (immutable): $bundle_dir" >&2
        return 1
    fi
    mkdir -p "$bundle_dir"

    echo "Creating release bundle at $bundle_dir"

    # 1. Source revision
    {
        echo "revision=$rev"
        echo "short_revision=$short_rev"
        echo "dirty=$(git_dirty)"
        echo "created_utc=$ts"
    } > "$bundle_dir/source-revision.txt"

    # 2. Lockfile digests (root, backend, frontend)
    local lockfiles_file="$bundle_dir/lockfile-digests.txt"
    : > "$lockfiles_file"
    local lf
    for lf in "$REPO_ROOT/Cargo.lock" "$REPO_ROOT/backend/package-lock.json" "$REPO_ROOT/frontend/package-lock.json"; do
        if [[ -f "$lf" ]]; then
            echo "$(sha256_of "$lf")  ${lf#"$REPO_ROOT"/}" >> "$lockfiles_file"
        fi
    done

    # 3. Test results
    local tests_status="skipped"
    if [[ "$skip_tests" -eq 0 ]]; then
        if run_tests "$bundle_dir"; then
            tests_status="pass"
        else
            tests_status="fail"
        fi
    fi

    # 4. Generated API schema digests
    local schema_file="$bundle_dir/schema-digests.txt"
    if [[ "$skip_schema" -eq 0 ]]; then
        collect_schema_digests "$schema_file"
    else
        : > "$schema_file"
    fi

    # 5. WASM hashes (reuse verify-wasm-hashes.sh)
    local wasm_file="$bundle_dir/wasm-hashes.txt"
    collect_wasm_hashes "$wasm_file"

    # 6. Deployment manifest
    local manifest="$bundle_dir/manifest.json"
    {
        printf '{\n'
        printf '  "bundle_format_version": 1,\n'
        printf '  "issue": 870,\n'
        printf '  "source_revision": "%s",\n' "$(json_escape "$rev")"
        printf '  "short_revision": "%s",\n' "$(json_escape "$short_rev")"
        printf '  "dirty": %s,\n' "$(git_dirty)"
        printf '  "created_utc": "%s",\n' "$(json_escape "$ts")"
        printf '  "tests_status": "%s",\n' "$(json_escape "$tests_status")"
        printf '  "artifacts": {\n'
        printf '    "source-revision.txt": "%s",\n' "$(sha256_of "$bundle_dir/source-revision.txt")"
        printf '    "lockfile-digests.txt": "%s",\n' "$(sha256_of "$lockfiles_file")"
        printf '    "schema-digests.txt": "%s",\n' "$(sha256_of "$schema_file")"
        printf '    "wasm-hashes.txt": "%s",\n' "$(sha256_of "$wasm_file")"
        if [[ -f "$bundle_dir/test-results.log" ]]; then
            printf '    "test-results.log": "%s",\n' "$(sha256_of "$bundle_dir/test-results.log")"
        fi
        printf '    "deployment-manifest.json": "%s"\n' "SELF"
        printf '  }\n'
        printf '}\n'
    } > "$manifest"

    # Deployment manifest (human/ops readable, references the manifest digest)
    {
        printf '{\n'
        printf '  "bundle_dir": "%s",\n' "$(json_escape "${bundle_dir#"$REPO_ROOT"/}")"
        printf '  "source_revision": "%s",\n' "$(json_escape "$rev")"
        printf '  "tests_status": "%s",\n' "$(json_escape "$tests_status")"
        printf '  "manifest_sha256": "%s"\n' "$(sha256_of "$manifest")"
        printf '}\n'
    } > "$bundle_dir/deployment-manifest.json"

    # Record the deployment manifest digest back into the manifest.
    local dep_digest
    dep_digest="$(sha256_of "$bundle_dir/deployment-manifest.json")"
    sed -i.bak "s/\"deployment-manifest.json\": \"SELF\"/\"deployment-manifest.json\": \"$dep_digest\"/" "$manifest" 2>/dev/null || \
        perl -0pi -e "s/\"deployment-manifest.json\": \"SELF\"/\"deployment-manifest.json\": \"$dep_digest\"/" "$manifest"
    rm -f "$manifest.bak"

    echo "Bundle written: $bundle_dir"
    echo "Manifest: $manifest"

    if [[ "$tests_status" == "fail" ]]; then
        echo "ERROR: test suite failed; bundle recorded but marked failing." >&2
        return 1
    fi
    return 0
}

cmd_verify_bundle() {
    local bundle_dir="$1"
    if [[ -z "$bundle_dir" || ! -d "$bundle_dir" ]]; then
        echo "ERROR: verify-bundle requires an existing bundle directory" >&2
        return 2
    fi
    local manifest="$bundle_dir/manifest.json"
    if [[ ! -f "$manifest" ]]; then
        echo "ERROR: manifest.json missing in $bundle_dir" >&2
        return 1
    fi

    local failed=0
    # Extract artifact name/digest pairs from the manifest.
    local name expected actual
    while IFS=$'\t' read -r name expected; do
        [[ -z "$name" ]] && continue
        actual="$(sha256_of "$bundle_dir/$name")"
        if [[ "$actual" != "$expected" ]]; then
            echo "DIVERGED: $name expected=$expected actual=$actual" >&2
            failed=1
        else
            echo "OK: $name"
        fi
    done < <(grep -E '"[^"]+": "[0-9a-f]{64}"' "$manifest" | \
             sed -E 's/^[[:space:]]*"([^"]+)": "([0-9a-f]{64})".*/\1\t\2/')

    if [[ "$failed" -ne 0 ]]; then
        echo "ERROR: bundle verification failed; artifacts diverge from manifest." >&2
        return 1
    fi
    echo "Bundle verified: $bundle_dir"
    return 0
}

# Dispatch subcommands; default behavior (no args) is the legacy build above.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        bundle)
            shift
            cmd_bundle "$@"
            exit $?
            ;;
        verify-bundle)
            shift
            cmd_verify_bundle "$@"
            exit $?
            ;;
    esac
fi