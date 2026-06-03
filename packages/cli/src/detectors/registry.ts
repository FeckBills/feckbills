import type { Provider } from "@feckbills/core";
import type { Detector } from "./types.js";
import type { AwsDetectorContext } from "./aws-types.js";
import type { AzureDetectorContext } from "./azure-types.js";
import { gkeRequestsVsUsage } from "./gke-requests-vs-usage.js";
import { gcpUnattachedDisks } from "./gcp-unattached-disks.js";
import { gcpIdleIp } from "./gcp-idle-ip.js";
import { gcpOrphanedSnapshots } from "./gcp-orphaned-snapshots.js";
import { gcpStoppedVmDisks } from "./gcp-stopped-vm-disks.js";
import { gcpIdleInstances } from "./gcp-idle-instances.js";
import { awsUnattachedVolumes } from "./aws-unattached-volumes.js";
import { awsIdleIp } from "./aws-idle-ip.js";
import { awsOrphanedSnapshots } from "./aws-orphaned-snapshots.js";
import { awsStoppedInstanceVolumes } from "./aws-stopped-instance-volumes.js";
import { awsIdleInstances } from "./aws-idle-instances.js";
import { azureUnattachedDisks } from "./azure-unattached-disks.js";
import { azureIdleIp } from "./azure-idle-ip.js";
import { azureOrphanedSnapshots } from "./azure-orphaned-snapshots.js";
import { azureDeallocatedVmDisks } from "./azure-deallocated-vm-disks.js";
import { azureIdleInstances } from "./azure-idle-instances.js";

/** All GCP detectors, in the order we want them to run. */
export const ALL_DETECTORS: Detector[] = [
  gkeRequestsVsUsage,
  gcpUnattachedDisks,
  gcpIdleIp,
  gcpOrphanedSnapshots,
  gcpStoppedVmDisks,
  gcpIdleInstances,
];

/** All AWS detectors, in the order we want them to run. */
export const ALL_AWS_DETECTORS: Detector<AwsDetectorContext>[] = [
  awsUnattachedVolumes,
  awsIdleIp,
  awsOrphanedSnapshots,
  awsStoppedInstanceVolumes,
  awsIdleInstances,
];

/** All Azure detectors, in the order we want them to run. */
export const ALL_AZURE_DETECTORS: Detector<AzureDetectorContext>[] = [
  azureUnattachedDisks,
  azureIdleIp,
  azureOrphanedSnapshots,
  azureDeallocatedVmDisks,
  azureIdleInstances,
];

export function detectorsFor(provider: Provider): Detector[] {
  return ALL_DETECTORS.filter((d) => d.provider === provider);
}

export function awsDetectors(): Detector<AwsDetectorContext>[] {
  return ALL_AWS_DETECTORS;
}

export function azureDetectors(): Detector<AzureDetectorContext>[] {
  return ALL_AZURE_DETECTORS;
}
