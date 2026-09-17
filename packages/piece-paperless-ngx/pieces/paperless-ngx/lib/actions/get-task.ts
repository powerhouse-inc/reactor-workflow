import { createAction, Property } from "@powerhousedao/pieces-framework";
import { paperlessAuth } from "../auth";
import { clientForContext } from "../common/context";
import { readTask } from "../common/tasks";
import { getTaskOutputFields } from "../common/output-schemas";

export const getTask = createAction({
  auth: paperlessAuth,
  name: "get_task",
  displayName: "Get task",
  description:
    "Reads a consumption task by its UUID — the value an upload returns before the document exists.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: { fields: getTaskOutputFields },
  props: {
    task_id: Property.ShortText({
      displayName: "Task UUID",
      required: true,
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    const task = await readTask(client, context.propsValue.task_id);
    if (!task) {
      return { task_id: context.propsValue.task_id, status: "unknown" };
    }
    return task;
  },
});
