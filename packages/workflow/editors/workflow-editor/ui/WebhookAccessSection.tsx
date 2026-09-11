import {
  addDocument,
  useSelectedDriveId,
  useUser,
} from "@powerhousedao/reactor-browser";
import { useReactorGroupDocumentsInSelectedDrive } from "@powerhousedao/reactor-group/document-models/reactor-group";
import { useState } from "react";
import type { WebhookEndpoint } from "./forms.js";
import {
  danglingGroups,
  defaultGroupName,
  GROUP_DOCUMENT_TYPE,
  groupSummaries,
  memberCountLabel,
  orderGroups,
} from "./group-access.js";
import { GroupModal } from "./GroupModal.js";
import { AddressInput, IdentityRow, smallButtonClass } from "./IdentityRow.js";
import {
  addAddress,
  readWebhookAccess,
  removeAddress,
  sameAddress,
  toggleGroup,
  truncateAddress,
  withAllowed,
  withAuthMethod,
  withGroups,
  withoutInvalid,
  type WebhookAuthMethod,
} from "./webhook-access.js";

const METHODS: { value: WebhookAuthMethod; label: string; hint: string }[] = [
  {
    value: "path",
    label: "Endpoint URL",
    hint: "The token in the URL is the whole credential. Anyone holding the URL can deliver.",
  },
  {
    value: "renown",
    label: "Renown identity",
    hint: "The caller must present a Renown bearer token, and its signer must be allowed below.",
  },
];

const BLOCKERS: Record<string, string> = {
  NO_IDENTITY_RESOLUTION:
    "This reactor verifies no bearer token, so a Renown endpoint would refuse every delivery. Enable the reactor's auth, or its resolveIdentity option, then reload.",
  RENOWN_ROUTE_UNAVAILABLE:
    "This reactor is not serving the Renown endpoint, so there is no URL to give out. Check the server log for why the route failed to register.",
};

function SectionLabel(props: { children: React.ReactNode }) {
  return (
    <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
      {props.children}
    </span>
  );
}

function GroupRow(props: {
  name: string;
  detail: string;
  selected: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  warn?: boolean;
}) {
  return (
    <li
      className={`flex items-center gap-2 rounded border bg-white px-2 py-1.5 ${
        props.warn ? "border-amber-300" : "border-slate-200"
      }`}
    >
      <input
        type="checkbox"
        className="shrink-0"
        checked={props.selected}
        onChange={props.onToggle}
        aria-label={`Allow ${props.name}`}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-slate-700">
        {props.name}
      </span>
      <span className="shrink-0 text-[11px] text-slate-400">
        {props.detail}
      </span>
      {props.onEdit ? (
        <button
          type="button"
          className={smallButtonClass}
          onClick={props.onEdit}
        >
          Edit
        </button>
      ) : null}
    </li>
  );
}

/** The access half of a core#webhook trigger: how a delivery proves it is
 * allowed in, and — for Renown — which identities and groups are. */
export function WebhookAccessSection(props: {
  config: unknown;
  onChange: (config: unknown) => void;
  endpoint?: WebhookEndpoint;
}) {
  // Every write derives from the last one, not from the props of the render it
  // was clicked in: two quick removals must not resurrect the first identity.
  const [local, setLocal] = useState(props.config);
  const [seen, setSeen] = useState(props.config);
  if (props.config !== seen) {
    setSeen(props.config);
    setLocal(props.config);
  }
  const write = (next: unknown) => {
    setLocal(next);
    props.onChange(next);
  };

  const access = readWebhookAccess(local);
  const user = useUser();
  const driveId = useSelectedDriveId();
  const self = user?.address;
  const documents = useReactorGroupDocumentsInSelectedDrive();
  const [draftGroup, setDraftGroup] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const groups = documents ? groupSummaries(documents) : undefined;
  const dangling = groups ? danglingGroups(access.groups, groups) : [];
  const selfIsAllowed = access.allowed.some((entry) =>
    sameAddress(entry, self),
  );
  const active = METHODS.find((method) => method.value === access.method);
  const blocker =
    access.method === "renown" ? props.endpoint?.blocker : undefined;

  const createGroup = () => {
    if (!driveId || creating) return;
    setCreating(true);
    setCreateError(null);
    const name = defaultGroupName(groups ?? []);
    addDocument(driveId, name, GROUP_DOCUMENT_TYPE)
      .then((node) => setDraftGroup(node.id))
      .catch((error: unknown) => {
        setCreateError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setCreating(false));
  };

  return (
    <div>
      <SectionLabel>Access</SectionLabel>
      <div className="mt-1 inline-flex rounded border border-slate-300 p-0.5">
        {METHODS.map((method) => (
          <button
            key={method.value}
            type="button"
            aria-pressed={access.method === method.value}
            className={
              access.method === method.value
                ? "rounded-sm bg-slate-800 px-2.5 py-1 text-xs font-medium text-white"
                : "rounded-sm px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-800"
            }
            onClick={() => write(withAuthMethod(local, method.value))}
          >
            {method.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">{active?.hint}</p>

      {access.method === "renown" ? (
        <div className="mt-3 flex flex-col gap-2">
          {blocker ? (
            <p className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {BLOCKERS[blocker]}
            </p>
          ) : null}

          {access.invalid.length > 0 ? (
            <div className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
              <p>
                {access.invalid.length} entr
                {access.invalid.length === 1 ? "y is" : "ies are"} not a valid
                address, so this trigger will not accept any delivery at all:{" "}
                {access.invalid.join(", ")}
              </p>
              <button
                type="button"
                className="mt-1 rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700 hover:border-red-400"
                onClick={() => write(withoutInvalid(local))}
              >
                Remove them
              </button>
            </div>
          ) : null}

          <SectionLabel>Who can deliver</SectionLabel>

          {access.allowed.length === 0 && access.groups.length === 0 ? (
            <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
              Nobody can deliver to this endpoint yet. Every delivery is refused
              until an identity or a group is added below.
            </p>
          ) : null}

          {access.allowed.length > 0 ? (
            <ul className="flex list-none flex-col gap-1 p-0">
              {access.allowed.map((address) => (
                <IdentityRow
                  key={address}
                  address={address}
                  isSelf={sameAddress(address, self)}
                  onRemove={() =>
                    write(
                      withAllowed(
                        local,
                        removeAddress(access.allowed, address),
                      ),
                    )
                  }
                />
              ))}
            </ul>
          ) : null}

          <AddressInput
            existing={access.allowed}
            onAdd={(address) =>
              write(withAllowed(local, addAddress(access.allowed, address)))
            }
          />

          {self && !selfIsAllowed ? (
            <button
              type="button"
              className="self-start rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:border-slate-400"
              onClick={() =>
                write(withAllowed(local, addAddress(access.allowed, self)))
              }
            >
              Add yourself · {truncateAddress(self)}
            </button>
          ) : null}
          {!self ? (
            <p className="text-[11px] text-slate-400">
              You are not signed in to Renown, so your own address cannot be
              filled in for you.
            </p>
          ) : null}

          <div className="mt-2 flex items-baseline justify-between">
            <SectionLabel>Groups</SectionLabel>
            {driveId ? (
              <button
                type="button"
                className="text-[11px] font-medium text-slate-500 hover:text-slate-700 disabled:text-slate-300"
                disabled={creating}
                onClick={createGroup}
              >
                {creating ? "Creating…" : "+ New group"}
              </button>
            ) : null}
          </div>

          {groups === undefined ? (
            <p className="text-xs text-slate-400">Loading groups…</p>
          ) : null}
          {groups?.length === 0 && dangling.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              No groups in this drive yet. A group keeps one member list that
              every workflow referencing it reads at delivery time.
            </p>
          ) : null}
          {groups && (groups.length > 0 || dangling.length > 0) ? (
            <ul className="flex list-none flex-col gap-1 p-0">
              {orderGroups(groups, access.groups).map((group) => (
                <GroupRow
                  key={group.id}
                  name={group.name}
                  detail={memberCountLabel(group.members.length)}
                  selected={access.groups.includes(group.id)}
                  onToggle={() =>
                    write(
                      withGroups(local, toggleGroup(access.groups, group.id)),
                    )
                  }
                  onEdit={() => setEditingGroup(group.id)}
                />
              ))}
              {dangling.map((id) => (
                <GroupRow
                  key={id}
                  warn
                  name={`${truncateAddress(id)} · unavailable`}
                  detail="deleted, or not yours to read"
                  selected
                  onToggle={() =>
                    write(withGroups(local, toggleGroup(access.groups, id)))
                  }
                />
              ))}
            </ul>
          ) : null}
          {createError ? (
            <p className="text-[11px] text-red-500">{createError}</p>
          ) : null}

          <p className="text-[11px] text-slate-400">
            Powerhouse has no identity directory yet, so an individual is added
            by address rather than looked up by name.
          </p>
          <p className="text-[11px] text-slate-400">
            This list travels with the workflow document: anyone who can edit
            the workflow can widen it.
          </p>
        </div>
      ) : null}

      {draftGroup ? (
        <GroupModal
          groupId={draftGroup}
          initialName={defaultGroupName(groups ?? [])}
          confirmLabel="Use this group"
          onDone={(groupId) => {
            setDraftGroup(null);
            // Creating one from here is how the author said they want it: not
            // adding it would make them find it in the list they just left.
            if (groupId) {
              write(withGroups(local, toggleGroup(access.groups, groupId)));
            }
          }}
        />
      ) : null}
      {editingGroup ? (
        <GroupModal
          groupId={editingGroup}
          confirmLabel="Done"
          onDone={() => setEditingGroup(null)}
        />
      ) : null}
    </div>
  );
}
