import { getGCPAccessToken } from "../shared/google-auth.ts";

const TASKS_API = "https://cloudtasks.googleapis.com/v2";
const SCOPES = ["https://www.googleapis.com/auth/cloud-tasks"];

export class CloudTasksClient {
  private readonly queuePath: string;

  constructor(
    private readonly projectId: string,
    private readonly location: string,
    private readonly queueId: string,
    private readonly processorUrl: string,
    private readonly serviceAccountEmail: string,
    private readonly serviceAccountKey?: string,
  ) {
    this.queuePath =
      `projects/${projectId}/locations/${location}/queues/${queueId}`;
  }

  async enqueue(itemId: number): Promise<void> {
    const token = await getGCPAccessToken(SCOPES, this.serviceAccountKey);
    const payload = btoa(JSON.stringify({ itemId }));

    const resp = await fetch(
      `${TASKS_API}/${this.queuePath}/tasks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: {
            httpRequest: {
              url: `${this.processorUrl}/process`,
              httpMethod: "POST",
              headers: { "Content-Type": "application/json" },
              body: payload,
              oidcToken: {
                serviceAccountEmail: this.serviceAccountEmail,
              },
            },
          },
        }),
      },
    );

    if (!resp.ok) {
      throw new Error(
        `Cloud Tasks enqueue failed: ${resp.status} ${await resp.text()}`,
      );
    }
  }
}
