import type { MetricServiceClient } from "@google-cloud/monitoring";
import type { google } from "@google-cloud/monitoring/build/protos/protos.js";

type Aligner = "ALIGN_MEAN" | "ALIGN_RATE" | "ALIGN_MAX" | "ALIGN_PERCENTILE_95";
type Reducer = "REDUCE_SUM" | "REDUCE_MEAN" | "REDUCE_NONE";

export interface TimeSeriesQuery {
  metricType: string;
  /** k8s_container, gce_instance, etc. */
  resourceType: string;
  /** Look-back window in days. */
  windowDays: number;
  /** Bucket width in seconds (default 600 = 10 min). */
  alignmentSeconds?: number;
  perSeriesAligner: Aligner;
  crossSeriesReducer?: Reducer;
  /** e.g. ["resource.label.namespace_name", "resource.label.container_name"]. */
  groupByFields?: string[];
  /** Extra filter clauses ANDed onto the metric/resource filter. */
  extraFilter?: string;
}

/** One grouped series: the labels it was reduced by + its numeric points (newest-first). */
export interface GroupedSeries {
  labels: Record<string, string>;
  points: number[];
}

/**
 * Thin wrapper over Cloud Monitoring `listTimeSeries`. Everything the GKE
 * detector needs — requests and usage alike — comes through here, so the
 * detector never touches the raw SDK shapes.
 */
export class MonitoringClient {
  constructor(
    private readonly client: MetricServiceClient,
    private readonly projectId: string,
  ) {}

  async query(q: TimeSeriesQuery): Promise<GroupedSeries[]> {
    const endSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = endSeconds - q.windowDays * 24 * 60 * 60;

    const filterParts = [
      `metric.type="${q.metricType}"`,
      `resource.type="${q.resourceType}"`,
    ];
    if (q.extraFilter) filterParts.push(q.extraFilter);

    const request: google.monitoring.v3.IListTimeSeriesRequest = {
      name: `projects/${this.projectId}`,
      filter: filterParts.join(" "),
      interval: {
        startTime: { seconds: startSeconds },
        endTime: { seconds: endSeconds },
      },
      aggregation: {
        alignmentPeriod: { seconds: q.alignmentSeconds ?? 600 },
        perSeriesAligner: q.perSeriesAligner,
        crossSeriesReducer: q.crossSeriesReducer ?? "REDUCE_NONE",
        groupByFields: q.groupByFields ?? [],
      },
      view: "FULL",
    };

    // The client auto-paginates and returns the full array as the first element.
    const [series] = await this.client.listTimeSeries(request);

    return series.map((ts) => ({
      labels: {
        ...(ts.resource?.labels ?? {}),
        ...(ts.metric?.labels ?? {}),
      },
      points: (ts.points ?? [])
        .map((p) => numericValue(p.value))
        .filter((n): n is number => n !== null),
    }));
  }
}

function numericValue(value: google.monitoring.v3.ITypedValue | null | undefined): number | null {
  if (!value) return null;
  if (value.doubleValue != null) return value.doubleValue;
  if (value.int64Value != null) return Number(value.int64Value);
  return null;
}
