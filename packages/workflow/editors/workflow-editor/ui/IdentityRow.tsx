// The identity primitives the allow-list and the group modal both draw with.
import { useState } from "react";
import {
  addressMark,
  checkAddress,
  truncateAddress,
} from "./webhook-access.js";

export const identityInputClass =
  "w-full rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-800";
export const identityInvalidClass = "border-red-400";
export const smallButtonClass =
  "shrink-0 rounded border border-slate-300 px-2 text-xs text-slate-600 hover:border-slate-400";

/** A deterministic mark for an address, so two truncated addresses read apart
 * at a glance. Derived from the address itself; it claims to be nothing else. */
export function AddressMark(props: { address: string }) {
  const { cells, hue } = addressMark(props.address);
  return (
    <svg
      aria-hidden
      viewBox="0 0 5 5"
      className="h-5 w-5 shrink-0 rounded-sm"
      style={{ background: `hsl(${hue} 45% 93%)` }}
    >
      {cells.map((filled, index) =>
        filled ? (
          <rect
            key={index}
            x={index % 5}
            y={Math.floor(index / 5)}
            width={1}
            height={1}
            fill={`hsl(${hue} 55% 48%)`}
          />
        ) : null,
      )}
    </svg>
  );
}

export function IdentityRow(props: {
  address: string;
  isSelf?: boolean;
  /** Omitted where the reader cannot edit the list; the row still copies. */
  onRemove?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5">
      <AddressMark address={props.address} />
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700"
        title={props.address}
      >
        {truncateAddress(props.address)}
      </span>
      {props.isSelf ? (
        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
          You
        </span>
      ) : null}
      <button
        type="button"
        className={smallButtonClass}
        title="Copy the full address"
        onClick={() => {
          navigator.clipboard.writeText(props.address).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {props.onRemove ? (
        <button
          type="button"
          className="shrink-0 rounded border border-slate-300 px-2 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
          title="Revoke this identity's access"
          onClick={props.onRemove}
        >
          Remove
        </button>
      ) : null}
    </li>
  );
}

/** Paste-an-address, with the reason it cannot be added shown under it. There
 * is no directory to search, so the message has to name the one thing to fix. */
export function AddressInput(props: {
  existing: readonly string[];
  onAdd: (address: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = (value: string) => {
    const checked = checkAddress(value, props.existing);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setDraft("");
    props.onAdd(checked.address);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        <input
          className={`${identityInputClass} font-mono text-[11px] ${error ? identityInvalidClass : ""}`}
          placeholder={props.placeholder ?? "0x… paste a wallet address"}
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add(draft);
          }}
        />
        <button
          type="button"
          className="shrink-0 rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:bg-slate-300"
          disabled={draft.trim() === ""}
          onClick={() => add(draft)}
        >
          Add
        </button>
      </div>
      {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
    </div>
  );
}
