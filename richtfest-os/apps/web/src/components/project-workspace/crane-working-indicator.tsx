import "./crane-working-indicator.css";

export function CraneWorkingIndicator({
  label,
  working = true,
}: {
  label: string;
  working?: boolean;
}) {
  return (
    <span
      className={`crane-working-indicator${working ? "" : " crane-working-indicator--waiting"}`}
      role="status"
      aria-live="polite"
    >
      <svg
        className="crane-working-indicator__art"
        viewBox="0 0 72 42"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M5 37h19M9 34h11M15 34V8m-4 0h43m-43 0 7-5 7 5m-7 0v4m0 22h6m25-26 7-3 7 3m-7-3v4" />
        <path
          className="crane-working-indicator__brace"
          d="m15 12 9-4m-9 8 9-4m-9 8 9-4m-9 8 9-4m-9 8 9-4"
        />
        <g className="crane-working-indicator__load">
          <path d="M34 8v18" />
          <path
            className="crane-working-indicator__block"
            d="M29 26h10v9H29z"
          />
          <path d="M31 29h6m-6 3h6" />
        </g>
        <path d="M12 37h45" />
      </svg>
      <span className="crane-working-indicator__label">{label}</span>
    </span>
  );
}
