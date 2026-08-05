// Only allow the portfolio origin(s) to call this worker.
export const ALLOWED_ORIGINS = [
  "https://abhishekyogi.in",
  "https://www.abhishekyogi.in",
  "https://abhishekyogi24-hue.github.io",
  "http://localhost:4321", // local dev preview
  "http://127.0.0.1:4321",
];

export function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// A request with NO Origin header (curl, scripts, server-side callers) used to
// skip this check entirely under the old `if (origin && !ALLOWED_ORIGINS...)`
// logic. Require a present, allow-listed Origin for every real request.
export function originAllowed(origin) {
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}
