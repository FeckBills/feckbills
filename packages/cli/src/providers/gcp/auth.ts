import { MetricServiceClient } from "@google-cloud/monitoring";

/**
 * A friendly, actionable error. The single most common failure for a new user
 * is "logged into gcloud but ADC not initialised" — so we say exactly what to
 * run rather than surfacing the SDK's generic credentials error.
 */
export class GcpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcpAuthError";
  }
}

const ADC_HINT =
  "GCP Application Default Credentials not found.\n" +
  "  Run:  gcloud auth application-default login\n" +
  "  (Being logged into `gcloud` is not enough — the SDK reads ADC, not your gcloud user login.)";

export interface GcpContext {
  projectId: string;
  client: MetricServiceClient;
}

/**
 * Resolve the project id and a ready Monitoring client from ADC, failing fast
 * with a copy-paste fix if credentials aren't set up. An explicit `projectId`
 * (from --project) overrides ADC's default project.
 */
export async function resolveGcpContext(projectId?: string): Promise<GcpContext> {
  const client = new MetricServiceClient();

  let resolvedProject = projectId;
  try {
    if (!resolvedProject) {
      resolvedProject = await client.getProjectId();
    }
    // Force credential resolution now so auth problems surface here, not mid-scan.
    await client.auth.getClient();
  } catch (err) {
    throw new GcpAuthError(`${ADC_HINT}\n\n  underlying error: ${(err as Error).message}`);
  }

  if (!resolvedProject) {
    throw new GcpAuthError(
      "Could not determine a GCP project. Pass --project <id> or set one with `gcloud config set project <id>`.",
    );
  }

  return { projectId: resolvedProject, client };
}
