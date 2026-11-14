export const appBase = import.meta.env.BASE_URL;
let csrf = '';
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(appBase + 'api' + path, {
    method,
    credentials: 'same-origin',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.message || '请求失败', response.status);
  return value as T;
}
export async function download(path: string, filename: string) {
  const response = await fetch(appBase + 'api' + path, { credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
