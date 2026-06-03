import type { MonitorClient } from "@azure/arm-monitor";

/**
 * Peak "Percentage CPU" over the window for a set of VMs, via Azure Monitor
 * metrics (one request per VM — the metrics API is per-resource). VMs with no
 * datapoints are absent from the returned map — no data ≠ idle.
 */
export async function peakCpuByVm(
  client: MonitorClient,
  vmIds: string[],
  windowDays: number,
): Promise<Map<string, number>> {
  const peaks = new Map<string, number>();
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const timespan = `${start.toISOString()}/${end.toISOString()}`;

  await Promise.all(
    vmIds.map(async (id) => {
      try {
        const res = await client.metrics.list(id, {
          timespan,
          interval: "PT1H",
          metricnames: "Percentage CPU",
          aggregation: "Maximum",
        });
        const points = res.value?.[0]?.timeseries?.[0]?.data ?? [];
        const maxima = points.map((p) => p.maximum).filter((n): n is number => n != null);
        if (maxima.length > 0) peaks.set(id, Math.max(...maxima));
      } catch {
        // A metrics read failing for one VM shouldn't sink the detector.
      }
    }),
  );

  return peaks;
}
