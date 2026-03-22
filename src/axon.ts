const AXON_URL = process.env.AXON_URL || "http://localhost:4600";
const AXON_KEY = process.env.AXON_API_KEY || "";
const SERVICE_NAME = "thymus";

export function emitEvent(channel: string, type: string, payload: Record<string, unknown>) {
  if (!AXON_URL) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AXON_KEY) headers["Authorization"] = "Bearer " + AXON_KEY;
  fetch(AXON_URL + "/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({ channel, source: SERVICE_NAME, type, payload }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
