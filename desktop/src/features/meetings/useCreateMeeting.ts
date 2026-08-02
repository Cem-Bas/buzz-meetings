import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { DEFAULT_CHAIR, findPersona } from "@/features/meetings/personas";
import { createManagedAgent } from "@/shared/api/tauri";
import { createChannel } from "@/shared/api/tauriChannels";
import { addChannelMembers } from "@/shared/api/tauri";
import type { Channel } from "@/shared/api/types";

export type CreateMeetingInput = {
  topic: string;
  /** Persona names, as they appear in personas.md. */
  attendees: string[];
  /** Which attendee chairs. Must be one of `attendees`. */
  chair: string;
};

export type CreateMeetingResult = {
  channel: Channel;
  /** Personas that could not be created, with the reason. Empty on full success. */
  failures: { name: string; reason: string }[];
};

/** Prefix for channels created as meetings. Also how a meeting channel is recognised. */
export const MEETING_CHANNEL_PREFIX = "meeting-";

/** True when this channel is itself a meeting — used to hide "Create a meeting" inside one. */
export function isMeetingChannel(channelName: string | undefined): boolean {
  return Boolean(channelName?.startsWith(MEETING_CHANNEL_PREFIX));
}

/** Channel names are user-visible; keep them short and readable. */
const MAX_CHANNEL_NAME = 60;

/**
 * Turn a meeting topic into a channel name: lowercased, hyphenated, trimmed.
 * Falls back to a generic name when the topic has no usable characters, since
 * an empty channel name is rejected by the relay.
 */
export function meetingChannelName(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CHANNEL_NAME)
    .replace(/-+$/g, "");
  return slug
    ? `${MEETING_CHANNEL_PREFIX}${slug}`.slice(0, MAX_CHANNEL_NAME)
    : "meeting";
}

/**
 * Build the system prompt for one persona in a meeting.
 *
 * Mirrors `persona_system()` in meetings/meeting.py so a persona behaves the
 * same whether it runs in the harness or as a Buzz agent. The meeting protocol
 * is stated here because these agents run ambiently: without an explicit rule
 * to stay quiet, every agent responds to every message and the channel becomes
 * a feedback loop.
 */
export function buildMeetingSystemPrompt({
  chair,
  description,
  name,
  roster,
  topic,
}: {
  chair: string;
  description: string;
  name: string;
  roster: string[];
  topic: string;
}): string {
  const others = roster.filter((entry) => entry !== name);
  const isChair = name === chair;

  return [
    `You are ${name} in a design meeting with: ${others.join(", ")}.`,
    description,
    "",
    `The meeting topic is: ${topic}`,
    "",
    "This is a chat room, not a report. Write 1-3 sentences, plain prose.",
    "Lead with your point. No preamble, no headings, no bullet lists.",
    "",
    isChair
      ? [
          "You chair this meeting. Open it by stating the question to be decided.",
          "Get the sharpest disagreement onto the table and resolved -- do not",
          "close while a serious objection is unanswered. When every objection has",
          "been answered, state the decision plainly and ask each attendee to post",
          "their section of the written outcome.",
        ].join(" ")
      : [
          "Speak only when you can add something from your own specialty that",
          "nobody has said. Respond to a specific person by name. If you have",
          "nothing to add, or would only be agreeing, say nothing at all --",
          "silence is the correct answer more often than not.",
        ].join(" "),
  ].join("\n");
}

/**
 * Create a meeting: a channel, one agent per persona, all of them members, and
 * an opening message from the chair.
 *
 * Partial failure is expected and tolerated. Agent creation can fail per-persona
 * (a bad runtime, a relay hiccup), and losing the whole meeting because the
 * fourth of five personas failed would be worse than running the meeting with
 * four. Failures are collected and returned so the caller can show them; the
 * channel is only abandoned if it cannot be created at all.
 */
export function useCreateMeeting() {
  const queryClient = useQueryClient();

  return React.useCallback(
    async ({
      attendees,
      chair,
      topic,
    }: CreateMeetingInput): Promise<CreateMeetingResult> => {
      const trimmedTopic = topic.trim();
      if (!trimmedTopic) {
        throw new Error("A meeting needs a topic.");
      }
      if (attendees.length < 2) {
        throw new Error(
          "A meeting needs at least two attendees — a chair and someone to talk to.",
        );
      }
      const effectiveChair = attendees.includes(chair)
        ? chair
        : (attendees.find((name) => name === DEFAULT_CHAIR) ?? attendees[0]);

      const channel = await createChannel({
        channelType: "stream",
        description: trimmedTopic,
        name: meetingChannelName(trimmedTopic),
        visibility: "private",
      });

      const failures: CreateMeetingResult["failures"] = [];
      const pubkeys: string[] = [];

      for (const name of attendees) {
        const persona = findPersona(name);
        if (!persona) {
          failures.push({ name, reason: "not found in personas.md" });
          continue;
        }
        try {
          const { agent } = await createManagedAgent({
            name,
            // "anyone" is the ambient mode: without it each persona would only
            // wake when @-mentioned, and they would never hear each other.
            respondTo: "anyone",
            spawnAfterCreate: true,
            systemPrompt: buildMeetingSystemPrompt({
              chair: effectiveChair,
              description: persona.description,
              name,
              roster: attendees,
              topic: trimmedTopic,
            }),
          });
          pubkeys.push(agent.pubkey);
        } catch (error) {
          failures.push({
            name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (pubkeys.length > 0) {
        await addChannelMembers({
          channelId: channel.id,
          pubkeys,
          role: "bot",
        });
      }

      await queryClient.invalidateQueries({ queryKey: ["channels"] });
      await queryClient.invalidateQueries({ queryKey: ["managedAgents"] });

      return { channel, failures };
    },
    [queryClient],
  );
}
