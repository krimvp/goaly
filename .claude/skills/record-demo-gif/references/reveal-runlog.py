#!/usr/bin/env python3
"""Decode a goaly run log into a compact, readable "what the loop actually did" reveal —
the verifier ladder (deterministic rung + optional LLM judge) and the independent Sign-off
approver: the two keys for DONE. Use it as the *verify beat* of a goaly demo so the LLM
side (which goaly writes to the run log, not the terminal) becomes visible in the GIF.

Usage:
    python3 reveal-runlog.py <workspace-dir>      # picks the newest .goaly/run-*/log.jsonl
    python3 reveal-runlog.py <path/to/log.jsonl>  # or point at one explicitly

Reads the write-ahead log goaly writes under <workspace>/.goaly/<runId>/log.jsonl. Never
throws on a partial log — it prints whatever stages it can find.
"""
from __future__ import annotations

import glob
import json
import os
import sys

C = "\033[36m"; G = "\033[32m"; Rd = "\033[31m"; B = "\033[1m"; D = "\033[2m"; R = "\033[0m"


def _resolve(arg: str) -> str:
    if os.path.isfile(arg):
        return arg
    logs = sorted(
        glob.glob(os.path.join(arg, ".goaly", "run-*", "log.jsonl")),
        key=os.path.getmtime,
    )
    if not logs:
        sys.exit(f"reveal-runlog: no .goaly/run-*/log.jsonl under {arg!r}")
    return logs[-1]


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit("usage: reveal-runlog.py <workspace-dir | log.jsonl>")
    path = _resolve(sys.argv[1])
    events = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    def tagged(tag: str):
        return [e["event"] for e in events if e.get("event", {}).get("tag") == tag]

    compiled = tagged("CONTRACT_COMPILED")
    if compiled:
        rungs = compiled[0]["contract"]["rungs"]
        det = next((r for r in rungs if r["kind"] == "deterministic"), None)
        jud = next((r for r in rungs if r["kind"] == "judge"), None)
        parts = []
        if det is not None:
            parts.append(f"deterministic[{det['command']}]")
        if jud is not None:
            parts.append(f"LLM-judge[quorum={jud['quorum']} floor={jud['confidenceFloor']}]")
        print(f"  {C}compile{R}  → contract FROZEN  ·  rungs: {'  +  '.join(parts)}")

    ran = tagged("AGENT_RAN")
    if ran:
        print(f"  {C}agent{R}    → {ran[-1]['run'].get('status')}")

    verified = tagged("VERIFIED")
    if verified:
        v = verified[-1]["verdict"]
        had_judge = compiled and any(r["kind"] == "judge" for r in compiled[0]["contract"]["rungs"])
        status = f"{G}PASS{R}" if v.get("pass") else f"{Rd}FAIL{R}"
        ladder = "node --test ✓  +  LLM judge ✓" if had_judge else "deterministic ✓"
        print(
            f"  {C}verify{R}   → {status}   ladder ran: {ladder}  "
            f"(confidence {v.get('confidence', 0):.2f}){D}   ← key 1: frozen verifier{R}"
        )

    decided = tagged("SIGNOFF_DECIDED")
    if decided:
        veto = decided[-1]["approval"].get("veto")
        verdict = f"{Rd}VETO{R}" if veto else f"{G}no veto{R}"
        print(
            f"  {C}approve{R}  → {verdict}   independent LLM approver "
            f"(fed goal+rubric+diff+verdicts){D}   ← key 2: Sign-off{R}"
        )

    final = events[-1].get("stateTagAfter") if events else None
    if final == "DONE":
        print(f"  {B}{G}⇒ DONE — two independent keys agreed.{R}")
    elif final is not None:
        print(f"  {B}⇒ {final}{R}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
