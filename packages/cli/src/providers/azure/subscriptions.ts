import type { DefaultAzureCredential } from "@azure/identity";
import { SubscriptionClient } from "@azure/arm-subscriptions";

export interface AzureSubscription {
  id: string;
  name: string;
}

/**
 * Every enabled subscription the credential can see. Powers
 * `--all-subscriptions` — scan the whole tenant footprint from one credential.
 */
export async function listSubscriptions(credential: DefaultAzureCredential): Promise<AzureSubscription[]> {
  const client = new SubscriptionClient(credential);
  const out: AzureSubscription[] = [];
  for await (const sub of client.subscriptions.list()) {
    if (sub.subscriptionId && sub.state === "Enabled") {
      out.push({ id: sub.subscriptionId, name: sub.displayName ?? sub.subscriptionId });
    }
  }
  return out;
}
