import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "@/components/audit-page";

export const Route = createFileRoute("/audit")({
  head: () => ({ meta: [{ title: "Domain audit · RankProof" }] }),
  component: AuditPage,
});
