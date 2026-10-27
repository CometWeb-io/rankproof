export type TenantPrincipal = {
  subject: string;
  tenantId: string;
  projectIds: readonly string[];
  role: "reader" | "worker" | "operator";
};

export type TenantScope = Readonly<{
  subject: string;
  tenantId: string;
  projectId: string;
  role: TenantPrincipal["role"];
}>;

const issued = new WeakSet<object>();
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export function requirePlatformId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new Error("Invalid platform id.");
}

/** Call only after authenticating the principal; never build it from request body claims. */
export function createTenantScope(
  principal: TenantPrincipal | null,
  projectId: string,
): TenantScope {
  if (!principal || !["reader", "worker", "operator"].includes(principal.role)) {
    throw new Error("Tenant access denied.");
  }
  requirePlatformId(principal.subject);
  requirePlatformId(principal.tenantId);
  requirePlatformId(projectId);
  if (!Array.isArray(principal.projectIds) || !principal.projectIds.includes(projectId)) {
    throw new Error("Tenant access denied.");
  }
  const scope = Object.freeze({
    subject: principal.subject,
    tenantId: principal.tenantId,
    projectId,
    role: principal.role,
  });
  issued.add(scope);
  return scope;
}

export function assertTenantScope(
  scope: TenantScope,
  permission: "read" | "work" | "manage" = "read",
): void {
  if (
    !scope ||
    !issued.has(scope) ||
    (permission === "manage" && scope.role !== "operator") ||
    (permission === "work" && scope.role === "reader")
  ) {
    throw new Error("Tenant access denied.");
  }
}
