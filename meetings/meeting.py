#!/usr/bin/env python3
"""Test the Buzz multi-agent meeting concept against a local Ollama model.

Mirrors the semantics we'd ship in buzz-acp so the result transfers:

  - Ambient, no mention gate: every persona sees every message (the "no gates"
    mode), and decides for itself whether it has something to add.
  - PASS is a first-class answer. This is the termination pressure, and it is
    the same rule as base_prompt.md's "silence is usually correct".
  - The Architect chairs: opens the agenda, and after each round decides to
    continue or close. A chaired close is what stops the A-wakes-B-wakes-A
    feedback loop that ambient mode creates.
  - At the end, every persona writes a section and the chair merges them into
    one document.

Usage:
    python3 meeting.py "Should we replace the mention gate with ambient mode?"
    python3 meeting.py --rounds 4 --model gemma4:12b "topic here"
"""

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

OLLAMA = "http://localhost:11434/api/chat"

# Kept deliberately short. A meeting protocol a small model can't hold in
# working memory is a protocol it will not follow.
PERSONA_FILE = Path(__file__).parent / "personas.md"

# Who shows up when you don't say. Small on purpose: every attendee is another
# voice per round, and a room where nobody can hear themselves think produces
# the same slop a room of two does, only slower.
DEFAULT_PANEL = ["Architect", "Backend", "UX", "Security", "Deleter"]


def load_personas(path):
    """Parse the persona library. One `## Name` heading per persona; the prose
    under it becomes that persona's system prompt.

    Markdown rather than JSON/YAML: these are paragraphs a human edits, and
    stdlib has no YAML. `#` (h1) sections are commentary and are skipped.
    """
    if not path.is_file():
        sys.exit(f"persona library not found: {path}")

    personas = {}
    name, buf = None, []
    for line in path.read_text().splitlines():
        if line.startswith("## "):
            if name:
                personas[name] = "\n".join(buf).strip()
            name, buf = line[3:].strip(), []
        elif line.startswith("# "):
            # An h1 closes the current persona; prose after it is commentary.
            if name:
                personas[name] = "\n".join(buf).strip()
            name, buf = None, []
        elif name is not None:
            buf.append(line)
    if name:
        personas[name] = "\n".join(buf).strip()

    # A heading with no prose is a persona with no instruction to follow — it
    # would sit in the meeting contributing nothing. Fail loudly instead.
    empty = [n for n, p in personas.items() if not p]
    if empty:
        sys.exit(f"persona(s) with no description in {path.name}: {', '.join(empty)}")
    if not personas:
        sys.exit(f"no personas found in {path} — expected `## Name` headings")
    return personas

STYLE = (
    "This is a chat room, not a report. Write 1-3 sentences, plain prose. "
    "Lead with your point. No preamble, no headings, no bullet lists, no restating what others said."
)


def ask(model, system, messages, timeout=300, tries=2):
    """One chat completion against Ollama.

    Returns the reply text, or None if the model could not be reached after
    `tries` attempts. Callers degrade on None — a slow generation must never
    destroy a meeting that is already half-finished. Long transcripts plus
    --context grounding make late turns much slower than early ones, so the
    timeout has to tolerate a turn far slower than the first one.

    Connection refused is fatal (nothing will work); timeouts and transport
    errors are retried once, then surrendered to the caller.
    """
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system}] + messages,
        "stream": False,
        "options": {"temperature": 0.7},
    }
    req = urllib.request.Request(
        OLLAMA,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)["message"]["content"].strip()
        except (TimeoutError, urllib.error.HTTPError, ConnectionError) as e:
            note = f"  \033[2m(model call failed: {type(e).__name__}"
            print(f"{note}, attempt {attempt}/{tries})\033[0m", file=sys.stderr)
        except urllib.error.URLError as e:
            # Nothing listening — retrying cannot help.
            sys.exit(f"cannot reach Ollama at {OLLAMA}: {e}\nIs `ollama serve` running?")
    return None


def transcript_text(log):
    return "\n".join(f"{who}: {what}" for who, what in log) or "(nothing said yet)"


def speaks(text):
    """True if the persona actually contributed.

    A persona passed if it opened with PASS (tolerant — small models add fluff).
    A failed model call (None) is also silence: it contributed nothing, so the
    meeting carries on without it rather than dying.
    """
    if text is None:
        return False
    return not re.match(r"^\W*pass\b", text.strip(), re.I)


def save(out, topic, log, doc=None):
    """Write the transcript (and document, once it exists) to disk.

    Called after every message, not just at the end. A meeting is expensive to
    produce and the failure mode we actually hit was losing a finished one to a
    single slow call on the very last turn.
    """
    out.mkdir(parents=True, exist_ok=True)
    (out / "transcript.md").write_text(
        f"# Transcript: {topic}\n\n"
        + "\n\n".join(f"**{w}:** {t}" for w, t in log)
        + "\n"
    )
    if doc:
        (out / "DECISION.md").write_text(doc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("topic", nargs="?")
    ap.add_argument(
        "--with",
        dest="attendees",
        metavar="NAME,NAME",
        help=f"who attends, comma-separated. Default: {','.join(DEFAULT_PANEL)}",
    )
    ap.add_argument("--chair", help="who chairs. Default: first attendee")
    ap.add_argument(
        "--personas",
        type=Path,
        default=PERSONA_FILE,
        metavar="FILE",
        help="persona library to load (default: personas.md next to this script)",
    )
    ap.add_argument(
        "--list", action="store_true", help="list available personas and exit"
    )
    ap.add_argument("--model", default="gemma4:12b")
    ap.add_argument("--rounds", type=int, default=3, help="max rounds before forced close")
    ap.add_argument("--out", default="meeting-output")
    ap.add_argument(
        "--context",
        action="append",
        default=[],
        metavar="FILE",
        help="file(s) of background the personas may cite. Repeatable. "
        "Without this they speculate about code they cannot see and state "
        "the guesses as fact.",
    )
    args = ap.parse_args()

    library = load_personas(args.personas)

    if args.list:
        print(f"{len(library)} personas in {args.personas.name}:\n")
        for name, desc in library.items():
            first = desc.split(".")[0].replace("\n", " ").strip()
            mark = "*" if name in DEFAULT_PANEL else " "
            print(f" {mark} {name:<20} {first}.")
        print(f"\n* = in the default panel ({', '.join(DEFAULT_PANEL)})")
        return
    if not args.topic:
        ap.error("topic is required (or use --list)")

    # Resolve attendance before spending a single token on the model.
    attendees = (
        [n.strip() for n in args.attendees.split(",") if n.strip()]
        if args.attendees
        else list(DEFAULT_PANEL)
    )
    unknown = [n for n in attendees if n not in library]
    if unknown:
        sys.exit(
            f"unknown persona(s): {', '.join(unknown)}\n"
            f"available: {', '.join(library)}\nrun --list for descriptions"
        )
    if len(attendees) < 2:
        sys.exit("a meeting needs at least 2 attendees (a chair and someone to talk to)")

    chair = args.chair or attendees[0]
    if chair not in attendees:
        sys.exit(f"chair {chair!r} is not attending — add them to --with")

    PERSONAS = {n: library[n] for n in attendees}
    CHAIR = chair

    # Grounding. An ungrounded persona is confidently wrong about specifics,
    # which is worse than silent — it puts invented facts into the document.
    facts = ""
    for path in args.context:
        p = Path(path)
        if not p.is_file():
            sys.exit(f"--context file not found: {path}")
        facts += f"\n--- {p.name} ---\n{p.read_text()}\n"
    if facts:
        facts = (
            "\n\nGROUND TRUTH. These are the real facts of the system under "
            "discussion. Prefer them over your assumptions, cite them by name "
            "when relevant, and if they contradict you, they win. Say so plainly "
            "when you do not know something rather than inventing it."
            + facts
        )

    out = Path(args.out)
    log = []
    roster = ", ".join(PERSONAS)

    def persona_system(name):
        return (
            f"You are {name} in a design meeting with: {roster}. "
            f"{PERSONAS[name]}\n{STYLE}" + facts
        )

    # --- Chair opens -----------------------------------------------------
    opening = ask(
        args.model,
        persona_system(CHAIR),
        [{"role": "user", "content":
          f"Open the meeting on: {args.topic}\n"
          "State the question to be decided and name the one thing you most need "
          "input on. Two sentences."}],
    )
    if opening is None:
        sys.exit("the chair could not open the meeting — is the model responding?")
    log.append((CHAIR, opening))
    save(out, args.topic, log)
    print(f"\n\033[1m{CHAIR}\033[0m (chair, opening)\n  {opening}\n")

    # --- Rounds: ambient self-selection ----------------------------------
    specialists = [n for n in PERSONAS if n != CHAIR]

    for rnd in range(1, args.rounds + 1):
        print(f"\033[2m--- round {rnd} ---\033[0m")
        spoke_this_round = 0

        # Rotate who speaks first. With a fixed order the first speaker frames
        # the whole debate and everyone else reacts to that frame.
        shift = (rnd - 1) % len(specialists)
        for name in specialists[shift:] + specialists[:shift]:
            # Round 1 is opening positions; from round 2 on, engage each other.
            # Without this they deliver parallel position papers and the
            # meeting is a panel, not a conversation.
            if rnd == 1:
                task = (
                    "Give your opening position from your specialty. "
                    "If you have nothing to add, reply with exactly: PASS"
                )
            else:
                task = (
                    "Respond to a specific person above BY NAME — say whether you "
                    "agree, disagree, or want to build on what they said, and why "
                    "from your specialty. Do not repeat your earlier point. "
                    "If your point already landed and you have nothing new, reply "
                    "with exactly: PASS"
                )
            reply = ask(
                args.model,
                persona_system(name),
                [{"role": "user", "content":
                  f"Topic: {args.topic}\n\nMeeting so far:\n{transcript_text(log)}\n\n"
                  + task}],
            )
            if speaks(reply):
                log.append((name, reply))
                spoke_this_round += 1
                save(out, args.topic, log)
                print(f"\033[1m{name}\033[0m\n  {reply}\n")
            elif reply is None:
                print(f"\033[2m{name}: (skipped — model call failed)\033[0m")
            else:
                print(f"\033[2m{name}: (pass)\033[0m")

        # Nobody had anything left. This is convergence, not failure.
        if spoke_this_round == 0:
            print("\n\033[2mall passed — converged\033[0m\n")
            break

        # --- Chair decides whether to keep going -------------------------
        # The chair may not close round 1. Everyone has stated a position and
        # nobody has answered anyone yet; closing here is what turned the first
        # run into a panel. Objections deserve a reply before a decision.
        if rnd == 1:
            verdict = ask(
                args.model,
                persona_system(CHAIR),
                [{"role": "user", "content":
                  f"Topic: {args.topic}\n\nMeeting so far:\n{transcript_text(log)}\n\n"
                  "Everyone has given an opening position. Name the sharpest "
                  "disagreement or the objection that most needs answering, and "
                  "ask the person who raised it to be challenged. Two sentences. "
                  "Do not decide yet."}],
            )
        else:
            verdict = ask(
                args.model,
                persona_system(CHAIR),
                [{"role": "user", "content":
                  f"Topic: {args.topic}\n\nMeeting so far:\n{transcript_text(log)}\n\n"
                  "Has every serious objection been answered? If yes, reply exactly: "
                  "CLOSE followed by one sentence stating the decision. If an "
                  "objection is still unanswered, reply exactly: CONTINUE followed "
                  "by that open question."}],
            )
        if verdict is None:
            # The chair lost its voice. Carry on to the next round rather than
            # discarding a meeting that has already happened; the round cap
            # still bounds us, and drafting works off the transcript regardless.
            print("\033[2m(chair unreachable — continuing)\033[0m\n")
            continue
        log.append((CHAIR, verdict))
        save(out, args.topic, log)
        print(f"\033[1m{CHAIR}\033[0m (chair)\n  {verdict}\n")
        if rnd > 1 and verdict.strip().upper().startswith("CLOSE"):
            break

    # --- Everyone writes their section -----------------------------------
    print("\033[2m--- drafting ---\033[0m")
    sections = []
    for name in PERSONAS:
        if name == CHAIR:
            continue
        sec = ask(
            args.model,
            persona_system(name),
            [{"role": "user", "content":
              f"Topic: {args.topic}\n\nMeeting transcript:\n{transcript_text(log)}\n\n"
              "Write your section of the meeting's written outcome, covering only "
              "your specialty and only what was actually decided or raised above. "
              "Under 120 words, markdown, no top-level heading. If you contributed "
              "nothing relevant, reply exactly: PASS"}],
        )
        if speaks(sec):
            sections.append(f"## {name}\n\n{sec}")
            print(f"  {name}: section written")
        else:
            print(f"\033[2m  {name}: (no section)\033[0m")

    body = "\n\n".join(sections)
    summary = ask(
        args.model,
        persona_system(CHAIR),
        [{"role": "user", "content":
          f"Topic: {args.topic}\n\nMeeting transcript:\n{transcript_text(log)}\n\n"
          f"Contributed sections:\n{body}\n\n"
          "Write the decision summary that opens this document: what was decided, "
          "and what remains open. Under 100 words, markdown, no heading."}],
    )
    if summary is None:
        # Say so in the document rather than shipping a decision nobody made.
        summary = (
            "_The chair's closing summary could not be generated. "
            "The sections below and `transcript.md` are the meeting's record._"
        )

    doc = f"# {args.topic}\n\n## Decision\n\n{summary}\n\n{body}\n"
    save(out, args.topic, log, doc)
    print(f"\n\033[1mwrote\033[0m {out}/DECISION.md and {out}/transcript.md")
    print(f"\033[2m{len(log)} messages, {len(sections)} sections\033[0m")


if __name__ == "__main__":
    main()
