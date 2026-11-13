import { createServerFn } from "@tanstack/react-start";
import type { BacklinkObservation } from "./verify-api.server.ts";

export type VerifyFnResult =
  { ok: true; results: BacklinkObservation[] } | { ok: false; error: string };

/** Web UI wrapper around the same engine as `POST /v1/backlinks/verify` (≤50 pairs). */
export const verifyLinks = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async ({ data }): Promise<VerifyFnResult> => {
    const { verifyBacklinks } = await import("./verify-api.server.ts");
    try {
      const response = await verifyBacklinks(data, {
        allowRender: process.env.RANKPROOF_RENDER === "1",
      });
      return { ok: true, results: response.results };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

/** What this server can do beyond fetched HTML. Probes Chromium only when enabled. */
export const verifyCapabilities = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ render: boolean; engine: string | null; reason: string | null }> => {
    if (process.env.RANKPROOF_RENDER !== "1") {
      return { render: false, engine: null, reason: "disabled" };
    }
    const { renderAvailability } = await import("./render.server.ts");
    const available = await renderAvailability();
    return { render: available.ok, engine: available.engine, reason: available.reason };
  },
);

/**
 * The example set: bundled HTML run through the real extractor, offline. Two
 * runs a month apart so the change report has something to show.
 */
export const verifyExample = createServerFn({ method: "POST" }).handler(
  async (): Promise<{
    table: string;
    previous: BacklinkObservation[];
    results: BacklinkObservation[];
  }> => {
    const { exampleRuns } = await import("./verify-example.server.ts");
    return exampleRuns();
  },
);
