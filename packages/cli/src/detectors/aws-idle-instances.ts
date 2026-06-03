import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AwsDetectorContext, AwsRunningInstance } from "./aws-types.js";
import { PRICING_NOTE, awsComputeRates, instanceSpecs, priceReclaimable } from "../pricing/aws-resources.js";

const IDLE_THRESHOLD = 5; // peak CPU < 5% over the window = idle (CloudWatch is in %)
const MIN_MONTHLY_SAVING_GBP = 1;

/**
 * Idle EC2 instances. A running instance whose peak CPU stays under ~5% across
 * the window is a stop/downsize candidate. Both halves come from APIs we
 * already use (EC2 instance list + CloudWatch CPUUtilization).
 *
 * Carefully scoped:
 *   - We only flag instances we have metrics for (no data ≠ idle).
 *   - Confidence is moderate: an instance may be a deliberate standby / failover
 *     / batch box, so the fix says to verify.
 */
export const awsIdleInstances: Detector<AwsDetectorContext> = {
  id: "aws.idle-instances",
  provider: "aws",
  title: "Idle EC2 instances",

  async run(ctx: AwsDetectorContext): Promise<DetectorResult> {
    const instances = await ctx.resources.runningInstances();
    if (instances.length === 0) return { findings: [] };

    const peakById = await ctx.resources.cpuPeakByInstance(
      instances.map((i) => ({ id: i.id, region: i.region })),
      ctx.windowDays,
    );

    const rates = awsComputeRates(ctx.env);
    const findings: Finding[] = [];
    for (const inst of instances) {
      const peak = peakById.get(inst.id);
      if (peak === undefined) continue; // no metrics → don't guess
      if (peak >= IDLE_THRESHOLD) continue;

      const { vcpu, gib } = instanceSpecs(inst.instanceType);
      const saving = priceReclaimable(vcpu, gib, rates);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, inst, peak, vcpu, gib, saving));
    }

    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(
  ctx: AwsDetectorContext,
  inst: AwsRunningInstance,
  peak: number,
  vcpu: number,
  gib: number,
  saving: number,
): Finding {
  const label = inst.name ?? inst.id;
  const pct = Math.round(peak);
  return {
    detectorId: awsIdleInstances.id,
    provider: ctx.provider,
    resourceId: `aws-instance://${inst.region}/${inst.id}`,
    resourceName: `${label} (${inst.instanceType}, ${inst.region})`,
    region: inst.region,
    service: "EC2",
    category: "idle",
    severity: severityFor(saving),
    title: `Idle EC2 instance: ${label}`,
    detail:
      `Instance "${label}" (${inst.instanceType}, ~${vcpu} vCPU / ${gib.toFixed(0)} GiB, ${inst.az}) ` +
      `peaked at only ${pct}% CPU over ${ctx.windowDays}d. If it's not a deliberate standby/batch box, stop or downsize it.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.6,
    metrics: { peakCpuPct: pct, vcpu, gib, instanceType: inst.instanceType, instanceId: inst.id, pricingNote: PRICING_NOTE },
    suggestedAction: `Verify it's unused, then stop it: aws ec2 stop-instances --instance-ids ${inst.id} --region ${inst.region}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 100) return "high";
  if (saving >= 20) return "medium";
  return "low";
}
