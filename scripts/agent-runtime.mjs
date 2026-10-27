import { existsSync } from "node:fs";

/** Installed packages load compiled JS; source checkouts require Node's strip flag. */
export function loadAgentModule(name) {
  const source = new URL(`../src/lib/backlinks/${name}.ts`, import.meta.url);
  return import(
    existsSync(source) ? source.href : new URL(`../dist/${name}.js`, import.meta.url).href
  );
}

/** Persistence is operator configuration; request bodies never select paths or tenant principals. */
export async function configuredObservationStore() {
  const path = process.env.RANKPROOF_AGENT_HISTORY_DB?.trim();
  if (!path) return undefined;
  const { createTenantScope } = await loadAgentModule("tenant-scope");
  const { createPersistentObservationStore } = await loadAgentModule("agent-history.server");
  const scope = createTenantScope(
    {
      subject: "agent-service",
      tenantId: "local-operator",
      projectIds: ["agent-history"],
      role: "operator",
    },
    "agent-history",
  );
  return createPersistentObservationStore(path, scope);
}
