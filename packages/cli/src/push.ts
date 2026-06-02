import type { Scan } from "@feckbills/core";

export interface PushResult {
  scanId: string;
  findings: number;
  totalEstimatedSaving: number;
}

/**
 * POST a completed scan's findings to a FeckBills console `/api/ingest`
 * endpoint, authenticated with a project's ingest token. The payload is the
 * raw Scan JSON — validated server-side against the same `ScanSchema`.
 */
export async function pushScan(url: string, token: string, scan: Scan): Promise<PushResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(scan),
    });
  } catch (err) {
    throw new Error(`could not reach ${url}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = `${detail} — ${body.error}`;
    } catch {
      // non-JSON error body; keep the status line
    }
    throw new Error(`ingest rejected the scan: ${detail}`);
  }

  return (await res.json()) as PushResult;
}
