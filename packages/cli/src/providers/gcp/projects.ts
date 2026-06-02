import { GoogleAuth } from "google-auth-library";

export interface GcpProject {
  projectId: string;
  name: string;
}

interface RawProject {
  projectId?: string;
  name?: string;
  lifecycleState?: string;
}

interface ListResponse {
  projects?: RawProject[];
  nextPageToken?: string;
}

/**
 * Every ACTIVE project the credential can see, via Cloud Resource Manager.
 * This is what powers `--all-projects` — scan the whole estate from one
 * credential instead of adding projects by hand.
 */
export async function listAccessibleProjects(): Promise<GcpProject[]> {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"] });
  const client = await auth.getClient();
  const out: GcpProject[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://cloudresourcemanager.googleapis.com/v1/projects");
    url.searchParams.set("pageSize", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await client.request<ListResponse>({ url: url.toString() });
    for (const p of res.data.projects ?? []) {
      if (p.lifecycleState === "ACTIVE" && p.projectId) {
        out.push({ projectId: p.projectId, name: p.name ?? p.projectId });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}
