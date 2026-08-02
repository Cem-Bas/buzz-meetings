/**
 * Persona library for design meetings.
 *
 * The source of truth is `meetings/personas.md` at the repo root — the same
 * file the Python harness reads. It is imported raw and parsed here rather
 * than copied into TypeScript, so the app and the harness can never disagree
 * about who exists or what they are for.
 */

// Vite inlines this at build time; no runtime filesystem access.
import personasMarkdown from "../../../../meetings/personas.md?raw";

export type Persona = {
  /** Heading text, e.g. "Architect". Also the agent's display name. */
  name: string;
  /** The prose under the heading — becomes the agent's system prompt. */
  description: string;
};

/** Who attends when the user doesn't choose. Mirrors DEFAULT_PANEL in meeting.py. */
export const DEFAULT_PANEL = [
  "Architect",
  "Backend",
  "UX",
  "Security",
  "Deleter",
] as const;

/** Chairs the meeting unless the user picks someone else. */
export const DEFAULT_CHAIR = "Architect";

/**
 * Parse the persona library. One `##` heading per persona; the prose under it
 * is that persona's description. `#` (h1) sections are commentary and close
 * the current persona.
 *
 * Kept deliberately identical in behaviour to `load_personas()` in meeting.py.
 */
function parsePersonas(markdown: string): Persona[] {
  const personas: Persona[] = [];
  let name: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (name) {
      const description = buffer.join("\n").trim();
      // A heading with no prose is a persona with no instruction to follow.
      if (description) {
        personas.push({ description, name });
      }
    }
    buffer = [];
  };

  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      name = line.slice(3).trim();
    } else if (line.startsWith("# ")) {
      flush();
      name = null;
    } else if (name !== null) {
      buffer.push(line);
    }
  }
  flush();

  return personas;
}

export const PERSONAS: Persona[] = parsePersonas(personasMarkdown);

export function findPersona(name: string): Persona | undefined {
  return PERSONAS.find((persona) => persona.name === name);
}
