import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { listEnabledRegions } from "./regions.js";

/**
 * A friendly, actionable error. The most common failure is "no credentials in
 * the environment" — so we say exactly what to set rather than surfacing the
 * SDK's generic credentials error.
 */
export class AwsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsAuthError";
  }
}

const CREDS_HINT =
  "AWS credentials not found.\n" +
  "  Set them via env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY [/ AWS_SESSION_TOKEN]),\n" +
  "  a named profile (AWS_PROFILE + ~/.aws/credentials), or an attached IAM role.\n" +
  "  Read-only access is enough — e.g. the AWS-managed ReadOnlyAccess or ViewOnlyAccess policy.";

const REGION_HINT =
  "No AWS region set. Pass --region <region> (e.g. eu-west-2), set AWS_REGION,\n" +
  "  or use --all-regions to scan every enabled region.";

export interface AwsContext {
  accountId: string;
  regions: string[];
}

/**
 * Resolve the account id (via STS) and the region list to scan, failing fast
 * with a copy-paste fix if credentials or region aren't set up.
 *
 * @param regionOpt  explicit --region value (overrides env)
 * @param allRegions when true, discover and scan every enabled region
 */
export async function resolveAwsContext(
  regionOpt: string | undefined,
  allRegions: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AwsContext> {
  const anchorRegion = regionOpt ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";

  let accountId: string;
  try {
    const sts = new STSClient({ region: anchorRegion });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    accountId = id.Account ?? "unknown-account";
  } catch (err) {
    throw new AwsAuthError(`${CREDS_HINT}\n\n  underlying error: ${(err as Error).message}`);
  }

  let regions: string[];
  if (allRegions) {
    regions = await listEnabledRegions(anchorRegion);
  } else {
    const explicit = regionOpt ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (!explicit) throw new AwsAuthError(REGION_HINT);
    regions = [explicit];
  }

  return { accountId, regions };
}
