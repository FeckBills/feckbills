import type { Provider } from "@feckbills/core";
import type { Detector } from "./types.js";
import { gkeRequestsVsUsage } from "./gke-requests-vs-usage.js";
import { gcpUnattachedDisks } from "./gcp-unattached-disks.js";
import { gcpIdleIp } from "./gcp-idle-ip.js";
import { gcpOrphanedSnapshots } from "./gcp-orphaned-snapshots.js";
import { gcpStoppedVmDisks } from "./gcp-stopped-vm-disks.js";
import { gcpIdleInstances } from "./gcp-idle-instances.js";

/** All detectors, in the order we want them to run. */
export const ALL_DETECTORS: Detector[] = [
  gkeRequestsVsUsage,
  gcpUnattachedDisks,
  gcpIdleIp,
  gcpOrphanedSnapshots,
  gcpStoppedVmDisks,
  gcpIdleInstances,
];

export function detectorsFor(provider: Provider): Detector[] {
  return ALL_DETECTORS.filter((d) => d.provider === provider);
}
