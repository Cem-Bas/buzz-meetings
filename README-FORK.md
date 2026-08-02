# Buzz fork — what we're changing and why

Source: https://github.com/block/buzz (cloned to `./buzz`)
Decision: **patch `buzz-acp` directly in our own fork.** Not a plugin, not upstreamed.

## What the user asked for

1. **"You need to tag each AI agent to talk to them."**
   Mention-gating is the default and it's infuriating. Agents are deaf unless
   explicitly `@`-tagged.

2. **"They don't talk to each other."**
   Agents never initiate with each other, so multi-agent work stalls.

3. **"Agents need to talk like humans in chat. SUPER CONCISE CHATS."**
   No essays, no reports, no status theater. Chat-room register.

## What's actually going on in the code

| Symptom | Where it lives | Verdict |
|---|---|---|
| Must tag each agent | `buzz-acp/src/filter.rs:390` (`require_mention`), default set at `config.rs:1271` | Already a **config default**, not a hard rule — `--subscribe all` / `--no-mention-filter` / per-channel `require_mention = false` turns it off |
| Agents ignore each other | `buzz-acp/src/lib.rs:2098` (`ignore_self`) | **Not blocked.** `ignore_self` is per-pubkey, so A's message does reach B. `base_prompt.md:49-62` already tells agents to delegate to peers by `@mention` |
| Real root cause | `base_prompt.md:100` | **No roster.** Nothing tells an agent which peers are in the channel. It can't mention someone it doesn't know exists — and with mention-gating on, an unmentioned peer never wakes. Discovery gap, not a protocol gap |

Cost of just flipping mention-gating off: `queue.rs` runs one prompt in flight
per channel, so every agent burns a turn on every message. That's why the
default is what it is. Roster first, gate second.

## Changes

- [x] **Concise chat style** — new `### Chat Style` block in
      `buzz-acp/src/base_prompt.md`. 1–2 sentence default, lead with the answer,
      no preamble/summary/status narration, bullets only for 3+ parallel items,
      long form opt-in.
- [x] **Channel roster** — inject the channel's other agents (name + pubkey)
      into the `[Context]` block so agents can discover and mention peers.
      Machinery already exists: kind:39002 `d`=channel_id gives member `p` tags,
      and `PromptProfile.is_agent` (`queue.rs:1013`) already flags agents from
      their kind:0 NIP-OA `auth` tag.

## Open

- Whether to also change the mention-gate default once the roster lands.

---

# Fork strategy — read this before syncing with upstream

**For agents: follow this exactly. Do not improvise a merge strategy.**

## Current state

- `origin` points at **upstream** (`https://github.com/block/buzz`) — there is
  no separate fork remote yet. Forked at `f86cfc7`.
- The clone is **shallow** (`--depth 1`). You cannot rebase or merge against
  upstream history until you run `git fetch --unshallow` (once).
- Our changes are uncommitted on the default branch. First sync should put them
  on a branch (see below).

## The one rule

**Keep the diff against upstream as small and as localized as possible.**
Every line we change is a line we hand-merge on every sync. Before adding code,
check whether upstream already exposes a config knob — twice now the answer was
yes (`require_mention`, `--subscribe all`). Config beats patch. Patch beats fork-wide
refactor. Never reformat, rename, or "clean up" upstream code we aren't
functionally changing — a stray formatting change turns a clean merge into a
conflict for no benefit.

## Where our changes live

Keep this table current. It is the merge checklist.

| File | Change | Conflict risk |
|---|---|---|
| `crates/buzz-acp/src/base_prompt.md` | Added `### Chat Style` block | **High** — upstream edits this prompt often. Ours is one self-contained section; on conflict keep both and re-insert our block before `### General` |
| `crates/buzz-acp/src/queue.rs` | `roster` + `self_pubkey` on `FormatPromptArgs`; `format_channel_peers()`; section 2b in `format_prompt`; one test | Medium — additive, but `format_prompt` section ordering is upstream-owned |
| `crates/buzz-acp/src/pool.rs` | `fetch_channel_roster()`; `roster` param on `fetch_prompt_profile_lookup()`; call-site wiring | Medium — additive |
| `README.md` | **Replaced** with the fork's front page | **Permanent conflict — always take ours.** Upstream's original is `git show upstream/main:README.md`; re-read it after a sync in case setup instructions changed |
| `meetings/` | New: chaired multi-persona meeting harness (Python, no deps) | None — new directory, upstream has nothing here |
| `README-FORK.md` | This file | None (ours only) |

Nothing else is touched. If that stops being true, add a row — an undocumented
change is one that gets silently dropped in a merge.

## One-time setup

```bash
git fetch --unshallow                 # required: clone was --depth 1
git remote rename origin upstream
git remote add origin <your-fork-url> # once a fork exists
git checkout -b fork-main
git add -A && git commit -s -m "fork: agent roster + concise chat style"
```

Commit with `-s` — upstream's DCO check requires it, and keeping it habitual
means our commits stay upstreamable if we ever change our minds.

## Syncing with upstream

**Rebase, don't merge.** A linear stack of our patches on top of upstream keeps
the fork diff readable and reviewable; merge commits bury it.

```bash
git fetch upstream
git rebase upstream/main            # resolve using the table above
. ./bin/activate-hermit
just ci                             # non-negotiable, see below
```

Resolving conflicts:

1. **Ours is almost always additive.** Take upstream's version of the hunk,
   then re-apply our addition on top. Do not take "ours" wholesale — that
   silently reverts upstream fixes.
2. **`base_prompt.md`** — our `### Chat Style` block is self-contained. On any
   conflict, keep all of upstream's prose and re-insert our block immediately
   before `### General`.
3. **If upstream adds a real roster or a peer-discovery feature, delete ours.**
   That is a win, not a loss. The patch exists only because upstream lacked it.
4. **If a conflict is large enough that you're rewriting our patch, stop and
   ask.** Do not reimplement the feature blind against changed upstream code.

## Verifying a sync

Never declare a sync done on a clean rebase alone — a clean rebase only means
the text merged, not that the code still works.

```bash
. ./bin/activate-hermit
just ci                                        # fmt + clippy + unit tests + build
cargo test -p buzz-acp --lib                   # 665 tests + ours must pass
cargo test -p buzz-acp --lib format_channel_peers   # our roster logic specifically
```

Our functional canary is
`queue::tests::test_format_channel_peers_splits_agents_and_drops_self_and_unlabeled`.
If it vanished in a merge, the roster patch was dropped — restore it.

The chat-style change has no test (it's prompt text). Verify it by eye: `grep -n
"### Chat Style" crates/buzz-acp/src/base_prompt.md` must still hit, and the
block must still sit inside `## Communication Patterns`.

## What not to do

- Don't push to `upstream`. Ever.
- Don't `git merge upstream/main` — rebase (see above).
- Don't resolve a conflict by deleting upstream code you don't understand.
- Don't run `just reset` to "fix" a broken sync; it wipes local data.
- Don't bump the diff by reformatting. `just fix-all` on files we didn't touch
  creates conflicts out of nothing.
