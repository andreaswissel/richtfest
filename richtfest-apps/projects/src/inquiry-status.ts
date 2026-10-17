/** Sending moves an inquiry to waiting; anything received makes it answered. Closed inquiries stay closed until reopened. */
export const statusAfter = (current: string, direction: string) => current === "closed" || direction === "internal" ? current : direction === "outgoing" ? "waiting" : "answered";
