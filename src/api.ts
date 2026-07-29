interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;

  constructor(message: string, code = "REQUEST_FAILED") {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

export async function api<T = null>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  if (response.status === 204) return null as T;
  const payload = (await response.json().catch(() => null)) as
    | ApiErrorPayload
    | T
    | null;
  if (!response.ok) {
    const apiPayload = payload as ApiErrorPayload | null;
    throw new ApiError(
      apiPayload?.error?.message ?? "The request failed.",
      apiPayload?.error?.code,
    );
  }
  return payload as T;
}
