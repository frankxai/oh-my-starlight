# ADR-0007: worker capacity strategy — no VM; park seats; hosted runners after publish

Status: accepted · 2026-10-22

## Context
OmO worker rails (OpenCode free tier) and browser QA need ~4 GiB free to run
safely (ADR-0004). The host showed 1.9–2.1 GiB free and the question of
building in a VM arose. Measured: the workstation has 15.8 GiB total, and
the top consumers are *resident agent seats* — codex monitor 1.0 GiB,
three claude processes ≈ 1.4 GiB, ChatGPT ≈ 0.9 GiB, chrome ≈ 0.5 GiB.
The scarcity is allocation, not capacity.

## Decision
1. **No VM for capacity.** A VM (Hyper-V, VirtualBox, WSL2) slices the
   same already-allocated host memory; it cannot create GiB that resident
   agents hold. It adds ops overhead without adding capacity.
2. **Capacity levers in order of preference:**
   - a) Park resident agent seats between missions (codex monitor between
     checks, idle ChatGPT/claude windows). ~2 GiB returns instantly.
   - b) Night window: nightly_eval runs when seats are naturally closed.
   - c) **GitHub Actions hosted runners after template publish**: standard
     `ubuntu-latest` = 4 vCPU / 16 GiB, free tier for public repos — the
     battery, page builds, and OmO bars run there at $0 with zero host
     risk. This is the real capacity unlock, not a local VM.
3. **Late, small, named VM uses (not for RAM):**
   - WSL2 for Linux-only tooling when actually needed (dynamic reclaim)
   - Windows Sandbox for disposable dirty-QA if hosted runners can't
 schedule something
4. **OmO on this machine: continue.** The OmO pattern (bar file + gates)
   is markdown and gate scripts — near-zero RAM. Only RAM-heavy verifiers
   (headed browsers, workers) wait for b) or c).

## Consequences
- "Should we build in a VM?" ⇒ no; invest in the seat-parking habit and
  the hosted-runner path.
- The template publish (GATE) becomes doubly valuable: it enables the
  16 GiB free-runner rail.
- ADR-0004's RAM floor stays; it will bite less once seats are parked.

## Alternatives considered
- Hyper-V/VirtualBox VM with 4 GiB — rejected: allocates from the same
  pool; compounds the problem.
- Second workstation now — rejected: capacity problem is soft; revisit
  only if hosted runners or the night window stop covering it.
- Docker Desktop — rejected: same WSL2 memory slice, same pool.
