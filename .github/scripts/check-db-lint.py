#!/usr/bin/env python3
"""Fail the build on error-level db lint findings that are not baselined.

WHY THIS EXISTS. `supabase db lint --level error` exits 0 even when it reports
errors, so the workflow around it passed no matter what the linter found. On
2026-08-20 it was reporting four real error-level findings and had been green
throughout -- one of them a function whose per-minute cron job had never once
captured its metric, hidden behind an exception handler and a succeeding job.

A gate that always passes is not a gate. This turns the linter's output into an
exit code.

Baselined findings do NOT fail the build: two known-broken diagnostics functions
were deliberately deferred, and a gate that is permanently red gets ignored,
which would recreate the same blindness in a different costume. Anything not in
the baseline is new, and new is what this catches.
"""
import json
import os
import sys

BASELINE_PATH = os.path.join(os.path.dirname(__file__), "..", "db-lint-baseline.json")


def load_findings(raw: str):
    """Pull the JSON document out of the CLI's output.

    The CLI prints progress lines ("Linting schema: public") before the JSON, so
    the document starts at the first brace rather than at position zero.
    """
    start = raw.find("{")
    if start == -1:
        raise ValueError("no JSON object in lint output")
    doc = json.loads(raw[start:])
    out = []
    for result in doc.get("results", []):
        fn = result.get("function", "<unknown>")
        for issue in result.get("issues", []):
            if str(issue.get("level", "")).lower() != "error":
                continue
            out.append((fn, str(issue.get("message", "")).strip()))
    return out


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print("::error::db lint produced no output — treating as a failure rather "
              "than a pass, because an empty result is indistinguishable from a "
              "linter that never ran.")
        return 1

    try:
        findings = load_findings(raw)
    except Exception as exc:  # noqa: BLE001 - any parse problem must fail loudly
        print(f"::error::could not parse db lint output: {exc}")
        print(raw[:2000])
        return 1

    with open(BASELINE_PATH, encoding="utf-8") as fh:
        baseline = json.load(fh)
    accepted = {(e["function"], e["message"]) for e in baseline.get("accepted", [])}

    unexpected = [f for f in findings if f not in accepted]
    matched = {f for f in findings if f in accepted}

    print(f"db lint: {len(findings)} error-level finding(s); "
          f"{len(matched)} baselined, {len(unexpected)} new")

    # A baseline entry that no longer fires means the function was fixed. Warn so
    # the entry gets removed -- but do not fail, because failing here would
    # punish whoever fixed it.
    for entry in baseline.get("accepted", []):
        key = (entry["function"], entry["message"])
        if key not in matched:
            print(f"::warning::baseline entry no longer reported — remove it from "
                  f"db-lint-baseline.json: {entry['function']} :: {entry['message']}")

    for fn, msg in unexpected:
        print(f"::error::new db lint error in {fn}: {msg}")

    if unexpected:
        print("::error::db lint found error-level issues that are not baselined. "
              "Fix them, or add them to .github/db-lint-baseline.json WITH a reason "
              "if they are a deliberate deferral.")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
