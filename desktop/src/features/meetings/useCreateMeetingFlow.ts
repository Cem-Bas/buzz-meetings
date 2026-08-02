import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useCreateMeeting } from "@/features/meetings/useCreateMeeting";

/**
 * Dialog state and submit handling for creating a meeting.
 *
 * Owned next to the button that opens it rather than in ChannelScreen, so the
 * feature adds no lines to the large screen/pane files.
 */
export function useCreateMeetingFlow() {
  const { goChannel } = useAppNavigation();
  const createMeeting = useCreateMeeting();
  const [open, setOpen] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const openDialog = React.useCallback(() => {
    setError(null);
    setOpen(true);
  }, []);

  const create = React.useCallback(
    async (input: { topic: string; attendees: string[]; chair: string }) => {
      setIsCreating(true);
      setError(null);
      try {
        const { channel, failures } = await createMeeting(input);
        // Partial failure still produced a usable meeting; name the personas
        // that failed instead of silently seating fewer agents.
        if (failures.length > 0) {
          setError(
            `Created, but these attendees failed: ${failures
              .map((failure) => `${failure.name} (${failure.reason})`)
              .join(", ")}`,
          );
        } else {
          setOpen(false);
        }
        goChannel(channel.id);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setIsCreating(false);
      }
    },
    [createMeeting, goChannel],
  );

  return { create, error, isCreating, open, openDialog, setOpen };
}
