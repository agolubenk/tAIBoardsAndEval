// One spelling per address: "/v1/" and "/v1" are the same endpoint, and a
// trailing slash would double in "/chat/completions".
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// Scheme, host and port: the part of the address a model key is bound to.
export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
