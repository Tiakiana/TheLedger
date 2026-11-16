export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

let serverOffset = 0;
/** Current time on the server's clock (deadlines are server timestamps). */
export const serverNow = () => Date.now() + serverOffset;
export function syncServerClock(serverTime: number | undefined): void {
  if (typeof serverTime === 'number') serverOffset = serverTime - Date.now();
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    if (res.status === 401 && !url.endsWith('/api/auth/login')) window.dispatchEvent(new Event('ledger:unauthorized'));
    throw new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `Request failed (${res.status}).`);
  }
  if (json && typeof json.serverNow === 'number') syncServerClock(json.serverNow);
  return json as T;
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const patch = <T = any>(url: string, body: unknown = {}) => api<T>('PATCH', url, body);
export const put = <T = any>(url: string, body: unknown = {}) => api<T>('PUT', url, body);
export const del = <T = any>(url: string, body?: unknown) => api<T>('DELETE', url, body);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Reads a File as base64 for image upload. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''));
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

export async function uploadImage(file: File): Promise<{ id: string; url: string }> {
  const dataBase64 = await fileToBase64(file);
  return post('/api/gm/images', { mime: file.type, dataBase64 });
}
