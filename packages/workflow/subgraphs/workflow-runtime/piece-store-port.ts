// Adapts the run journal's `piece_store` table to the engine's PieceStorePort,
// so an action's `ctx.store` is durable the moment the piece writes it.

// Which workflow a step belongs to travels on the run scope, not the executor,
// which concurrent runs share.
import type {
  PieceStorePort,
  StoreScopeName,
} from "@powerhousedao/reactor-connectors";
import type { WorkflowRunStore } from "./store.js";

// PROJECT means "shared by every workflow in the project", and this reactor is
// that project: the trigger registry, the run journal and the secret store are
// all already instance-wide, so nothing new is shared by saying so.

// When a real tenancy model arrives this constant becomes its default project
// id, and the migration is one UPDATE. See issue #16.
export const PROJECT_SCOPE_KEY = "reactor";

// Appended to both partition keys for a design-time sample, so a test run
// cannot alias a live key however the piece happens to name it.

// The supervisor drops these partitions when the sample returns; a key prefix
// could do neither, since prefixes alias and nothing enumerates them.
const TEST_PARTITION_SUFFIX = "#test";

// A sample partitions by workflow in *both* scopes, unlike a live run: two
// samples on one project partition would read and then delete each other's.
export function testPartitionKey(
  scope: StoreScopeName,
  workflowId: string,
): string {
  const base =
    scope === "PROJECT" ? `${PROJECT_SCOPE_KEY}#${workflowId}` : workflowId;
  return base + TEST_PARTITION_SUFFIX;
}

export function createPieceStorePort(
  store: WorkflowRunStore,
  workflowIdFor: () => string | undefined,
  sample = false,
): PieceStorePort {
  // A step with no workflow in scope must fail rather than read or write
  // another workflow's keys.
  const flowKey = () => {
    const workflowId = workflowIdFor();
    if (!workflowId) {
      throw new Error("ctx.store is unavailable: no workflow is in scope");
    }
    return workflowId;
  };

  const partition = (scope: StoreScopeName): string =>
    sample
      ? testPartitionKey(scope, flowKey())
      : scope === "PROJECT"
        ? PROJECT_SCOPE_KEY
        : flowKey();

  // Async so that a missing run scope rejects rather than throwing out of a
  // method whose contract is a promise.
  return {
    get: async (key, scope) =>
      store.getPieceStoreValue(scope, partition(scope), key),
    put: async (key, value, scope) =>
      store.setPieceStoreValue(scope, partition(scope), key, value),
    delete: async (key, scope) =>
      store.deletePieceStoreValue(scope, partition(scope), key),
  };
}
