#!/usr/bin/env python3
"""Starlight night-cap gate: refuse unattended spend beyond the night cap.

Sums today's routing receipts (local day, Europe/Amsterdam) plus any extra
planned spend and fails (exit 2) when the total exceeds night_cap_usd from
routing.schema.json. Wire into night_runner manifest validation:

  python fleet/night_cap_check.py --extra-planned-usd 15

Failed receipts still count: a failed paid call may have been billed. Receipts
whose cost is missing, negative or not finite, and lines that cannot be parsed,
make the accounting incomplete: the gate blocks (exit 2) rather than guess.
This sums local receipts only; it is not a provider-side spending cap.
"""
import argparse
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = HERE / "routing.schema.json"
RECEIPTS = HERE / "receipts" / "routing.jsonl"
CET = timedelta(hours=1)
CEST = timedelta(hours=2)


def _last_sunday_0100_utc(year: int, month: int) -> datetime:
    """EU DST switch instant: last Sunday of March/October at 01:00 UTC."""
    last_day = datetime(year, month + 1, 1, tzinfo=timezone.utc) - timedelta(days=1)
    last_sunday = last_day - timedelta(days=(last_day.weekday() + 1) % 7)
    return last_sunday.replace(hour=1, minute=0, second=0, microsecond=0)


def amsterdam_offset(instant_utc: datetime) -> timedelta:
    """UTC offset of Europe/Amsterdam at an instant, from the EU DST rule.

    Stdlib only: zoneinfo has no tz database on this Windows Python.
    """
    t = instant_utc.astimezone(timezone.utc)
    start = _last_sunday_0100_utc(t.year, 3)
    end = _last_sunday_0100_utc(t.year, 10)
    return CEST if start <= t < end else CET


def _local_midnight_utc(local_date) -> datetime:
    """UTC instant of 00:00 local on a date (DST never switches at midnight)."""
    naive = datetime(local_date.year, local_date.month, local_date.day)
    for offset in (CET, CEST):
        candidate = (naive - offset).replace(tzinfo=timezone.utc)
        if amsterdam_offset(candidate) == offset:
            return candidate
    raise ValueError(f"no local midnight for {local_date}")


def today_bounds(now_utc: datetime | None = None) -> tuple[datetime, datetime]:
    """UTC bounds [start, end) of the current Amsterdam day."""
    now_utc = (now_utc or datetime.now(timezone.utc)).astimezone(timezone.utc)
    local_date = (now_utc + amsterdam_offset(now_utc)).date()
    return (_local_midnight_utc(local_date),
            _local_midnight_utc(local_date + timedelta(days=1)))


def _local_day_bounds(day_utc: datetime) -> tuple[datetime, datetime]:
    """Keep the reviewed main helper name with correct transition-day bounds."""
    return today_bounds(day_utc)


def spend_today(receipts: Path = RECEIPTS, now_utc: datetime | None = None) -> dict:
    """Spend in today's window. Counts failed receipts; reports what it cannot read."""
    out = {"spent": 0.0, "receipts": 0, "failed_receipts_counted": 0,
           "unknown_cost_receipts": 0, "skipped_lines": 0}
    if not receipts.exists():
        return out
    start, end = today_bounds(now_utc)
    for line in receipts.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            ts = datetime.fromisoformat(r["ts"])
            if ts.tzinfo is None:  # receipts are written as UTC
                ts = ts.replace(tzinfo=timezone.utc)
        except (KeyError, ValueError, TypeError):
            out["skipped_lines"] += 1
            continue
        if not start <= ts < end:
            continue
        out["receipts"] += 1
        try:
            if isinstance(r["cost_usd"], bool):
                raise ValueError("boolean is not a monetary amount")
            cost = float(r["cost_usd"])
        except (KeyError, ValueError, TypeError, OverflowError):
            cost = math.nan
        if not math.isfinite(cost) or cost < 0:
            out["unknown_cost_receipts"] += 1
            continue
        out["spent"] += cost
        if not r.get("success"):
            out["failed_receipts_counted"] += 1
    return out


def spent_today() -> float:
    """Legacy float API remains available, but never hides incomplete evidence."""
    seen = spend_today(RECEIPTS)
    if seen["unknown_cost_receipts"] or seen["skipped_lines"]:
        raise ValueError("incomplete routing receipt cost evidence")
    return seen["spent"]


def selftest() -> int:
    """Retain current CI's offline entry point, including 23/25-hour days."""
    cases = [
        ("2026-06-15T22:30:00", "2026-06-16", 24),
        ("2026-11-01T22:30:00", "2026-11-01", 24),
        ("2026-11-01T23:59:00", "2026-11-02", 24),
        ("2026-10-24T23:30:00", "2026-10-25", 25),
        ("2026-10-25T01:30:00", "2026-10-25", 25),
        ("2026-03-29T00:30:00", "2026-03-29", 23),
        ("2026-03-29T01:30:00", "2026-03-29", 23),
    ]
    ok = True
    for iso_z, want_date, want_hours in cases:
        instant = datetime.fromisoformat(iso_z + "+00:00")
        got_date = (instant + amsterdam_offset(instant)).date().isoformat()
        start, end = today_bounds(instant)
        if got_date != want_date or not start <= instant < end or end - start != timedelta(hours=want_hours):
            print(f"  FAIL {iso_z}: local {got_date}, expected {want_date}; expected {want_hours}h window")
            ok = False
    if not ok:
        return 1
    print("night cap selftest OK: 7 DST/day-boundary cases, including 23/25-hour windows")
    return 0


def planned_usd(text: str) -> float:
    value = float(text)
    if not math.isfinite(value) or value < 0:
        raise argparse.ArgumentTypeError("must be a finite, non-negative amount")
    return value


def main():
    if sys.argv[1:2] == ["selftest"]:
        raise SystemExit(selftest())
    ap = argparse.ArgumentParser(description="Night-cap spend gate.")
    ap.add_argument("--extra-planned-usd", type=planned_usd, default=0.0,
                    help="Additional planned spend this night (manifest estimate)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    cap = float(schema["night_cap_usd"])
    seen = spend_today(RECEIPTS)
    spent = seen["spent"]
    total = spent + args.extra_planned_usd
    complete = not (seen["unknown_cost_receipts"] or seen["skipped_lines"])
    ok = complete and total <= cap
    out = {
        "cap_usd": cap,
        "spent_today_usd": round(spent, 4),
        "extra_planned_usd": args.extra_planned_usd,
        "total_usd": round(total, 4),
        "ok": ok,
        "complete": complete,
        "receipts_today": seen["receipts"],
        "failed_receipts_counted": seen["failed_receipts_counted"],
        "unknown_cost_receipts": seen["unknown_cost_receipts"],
        "skipped_lines": seen["skipped_lines"],
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    if args.json:
        print(json.dumps(out, indent=2))
    else:
        status = "OK" if ok else ("BLOCK" if complete else "BLOCK-INCOMPLETE")
        print(f"[{status}] night cap ${cap}: spent ${out['spent_today_usd']} "
              f"+ planned ${args.extra_planned_usd} = ${out['total_usd']}")
        if not complete:
            print(f"[WARN] {seen['unknown_cost_receipts']} receipt(s) with missing or invalid "
                  f"cost and {seen['skipped_lines']} unparseable line(s): total is a lower bound")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
