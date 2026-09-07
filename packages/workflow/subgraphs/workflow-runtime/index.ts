import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import { getResolvers } from "./resolvers.js";
import { schema } from "./schema.js";
import { workflowRuntime } from "./service.js";

export class WorkflowRuntimeSubgraph extends BaseSubgraph {
  name = "workflow-runtime";
  typeDefs: DocumentNode = schema;
  resolvers = getResolvers(this);
  additionalContextFields = {};

  // The webhook endpoint is HTTP, not GraphQL, so it is mounted here rather
  // than served by a resolver; see webhook-router for how the handle is found.
  onSetup() {
    workflowRuntime.mountWebhookEndpoint(this);
    return Promise.resolve();
  }

  async onDisconnect() {}
}
