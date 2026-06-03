import { DefaultAzureCredential } from "@azure/identity";
import { listSubscriptions, type AzureSubscription } from "./subscriptions.js";

/**
 * A friendly, actionable error. The most common failure is "not logged in" —
 * so we say exactly what to run rather than surfacing the SDK's generic
 * credentials error.
 */
export class AzureAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureAuthError";
  }
}

const CREDS_HINT =
  "Azure credentials not found.\n" +
  "  Run:  az login   (or set a service principal via AZURE_CLIENT_ID / AZURE_TENANT_ID /\n" +
  "  AZURE_CLIENT_SECRET, or use a managed identity).\n" +
  "  Read-only access is enough — e.g. the built-in Reader role on the subscription.";

const SUB_HINT =
  "No Azure subscription set. Pass --subscription <id>, set AZURE_SUBSCRIPTION_ID,\n" +
  "  or use --all-subscriptions to scan every subscription you can see.";

export interface AzureContext {
  credential: DefaultAzureCredential;
  subscriptions: AzureSubscription[];
}

/**
 * Resolve a credential and the subscriptions to scan, failing fast with a
 * copy-paste fix if login or subscription aren't set up.
 *
 * @param subscriptionOpt explicit --subscription value (overrides env)
 * @param allSubs         when true, discover and scan every visible subscription
 */
export async function resolveAzureContext(
  subscriptionOpt: string | undefined,
  allSubs: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AzureContext> {
  const credential = new DefaultAzureCredential();

  // Force a token now so auth problems surface here, not mid-scan.
  try {
    await credential.getToken("https://management.azure.com/.default");
  } catch (err) {
    throw new AzureAuthError(`${CREDS_HINT}\n\n  underlying error: ${(err as Error).message}`);
  }

  let subscriptions: AzureSubscription[];
  if (allSubs) {
    subscriptions = await listSubscriptions(credential);
  } else {
    const explicit = subscriptionOpt ?? env.AZURE_SUBSCRIPTION_ID;
    if (!explicit) throw new AzureAuthError(SUB_HINT);
    subscriptions = [{ id: explicit, name: explicit }];
  }

  return { credential, subscriptions };
}
