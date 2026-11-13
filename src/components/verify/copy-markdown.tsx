import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyMarkdown({ text }: { text: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text())
          .then(() => setState("copied"))
          .catch(() => setState("failed"))
          .finally(() => setTimeout(() => setState("idle"), 2000));
      }}
      aria-live="polite"
    >
      {state === "copied" ? <Check /> : <ClipboardCopy />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy as Markdown"}
    </Button>
  );
}
