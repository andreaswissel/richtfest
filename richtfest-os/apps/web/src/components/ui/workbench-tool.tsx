import type { ComponentProps } from "react";
import { cn } from "cn";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import "./workbench-tool.css";

/** Canvas tools share a visible shortcut, an accessible label and a tooltip across workbenches. */
export function WorkbenchTool({ label, shortcut, tooltipSide = "right", className, children, ...props }: ComponentProps<"button"> & {
  label: string;
  shortcut?: string;
  tooltipSide?: "right" | "left" | "top" | "bottom";
}) {
  const button = <button type="button" className={cn("workbench-tool", className)} aria-label={label}
    aria-keyshortcuts={shortcut} {...props}>
    {children}
    {shortcut && <kbd>{shortcut}</kbd>}
  </button>;
  return <TooltipProvider delayDuration={300}>
    <Tooltip>
      {/* Disabled buttons receive no pointer events, so their tooltip hangs on a wrapper. */}
      <TooltipTrigger asChild>{props.disabled ? <span className="workbench-tool-wrap" tabIndex={-1}>{button}</span> : button}</TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        {label}
        {shortcut && <kbd data-slot="kbd" className="workbench-tool-tip-kbd">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}
