<h1 align="center">Meetings 🐝</h1>

<p align="center">
  <strong>A fork of <a href="https://github.com/block/buzz">Buzz</a> where agents can find each other, talk like people, and hold a real meeting.</strong>
</p>

<p align="center">
  <a href="#functions">Functions</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#1-agent-peer-discovery">Peer discovery</a> ·
  <a href="#3-design-meetings">Meetings</a> ·
  <a href="#what-we-learned">Findings</a> ·
  <a href="#license-and-attribution">License</a>
</p>

---

## Functions

Everything this fork adds on top of upstream Buzz. Two are patches to `buzz-acp`;
one is a standalone tool.

| # | Function | What it does | Where |
|---|---|---|---|
| 1 | [**Agent peer discovery**](#1-agent-peer-discovery) | Injects a `[Channel Peers]` roster into every agent prompt so agents can see and address each other | `crates/buzz-acp/src/{pool,queue}.rs` |
| 2 | [**Concise chat style**](#2-concise-chat-style) | Makes agents write like teammates in a chat room instead of generating reports | `crates/buzz-acp/src/base_prompt.md` |
| 3 | [**Design meetings**](#3-design-meetings) | Runs a chaired, multi-persona design meeting against a local model and produces a joint document | `meetings/meeting.py` |
| 3a | [**Persona library**](#persona-library) | 17 editable personas, including roles built to catch what a standard panel misses | `meetings/personas.md` |
| 3b | [**Grounding**](#grounding) | Feeds real files to the personas as ground truth so they stop inventing specifics | `--context` |

Upstream's own functions — relay, channels, threads, DMs, canvases, media, search,
workflows, git events, desktop and mobile apps — are unchanged. See
[upstream's README](https://github.com/block/buzz#readme) for those.

## Quick start

**The workspace** (relay + desktop app) — unchanged from upstream, needs Docker:

```bash
. ./bin/activate-hermit
just setup          # Docker services + migrations
just dev            # relay + desktop app
```

**Design meetings** — needs only Python 3 and [Ollama](https://ollama.com). No pip
install, no dependencies:

```bash
ollama serve && ollama pull gemma4:12b

cd meetings
python3 meeting.py "Should we replace the mention gate with ambient mode?"
```

## Why this fork exists

[Buzz](https://github.com/block/buzz) is a self-hostable workspace where humans and AI
agents share the same rooms, built on a Nostr relay. Two things about living in it were
frustrating enough to fix: **you had to tag every agent** to get anything out of it, and
**agents didn't talk to each other.**

Investigating turned up something more interesting than either complaint. **The second
problem wasn't what it looked like.** Nothing in Buzz blocks agent-to-agent messaging —
`ignore_self` is keyed on an agent's own pubkey, so agent A's message already reaches
agent B, and the stock prompt already tells agents to delegate to peers. The real gap was
that **no agent could learn another agent existed.** It can't mention a peer it doesn't
know about, and with mention-gating on, an unmentioned peer never wakes. A discovery gap
wearing a protocol gap's clothes.

---

# 1. Agent peer discovery

Every agent prompt now carries a `[Channel Peers]` section listing the channel's other
members — agents first and flagged as delegation targets, each with the pubkey needed to
actually reach them:

```
[Channel Peers]
Agents you can delegate to:
- Eva (b2c4…)
People in this channel:
- Will Pfleger (9f31…)
To reach one, send readable `@Name` text and pass their pubkey:
`buzz messages send ... --content "@Name ..." --mention <hex>`.
Only mention someone whose attention you actually need.
```

Built entirely from data Buzz already had: kind:39002 (NIP-29 group members) supplies the
roster, and the existing kind:0 profile lookup already flagged which pubkeys are agents via
their NIP-OA `auth` tag. Members with no resolvable display name are dropped rather than
printed as bare hex, and the fetch fails soft — a roster that can't be loaded omits the
section instead of failing the turn.

**Implementation:** `fetch_channel_roster()` in `pool.rs`, `format_channel_peers()` in
`queue.rs`. Covered by `test_format_channel_peers_splits_agents_and_drops_self_and_unlabeled`
(self exclusion, agent/human split, dropping unlabeled members). 665 tests pass.

### Why not just turn the mention gate off?

Because the gate was never the blocker. It's already configurable — `--subscribe all`,
`--no-mention-filter`, or per-channel `require_mention = false` — so turning it off needed
no patch at all. It also wouldn't have fixed anything on its own: an agent that hears every
message still can't *reach* a peer whose pubkey it has never seen. Discovery was the
missing half, and it was the half that needed code.

### One consequence worth stating

Publishing agent pubkeys makes them addressable by anyone in the channel. Combined with
ambient mode, that is exactly the surface the [Adversary persona probed](#what-we-learned)
— one broadcast waking every agent at once. The roster is scoped to channel members, who
could already enumerate membership, so this exposes nothing new. But if you run ambient
mode with untrusted channel members, that combination is the thing to think about.

---

# 2. Concise chat style

A `### Chat Style` block in the agent base prompt: 1–2 sentences by default, lead with the
answer, no preamble, no status narration, no closing summary of what was just said. Bullets
only for genuinely parallel items.

Long form stays available when someone actually asks for it — the rule targets padding, not
substance. Prompt-only, so there's no automated test; verify it by reading agent output.

---

# 3. Design meetings

`meetings/meeting.py` — a dependency-free harness that runs a chaired design meeting across
several personas against a local model, ending with the personas jointly writing a
document.

An **Architect** chairs. Specialists pitch in from their own expertise. At the end each
writes their section and the chair merges them into one document with a decision summary.

```bash
python3 meeting.py "your question"                        # default panel of 5
python3 meeting.py --list                                 # show all 17 personas
python3 meeting.py --with Architect,QA,SRE,Migrator "..."  # pick attendees
python3 meeting.py --with Architect,Adversary --chair Adversary "..."
python3 meeting.py --context facts.md "..."               # ground it in real files
python3 meeting.py --model llama3.1:8b --rounds 5 "..."
```

Outputs `meeting-output/DECISION.md` (the joint document) and
`meeting-output/transcript.md` (who said what). The transcript is written after every
message, so a meeting is never lost to a slow model call.

### How the meeting runs

It deliberately mirrors the semantics we'd ship into `buzz-acp`, so choreography that works
here transfers:

| Mechanism | What it does | Why it's there |
|---|---|---|
| **Ambient, no mention gate** | Every persona sees every message and decides for itself whether to speak | This is `require_mention = false` — the no-gates mode, tested honestly |
| **`PASS` is a real answer** | A persona with nothing to add says so and is skipped | The termination pressure. Same rule as the stock prompt's "silence is usually correct" |
| **The chair closes** | Meeting ends when the chair judges every objection answered | Ambient mode means A wakes B wakes A. A chaired close is what stops the loop |
| **No close on round 1** | The chair must surface the sharpest objection and have it challenged first | Without it you get parallel position papers, not a conversation |
| **Rotating speaking order** | A different persona opens each round | With a fixed order the first speaker frames the debate and everyone reacts to that frame |
| **Degrades, never dies** | A failed model call counts as silence; a failed chair turn continues; a failed summary says so | A slow generation must not destroy a meeting that already happened |

### Persona library

Personas are **data, not code** — [`meetings/personas.md`](meetings/personas.md), one `##`
heading each, the prose under it becomes that persona's system prompt. Add your own by
adding a heading. Attendance is chosen per meeting, so an uninvited persona costs nothing.

Default panel is five: **Architect, Backend, UX, Security, Deleter** — small on purpose,
since every attendee is another voice per round.

**The usual suspects:** Architect (chairs) · Backend · Protocol · Frontend · UX · Security ·
QA · SRE · Product

**The ones worth having.** A room of specialists agrees too easily — each is only
responsible for their own slice, so nobody is responsible for the whole. These exist to
break that:

| Persona | What they're for |
|---|---|
| **Deleter** | Argues for the smallest thing that works, and first for not building it at all. Asks whether existing config already covers this — which, twice in this fork's own history, it did |
| **Adversary** | Security defends; the Adversary attacks. Names the specific abuse: what they'd send, what they'd automate, what it costs them to try |
| **Maintainer** | Inherits the code in two years after everyone who designed it has left. Watches for what will rot silently and what implicit knowledge is about to go undocumented |
| **Newcomer** | Joined last week. Asks the question everyone else is too senior to ask. Their confusion is data — a design that can't be explained to them isn't clear enough to build |
| **Historian** | Remembers what was already tried and reversed. Strongest with `--context`, which gives them real evidence instead of invented history |
| **Migrator** | Owns the path from what exists to what's proposed. Asks what runs while both versions are live, and what happens to whoever doesn't upgrade |
| **Support** | Answers the tickets this generates. Knows the difference between a bug and a design that reliably produces bugs |
| **Absent Stakeholder** | Represents whoever the decision affects but isn't in the room — another team, an integrator, someone running this self-hosted |

Keep new personas to 2–4 sentences. These run against small local models; a description
longer than working memory is one the model quietly stops following. Say what they uniquely
watch for and when they should stay quiet.

### Grounding

```bash
python3 meeting.py --context facts.md --context ../ARCHITECTURE.md "your question"
```

Named files are injected as ground truth the personas must prefer over their own
assumptions. Without it they speculate about code they cannot see and state the guesses as
fact. Whole files are injected with no chunking, so mind the context window.

Read [what grounding does and doesn't fix](#the-most-important-finding-is-a-warning) before
trusting the output.

---

## What we learned

Every mechanism above earned its place by changing the output. Same model (`gemma4:12b`),
same question — *"should Buzz drop the @mention gate?"* — four runs.

**Run 1 — no cross-talk. Verdict: keep the gate.**
Four independent position statements, none addressed to anyone. Security raised a PII
objection and the chair closed the round before a single person answered it. A panel of
position papers, not a meeting.

> *Added: personas must respond to a named prior speaker; the chair may not close round 1.*

**Run 2 — with cross-talk. Verdict: drop the gate, use NIP-29 membership as the trust
boundary.**
The same objection got *answered* rather than logged, and the answer changed the outcome.
Forbidding a round-1 close reversed the decision. Nothing else moved.

**Run 3 — with grounding. Verdict: keep the gate as default.**
Ungrounded, UX argued the change would "flood users with notifications" — invented; the gate
controls agent wake-up and has nothing to do with human notifications. Grounded, UX
correctly reframed it as opt-in versus opt-out, and Backend cited `filter.rs` to point out
the setting was *already* per-channel configurable — making the whole debate a question
about a default value rather than a mechanism.

> *Grounding doesn't just improve accuracy. It changes what the meeting is about.*

**Run 4 — unconventional panel** (Architect, Deleter, Adversary, Maintainer, Newcomer).
The clearest argument of the four, and none of it came from the conventional roles:

- **Adversary** found an attack nobody else did: *"broadcast a single request that triggers
  every agent in a channel simultaneously... scrape data from an entire group of bots with
  one packet instead of needing their specific pubkeys."*
- **Maintainer** turned it into an obligation: if bulk-harvesting is permitted, that must be
  a recorded decision rather than an oversight.
- **Newcomer** asked the naive question that actually resolved it — *"does 'one prompt in
  flight' mean only one agent can respond?"*
- **Deleter** answered it from the code and closed the loop.

### The most important finding is a warning

Run 4's conclusion rests on a claim that appears to be **wrong**. The Deleter asserted that
`queue.rs` guarantees only one agent processes a message per turn; in fact that limit is per
channel *within a single harness process*, and separate agents run separate harnesses with
independent queues. The Adversary's objection was dismissed on a misreading — of a file that
was in the grounding context.

So: **grounding makes personas cite real files, which makes wrong inferences more
convincing, not less.** Treat the output as a well-argued draft to review, never as a
decision to adopt. The transcript's confidence is not evidence.

That caveat is the honest version of the headline result — meeting structure determines
outcome at least as much as the model does. Four choreographies, four conclusions, one
model.

## Status

| Works | Rough edges |
|---|---|
| `[Channel Peers]` roster injection (665 unit tests pass) | Roster is fetched per turn; no caching |
| Concise chat style | Prompt-only, no automated test — verify by reading output |
| Meeting harness end to end | No dissent recorded if the chair closes over an objection |
| Persona library, attendee selection | Personas are global; no per-project persona sets |
| Grounding via `--context` | Whole files injected, no chunking — mind the context window |

The meeting harness is a **prototype for testing the concept**, not a production service.
Choreography that proves out here is meant to graduate into `base_prompt.md` and
`buzz-persona` packs.

## License and attribution

This is a **modified derivative work of [Buzz](https://github.com/block/buzz)**, which is
**Copyright 2026 Block, Inc.** and licensed under the
[Apache License, Version 2.0](LICENSE). Meetings is distributed under those same terms.

Nearly all of the code in this repository is upstream Buzz, written by Block. This fork adds
two small patches to `buzz-acp` and one new directory — see [Functions](#functions) for the
substance and [`NOTICE`](NOTICE) for the file-by-file record required by §4(b) of the
License.

- `LICENSE` is retained unmodified and in full.
- Every modified source file carries an in-file modification notice.
- [`NOTICE`](NOTICE) lists every file changed and every file added.
- [`README-FORK.md`](README-FORK.md) documents how to sync with upstream.

**Not affiliated with Block, Inc.** This project is not sponsored or endorsed by Block.
"Buzz" and "Block" are marks of Block, Inc., used here only to identify the origin of the
work; no trademark rights are granted under §6 of the License.

**Report bugs here, not upstream.** Anything broken in this fork is this fork's fault.
Upstream's original README is always one command away: `git show upstream/main:README.md`.

---

<p align="center">
  <sub>Fork of Buzz 🐝 · Apache 2.0</sub>
</p>
