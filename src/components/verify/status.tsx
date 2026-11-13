import { cn } from "@/lib/utils";
import { VERDICT_LABELS, type ContractVerdict } from "@/lib/backlinks/observe";
import { VERDICT_TONE } from "./status-tone";

export function StatusDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("rp-dot", className)} />;
}

/** The result of one pair as a chip: coloured dot, label in the same tone. */
export function VerdictChip({
  verdict,
  className,
}: {
  verdict: ContractVerdict;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-2 rounded-full border border-current/25 bg-current/8 px-2.5 text-[13px] font-semibold whitespace-nowrap",
        VERDICT_TONE[verdict],
        className,
      )}
    >
      <StatusDot />
      {VERDICT_LABELS[verdict]}
    </span>
  );
}
