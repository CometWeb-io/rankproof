import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { VerifyPage } from "@/components/verify/verify-page";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <AppShell
      footer={
        <p>
          A result describes the HTML RankProof fetched at that moment. It is not a ranking signal
          and not proof of what every visitor sees. Read the{" "}
          <a
            className="text-fg-soft underline decoration-fg-soft/50 underline-offset-2 hover:text-fg hover:decoration-fg"
            href="https://github.com/CometWeb-io/rankproof/blob/main/docs/api.md"
          >
            verification rules
          </a>
          .
        </p>
      }
    >
      <VerifyPage />
    </AppShell>
  );
}
