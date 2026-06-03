import { EC2Client, DescribeRegionsCommand } from "@aws-sdk/client-ec2";

/**
 * Every region enabled for the account, via EC2 DescribeRegions. Powers
 * `--all-regions` — scan the whole footprint from one credential instead of
 * naming regions by hand. `AllRegions` is left false so we only get regions
 * the account can actually use.
 */
export async function listEnabledRegions(anchorRegion: string): Promise<string[]> {
  const client = new EC2Client({ region: anchorRegion });
  const res = await client.send(new DescribeRegionsCommand({}));
  return (res.Regions ?? [])
    .map((r) => r.RegionName)
    .filter((n): n is string => Boolean(n))
    .sort();
}
