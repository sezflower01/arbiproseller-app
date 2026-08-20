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
    """Pull the results document out of the CLI's output.

    Not a plain json.loads. On a TTY the CLI writes progress ("Linting schema:
    public") to stderr and one JSON document to stdout, but in CI it emits
    SEVERAL JSON documents back to back on stdout -- so parsing from the first
    brace fails with "Extra data", which is exactly how the first green-path run
    in CI died.

    So: decode every document in the stream and take the one carrying "results".
    """
    decoder = json.JSONDecoder()
    docs = []
    idx = 0
    n = len(raw)
    while idx < n:
        while idx < n and raw[idx] not in "{[":
            idx += 1
        if idx >= n:
            break
        try:
            doc, end = decoder.raw_decode(raw, idx)
        except ValueError:
            idx += 1
            continue
        docs.append(doc)
        idx = end

    if not docs:
        raise ValueError("no JSON object in lint output")

    results_docs = [d for d in docs if isinstance(d, dict) and "results" in d]
    if not results_docs:
        # Every document parsed but none carried results. Treating that as "no
        # findings" would be a silent pass on output we do not understand.
        # Include the content in the message, not just the count. Annotations are
        # readable over the public API while log downloads need auth, so an error
        # that says only "no results key" is unreadable to anyone without repo
        # access -- which cost two round trips getting this gate working.
        preview = "; ".join(json.dumps(d)[:300] for d in docs[:3])
        raise ValueError(
            f"no document with a 'results' key in {len(docs)} JSON document(s): {preview}"
        )
    doc = results_docs[-1]
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
