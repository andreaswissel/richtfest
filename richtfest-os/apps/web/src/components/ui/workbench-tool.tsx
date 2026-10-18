import type { ComponentProps } from "react";
import { cn } from "cn";
import "./workbench-tool.css";

/** Canvas tools share a visible shortcut and an accessible label across workbenches. */
export function WorkbenchTool({ label, shortcut, className, children, ...props }: ComponentProps<"button"> & {
  label: string;
  shortcut?: string;
}) {
  return <button type="button" className={cn("workbench-tool", className)} aria-label={label}
    title={shortcut ? `${label} (${shortcut})` : label} aria-keyshortcuts={shortcut} {...props}>
    {children}
    {shortcut && <kbd>{shortcut}</kbd>}
  </button>;
}
