// Creating and editing a powerhouse/reactor-group document without leaving the
// trigger panel, the way CreateConnectionModal does for a connection.
import { Modal } from "@powerhousedao/design-system";
import {
  actions,
  useReactorGroupDocumentById,
} from "@powerhousedao/reactor-group/document-models/reactor-group";
import { useUser } from "@powerhousedao/reactor-browser";
import { useEffect, useState } from "react";
import { groupSummaryFrom, memberCountLabel } from "./group-access.js";
import { AddressInput, IdentityRow } from "./IdentityRow.js";
import { sameAddress } from "./webhook-access.js";

export function GroupModal(props: {
  groupId: string;
  /** Set on a group this modal just created, applied once. */
  initialName?: string;
  /** "Use this group" on a create; plain "Done" when editing an existing one. */
  confirmLabel: string;
  onDone: (groupId: string | null) => void;
}) {
  const [document, dispatch] = useReactorGroupDocumentById(props.groupId);
  const [named, setNamed] = useState(false);
  const user = useUser();
  const summary = groupSummaryFrom(document);

  // Prefilled once, exactly as typing the name by hand would: the author asked
  // for a group, not for a document called "Untitled".
  useEffect(() => {
    if (!dispatch || named || !props.initialName || summary === undefined) {
      return;
    }
    setNamed(true);
    dispatch(actions.setGroupName({ name: props.initialName }));
    dispatch(actions.setName(props.initialName));
  }, [dispatch, named, props.initialName, summary]);

  const members = summary?.members ?? [];

  return (
    <Modal
      open
      title="Group"
      onOpenChange={(open) => {
        // Dismissing is not choosing: only the button below reports the id, so
        // closing a group just created never adds it to the allow-list.
        if (!open) props.onDone(null);
      }}
      contentProps={{
        className: "max-h-[85vh] w-[36rem] max-w-[92vw] overflow-y-auto",
      }}
    >
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <input
            key={summary?.name}
            className="min-w-0 flex-1 rounded border border-transparent px-1 py-0.5 text-sm font-semibold text-slate-800 hover:border-slate-200 focus:border-slate-300 focus:outline-none"
            defaultValue={summary?.name ?? props.initialName ?? ""}
            placeholder="Untitled group"
            spellCheck={false}
            aria-label="Group name"
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (!dispatch || name === "" || name === summary?.name) return;
              dispatch(actions.setGroupName({ name }));
              dispatch(actions.setName(name));
            }}
          />
          <button
            type="button"
            className="shrink-0 rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white"
            onClick={() => props.onDone(props.groupId)}
          >
            {props.confirmLabel}
          </button>
        </div>

        {summary === undefined ? (
          <p className="text-xs text-slate-400">Loading the group document…</p>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              Members
              <span className="text-[11px] font-normal normal-case tracking-normal text-slate-400">
                {memberCountLabel(members.length)}
              </span>
            </span>

            {members.length === 0 ? (
              <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
                This group has no members yet, so it grants nobody access
                wherever it is used.
              </p>
            ) : (
              <ul className="flex list-none flex-col gap-1 p-0">
                {members.map((address) => (
                  <IdentityRow
                    key={address}
                    address={address}
                    isSelf={sameAddress(address, user?.address)}
                    onRemove={
                      dispatch
                        ? () => dispatch(actions.removeMember({ address }))
                        : undefined
                    }
                  />
                ))}
              </ul>
            )}

            {dispatch ? (
              <AddressInput
                existing={members}
                onAdd={(address) => dispatch(actions.addMember({ address }))}
              />
            ) : null}

            {dispatch &&
            user?.address &&
            !members.some((entry) => sameAddress(entry, user.address)) ? (
              <button
                type="button"
                className="self-start rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:border-slate-400"
                onClick={() =>
                  dispatch(actions.addMember({ address: user.address }))
                }
              >
                Add yourself
              </button>
            ) : null}

            <p className="text-[11px] text-slate-400">
              Membership is read when a delivery arrives, so this list takes
              effect everywhere the group is used without re-saving anything.
            </p>
            {dispatch === undefined ? (
              <p className="text-[11px] text-red-500">
                This group is read-only for you, so its members cannot be
                changed here.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}
