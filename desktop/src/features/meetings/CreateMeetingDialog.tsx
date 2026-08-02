import * as React from "react";
import { Users } from "lucide-react";

import {
  DEFAULT_CHAIR,
  DEFAULT_PANEL,
  PERSONAS,
} from "@/features/meetings/personas";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

type CreateMeetingDialogProps = {
  open: boolean;
  isCreating: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    topic: string;
    attendees: string[];
    chair: string;
  }) => void;
};

/**
 * Collects a meeting topic and its attendees.
 *
 * The chair is whoever is selected and listed first in personas.md, defaulting
 * to the Architect — rather than a separate control, because a chair picker is
 * one more decision for something that is right by default almost every time.
 */
export function CreateMeetingDialog({
  error,
  isCreating,
  onCreate,
  onOpenChange,
  open,
}: CreateMeetingDialogProps) {
  const [topic, setTopic] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([...DEFAULT_PANEL]);

  // Reset when the dialog is dismissed so a cancelled meeting does not leak
  // its topic into the next one.
  React.useEffect(() => {
    if (!open) {
      setTopic("");
      setSelected([...DEFAULT_PANEL]);
    }
  }, [open]);

  const chair = React.useMemo(() => {
    if (selected.includes(DEFAULT_CHAIR)) {
      return DEFAULT_CHAIR;
    }
    return (
      PERSONAS.find((persona) => selected.includes(persona.name))?.name ?? ""
    );
  }, [selected]);

  const canCreate =
    topic.trim().length > 0 && selected.length >= 2 && !isCreating;

  const toggle = (name: string) => {
    setSelected((current) =>
      current.includes(name)
        ? current.filter((entry) => entry !== name)
        : [...current, name],
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a meeting</DialogTitle>
          <DialogDescription>
            Creates a channel, adds an agent for each attendee, and opens the
            discussion. Agents in a meeting hear every message, not just the
            ones that mention them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="meeting-topic">
              Topic
            </label>
            <input
              autoFocus
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="meeting-topic-input"
              disabled={isCreating}
              id="meeting-topic"
              onChange={(event) => setTopic(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canCreate) {
                  onCreate({ attendees: selected, chair, topic });
                }
              }}
              placeholder="Should we drop the mention gate?"
              value={topic}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">Who attends</span>
              <span className="text-2xs text-muted-foreground">
                {selected.length} selected
                {chair ? ` · ${chair} chairs` : ""}
              </span>
            </div>
            <div className="grid max-h-64 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-border p-2">
              {PERSONAS.map((persona) => {
                const checked = selected.includes(persona.name);
                return (
                  <label
                    className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-left hover:bg-accent"
                    key={persona.name}
                    title={persona.description}
                  >
                    <input
                      checked={checked}
                      className="mt-0.5"
                      data-testid={`meeting-persona-${persona.name}`}
                      disabled={isCreating}
                      onChange={() => toggle(persona.name)}
                      type="checkbox"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-foreground">
                        {persona.name}
                        {persona.name === chair ? (
                          <span className="ml-1 text-2xs text-muted-foreground">
                            (chair)
                          </span>
                        ) : null}
                      </span>
                      <span className="line-clamp-2 block text-2xs text-muted-foreground">
                        {persona.description.split(".")[0]}.
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {selected.length < 2 ? (
              <p className="text-2xs text-muted-foreground">
                Pick at least two — a chair and someone to talk to.
              </p>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            disabled={isCreating}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            data-testid="meeting-create-submit"
            disabled={!canCreate}
            onClick={() => onCreate({ attendees: selected, chair, topic })}
            type="button"
          >
            <Users className="mr-2 h-4 w-4" />
            {isCreating ? "Creating…" : "Create meeting"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
