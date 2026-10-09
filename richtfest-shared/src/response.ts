export type ApiError = { code: string; details?: unknown };
export type ApiEnvelope<T> = { data: T | null; error: ApiError | null; message: string | null };

export const ok = <T>(data: T, message: string | null = null): ApiEnvelope<T> => ({ data, error: null, message });
export const fail = (code: string, message: string, details?: unknown): ApiEnvelope<null> => ({ data: null, error: { code, details }, message });
