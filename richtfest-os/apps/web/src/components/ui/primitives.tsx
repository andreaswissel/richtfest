import {
  useState,
  useId,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type FormEvent,
} from "react";
import { Button } from "./button";
import { Label } from "./label";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "./dialog";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import {
  Table as TableRoot,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./table";
export { Badge } from "./badge";
import { Link } from "react-router-dom";
import { useT } from "../../i18n";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronsUpDown,
  Info,
  X,
} from "lucide-react";
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <Label htmlFor={id} id={`${id}-label`}>
        {label}
      </Label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            id,
            "aria-labelledby": `${id}-label`,
            "aria-describedby": hint ? `${id}-hint` : undefined,
          })
        : children}
      {hint && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
    </div>
  );
}
export function Callout({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div
      className={`callout ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="callout-mark">
        {tone === "error" ? <AlertCircle size={13} /> : <Info size={13} />}
      </span>
      <div>{children}</div>
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <p>{children}</p>
    </div>
  );
}
export function Segmented({
  items,
  value,
  onChange,
  ...props
}: {
  items: { value: string; label: string; disabled?: boolean }[];
  value: string;
  onChange: (v: string) => void;
  id?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      className="segmented"
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v);
      }}
      {...props}
    >
      {items.map((i) => (
        <ToggleGroupItem value={i.value} key={i.value} aria-label={i.label} disabled={i.disabled}>
          {i.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
export function RowLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="row-link" to={to}>
      {children}
      <ArrowUpRight aria-hidden="true" size={15} />
    </Link>
  );
}
export const linkedRow = { className: "linked-row" };
export function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: { id: string; cells: ReactNode[]; sort?: string[] }[];
}) {
  const [sort, setSort] = useState<{ col: number; direction: number } | null>(
    null,
  );
  const ordered = sort
    ? [...rows].sort(
        (a, b) =>
          (a.sort?.[sort.col] ?? String(a.cells[sort.col])).localeCompare(
            b.sort?.[sort.col] ?? String(b.cells[sort.col]),
            undefined,
            { numeric: true },
          ) * sort.direction,
      )
    : rows;
  return (
    <TableRoot className="data-table">
      <TableHeader>
        <TableRow>
          {headers.map((h, col) => (
            <TableHead
              key={h}
              aria-sort={
                sort?.col === col
                  ? sort.direction === 1
                    ? "ascending"
                    : "descending"
                  : "none"
              }
            >
              <button
                type="button"
                className="table-sort-button"
                onClick={() =>
                  setSort(
                    sort?.col === col
                      ? sort.direction === 1
                        ? { col, direction: -1 }
                        : null
                      : { col, direction: 1 },
                  )
                }
              >
                <span>{h}</span>
                <span className="table-sort-icon" aria-hidden="true">
                  {sort?.col === col ? (
                    sort.direction === 1 ? <ArrowUp className="size-icon-sm" /> : <ArrowDown className="size-icon-sm" />
                  ) : <ChevronsUpDown className="size-icon-sm" />}
                </span>
              </button>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((r) => (
          <TableRow key={r.id} {...linkedRow}>
            {r.cells.map((cell, i) => (
              <TableCell key={i}>{cell}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </TableRoot>
  );
}
export function Form({
  children,
  onSubmit,
  label,
  pending,
  disabled,
  error,
}: {
  children: ReactNode;
  onSubmit: (form: FormData) => void;
  label: string;
  pending?: boolean;
  disabled?: boolean;
  error?: Error | null;
}) {
  const t = useT();
  return (
    <form
      className="form"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
    >
      {children}
      {error && <Callout tone="error">{error.message}</Callout>}
      <div className="form-footer">
        <Button variant="default" disabled={pending || disabled}>
          {pending ? t("saving") : label}
          <ArrowUpRight aria-hidden="true" size={15} />
        </Button>
      </div>
    </form>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const t = useT();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="modal"
        style={wide ? { width: "min(900px, calc(100vw - 2rem))", maxWidth: "calc(100vw - 2rem)" } : undefined}
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <div className="modal-heading">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label={t("close")}>
              <X aria-hidden="true" size={16} />
            </Button>
          </DialogClose>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}
