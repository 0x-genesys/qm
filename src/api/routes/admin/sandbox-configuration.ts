import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";

export async function getSandboxConfiguration(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.sandboxConfiguration) return sendJson(ctx.res, 503, { error: "unavailable" });
  const value = await ctx.deps.sandboxConfiguration.read();
  audit(ctx.deps, {
    principalId: actor.id,
    action: "sandbox-configuration.read",
    resource: "sandbox-configuration",
    scopeLabel: scope,
  });
  return sendJson(ctx.res, 200, value);
}
