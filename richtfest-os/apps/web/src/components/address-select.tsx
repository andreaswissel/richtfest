import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  formatProjectAddress,
  type AddressReference,
  type AddressSuggestion,
  type AddressSuggestions,
  type ProjectAddress,
} from "@richtfest/shared";
import { api } from "../api";
import { useT } from "../i18n";
import { usePreferences } from "../store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge, Callout, Field } from "./ui/primitives";

type AddressValue = ProjectAddress & {
  addressReference?: AddressReference | null;
};
const emptyAddress: AddressValue = {
  street: null,
  postalCode: null,
  city: null,
  country: null,
  addressReference: null,
};

/** Form-compatible address selection; drafts never replace saved values implicitly. */
export function AddressSelect({
  defaultValue,
  disabled,
}: {
  defaultValue: AddressValue;
  disabled?: boolean;
}) {
  const t = useT(),
    language = usePreferences((s) => s.language),
    listId = useId();
  const [address, setAddress] = useState<AddressValue>(defaultValue);
  const [text, setText] = useState(formatProjectAddress(defaultValue));
  const [debounced, setDebounced] = useState("");
  const [manual, setManual] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const unresolved = !manual && text !== formatProjectAddress(address);
  const readiness = useQuery({
    queryKey: ["/projects/address-suggestions"],
    queryFn: () => api<AddressSuggestions>("/projects/address-suggestions"),
    staleTime: 60_000,
    retry: false,
    meta: { persist: false },
  });
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const search = useQuery({
    queryKey: ["/projects/address-suggestions", debounced, language],
    queryFn: () =>
      api<AddressSuggestions>(
        `/projects/address-suggestions?q=${encodeURIComponent(debounced)}&language=${language}`,
      ),
    enabled:
      open &&
      !manual &&
      readiness.data?.configured === true &&
      debounced.length >= 3 &&
      debounced === text.trim(),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    meta: { persist: false },
  });
  const suggestions =
    debounced === text.trim() ? (search.data?.suggestions ?? []) : [];
  const expanded =
    open &&
    !manual &&
    !disabled &&
    readiness.data?.configured === true &&
    text.trim().length >= 3;
  useEffect(() => {
    input.current?.setCustomValidity(
      unresolved ? t("addressSelectRequired") : "",
    );
  }, [unresolved, language]);
  useEffect(() => {
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);
  const choose = (value: AddressValue) => {
    setAddress(value);
    setText(formatProjectAddress(value));
    setOpen(false);
    setActive(-1);
  };
  const selected = address.addressReference;

  return (
    <fieldset className="grid gap-stack min-w-0" disabled={disabled}>
      {(["street", "postalCode", "city", "country"] as const).map((name) => (
        <input
          key={name}
          type="hidden"
          name={name}
          value={address[name] ?? ""}
        />
      ))}
      <input
        type="hidden"
        name="addressReference"
        value={JSON.stringify(selected ?? null)}
      />
      {!manual && (
        <div
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setOpen(false);
          }}
        >
          <Field
            label={t("address")}
            hint={unresolved ? t("addressSelectRequired") : undefined}
          >
            <Input
              ref={input}
              role="combobox"
              autoComplete="off"
              maxLength={200}
              aria-autocomplete="list"
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              aria-activedescendant={
                expanded && suggestions[active]
                  ? `${listId}-${active}`
                  : undefined
              }
              value={text}
              placeholder={t("addressSearchPlaceholder")}
              onFocus={() => setOpen(true)}
              onChange={(event) => {
                setText(event.target.value);
                setOpen(true);
                setActive(-1);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  setActive(-1);
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setOpen(true);
                  setActive((index) =>
                    suggestions.length
                      ? index < 0
                        ? event.key === "ArrowDown"
                          ? 0
                          : suggestions.length - 1
                        : (index +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            suggestions.length) %
                          suggestions.length
                      : -1,
                  );
                }
                if (event.key === "Enter" && (expanded || unresolved)) {
                  event.preventDefault();
                  if (expanded && suggestions[active])
                    choose(suggestions[active]);
                  else input.current?.reportValidity();
                }
              }}
            />
          </Field>
          {expanded && (
            <div className="absolute z-30 mt-1 w-full rounded-lg border bg-popover text-popover-foreground shadow-md">
              <div
                id={listId}
                role="listbox"
                aria-label={t("addressSuggestions")}
                className="max-h-64 overflow-y-auto p-1"
              >
                {suggestions.map((suggestion: AddressSuggestion, index) => (
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    key={suggestion.addressReference.placeId}
                    id={`${listId}-${index}`}
                    aria-selected={index === active}
                    className={`w-full rounded-md px-2 py-cell text-left text-ui hover:bg-muted ${index === active ? "bg-muted" : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(suggestion)}
                  >
                    <span className="block">{suggestion.street}</span>
                    <span className="block text-ui-sm text-muted-foreground">
                      {[
                        suggestion.postalCode,
                        suggestion.city,
                        suggestion.country,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                ))}
              </div>
              {!suggestions.length && (
                <div
                  role="status"
                  className="px-3 py-cell text-ui-sm text-muted-foreground"
                >
                  {search.isError
                    ? t("addressSearchFailed")
                    : debounced !== text.trim() || search.isFetching
                      ? t("addressSearching")
                      : t("addressNoResults")}
                </div>
              )}
              <div className="border-t p-1">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    setManual(true);
                    setText(formatProjectAddress(address));
                    setOpen(false);
                  }}
                >
                  {t("addressEnterManually")}
                </Button>
              </div>
              <div className="border-t px-3 py-cell text-ui-xs text-muted-foreground">
                <a
                  href="https://www.geoapify.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Powered by Geoapify
                </a>{" "}
                ·{" "}
                <a
                  href="https://www.openstreetmap.org/copyright"
                  target="_blank"
                  rel="noreferrer"
                >
                  © OpenStreetMap contributors
                </a>
              </div>
            </div>
          )}
        </div>
      )}
      {!manual && readiness.data?.configured === false && (
        <Callout>{t("addressSearchUnconfigured")}</Callout>
      )}
      {!manual && readiness.isError && (
        <Callout tone="error">{t("addressSearchFailed")}</Callout>
      )}
      {manual && (
        <>
          <legend className="text-ui-sm">{t("address")}</legend>
          <div className="grid gap-stack sm:grid-cols-2">
            {(
              [
                ["street", "projectStreet", 300],
                ["postalCode", "customerPostalCode", 32],
                ["city", "customerCity", 200],
                ["country", "customerCountry", 100],
              ] as const
            ).map(([name, label, maxLength]) => (
              <Field key={name} label={t(label)}>
                <Input
                  value={address[name] ?? ""}
                  maxLength={maxLength}
                  onChange={(event) => {
                    const value = {
                      ...address,
                      [name]: event.target.value,
                      addressReference: null,
                    };
                    setAddress(value);
                    setText(formatProjectAddress(value));
                  }}
                />
              </Field>
            ))}
          </div>
        </>
      )}
      {formatProjectAddress(address) && (
        <div className="flex flex-wrap items-center gap-2 text-ui-sm">
          <Badge>
            {selected ? t("addressSelected") : t("addressUnverified")}
          </Badge>
          {!manual && <span>{formatProjectAddress(address)}</span>}
        </div>
      )}
      {selected && (
        <p className="text-ui-xs text-muted-foreground">
          <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">
            {selected.attribution}
          </a>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setManual(!manual);
            setText(formatProjectAddress(address));
            setOpen(false);
          }}
        >
          {t(manual ? "addressSearchInstead" : "addressEnterManually")}
        </Button>
        {(formatProjectAddress(address) || text) && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => choose(emptyAddress)}
          >
            {t("addressClear")}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
