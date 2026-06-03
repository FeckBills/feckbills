import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";

/** GetMetricData caps a single request at 500 queries. */
const BATCH = 100;

/**
 * Peak EC2 CPUUtilization (%) over the window for a set of instances in one
 * region, via CloudWatch GetMetricData (batched). Instances with no datapoints
 * are simply absent from the returned map — no data ≠ idle.
 */
export async function peakCpuByInstance(
  region: string,
  instanceIds: string[],
  windowDays: number,
): Promise<Map<string, number>> {
  const peaks = new Map<string, number>();
  if (instanceIds.length === 0) return peaks;

  const client = new CloudWatchClient({ region });
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - windowDays * 24 * 60 * 60 * 1000);

  for (let i = 0; i < instanceIds.length; i += BATCH) {
    const chunk = instanceIds.slice(i, i + BATCH);
    // Map a stable query id (m0, m1, …) back to its instance id.
    const idByQuery = new Map<string, string>();
    const queries: MetricDataQuery[] = chunk.map((instanceId, idx) => {
      const qid = `m${idx}`;
      idByQuery.set(qid, instanceId);
      return {
        Id: qid,
        MetricStat: {
          Metric: {
            Namespace: "AWS/EC2",
            MetricName: "CPUUtilization",
            Dimensions: [{ Name: "InstanceId", Value: instanceId }],
          },
          Period: 3600, // 1-hour buckets
          Stat: "Maximum",
        },
        ReturnData: true,
      };
    });

    let nextToken: string | undefined;
    do {
      const res = await client.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: startTime,
          EndTime: endTime,
          NextToken: nextToken,
        }),
      );
      for (const result of res.MetricDataResults ?? []) {
        const instanceId = result.Id ? idByQuery.get(result.Id) : undefined;
        if (!instanceId) continue;
        const values = result.Values ?? [];
        if (values.length === 0) continue;
        const peak = Math.max(...values);
        const prev = peaks.get(instanceId);
        peaks.set(instanceId, prev == null ? peak : Math.max(prev, peak));
      }
      nextToken = res.NextToken;
    } while (nextToken);
  }

  return peaks;
}
