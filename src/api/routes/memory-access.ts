import { disclosedMemory } from "../../memory/disclosure.ts";
import type { MemoryService } from "../../memory/memory-service.ts";
import { personalScope, type Principal } from "../../types.ts";
import type { ApiCtx } from "./route.ts";

export function memoryForRequest(ctx: ApiCtx, sourcePrincipal?: string): MemoryService | undefined {
  if (!ctx.deps.memory) return undefined;
  const id = ctx.actor?.p ?? sourcePrincipal;
  if (!id) return undefined;
  const actor: Principal = ctx.deps.identity?.classify(id) ?? { id, type: "internal" };
  const targetScope = personalScope(id);
  return disclosedMemory(ctx.deps.memory, {
    actor,
    targetScope,
    nativeScopes: [targetScope],
    audience: [actor],
    open: true,
    config: ctx.deps.config,
    isCurrentSharedScopeMember: (person, scope) => ctx.app.isCurrentSharedScopeMember(person, scope),
    currentScopeMembers: (scope) => ctx.app.currentScopeMembers(scope),
  });
}
