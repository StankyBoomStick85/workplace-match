"use client";

import { useMemo, useState, type FocusEvent } from "react";
import { normalizeStateValue, stateAbbreviations } from "../lib/addressHelpers";

type StateAbbreviationSelectProps = {
  id?: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  required?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
};

export function StateAbbreviationSelect({
  id,
  name,
  value,
  onChange,
  className = "field uppercase",
  required = false,
  readOnly = false,
  disabled = false
}: StateAbbreviationSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasTypedThisFocus, setHasTypedThisFocus] = useState(false);
  const normalizedValue = normalizeStateValue(value);
  const options = useMemo(() => {
    return hasTypedThisFocus && normalizedValue
      ? stateAbbreviations.filter((state) => state.startsWith(normalizedValue))
      : stateAbbreviations;
  }, [hasTypedThisFocus, normalizedValue]);

  function closeWhenFocusLeaves(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsOpen(false);
    }
  }

  return (
    <div className="relative" onBlur={closeWhenFocusLeaves}>
      <input
        id={id}
        name={name}
        value={normalizedValue}
        onChange={(event) => {
          onChange(normalizeStateValue(event.target.value));
          setHasTypedThisFocus(true);
          setIsOpen(true);
        }}
        onFocus={() => {
          if (!readOnly && !disabled) {
            setHasTypedThisFocus(false);
            setIsOpen(true);
          }
        }}
        required={required}
        readOnly={readOnly}
        disabled={disabled}
        maxLength={2}
        pattern="[A-Za-z]{2}"
        autoComplete="off"
        className={className}
      />
      {isOpen && !readOnly && !disabled ? (
        <div className="absolute left-0 top-full z-[1300] mt-1 max-h-80 min-w-20 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-soft">
          {options.length > 0 ? (
            options.map((state) => (
              <button
                key={state}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(state);
                  setIsOpen(false);
                }}
                className="flex h-8 w-full items-center px-3 text-left text-sm font-semibold text-zinc-800 transition hover:bg-gray-50"
              >
                {state}
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-sm text-zinc-500">No match</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
