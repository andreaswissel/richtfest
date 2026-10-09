/** Only local absolute paths may follow an authentication link. */
export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/.test(value)
  )
    return "/";
  try {
    const url = new URL(value, "https://local.invalid");
    return url.origin === "https://local.invalid"
      ? url.pathname + url.search + url.hash
      : "/";
  } catch {
    return "/";
  }
}
