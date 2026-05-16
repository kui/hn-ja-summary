import { getGCPAccessToken } from "./google-auth.ts";
import type { ItemState } from "./types.ts";

const FIRESTORE_API = "https://firestore.googleapis.com/v1";
const COLLECTION = "processed_items";
const SCOPES = ["https://www.googleapis.com/auth/datastore"];

interface FirestoreDoc {
  name?: string;
  fields?: Record<string, { stringValue?: string; timestampValue?: string }>;
}

interface BatchGetResponse {
  found?: FirestoreDoc;
  missing?: string;
}

export class FirestoreClient {
  private readonly dbPath: string;

  constructor(
    private readonly projectId: string,
    private readonly serviceAccountKey?: string,
  ) {
    this.dbPath = `projects/${projectId}/databases/(default)/documents`;
  }

  private get baseUrl(): string {
    return `${FIRESTORE_API}/${this.dbPath}`;
  }

  private token(): Promise<string> {
    return getGCPAccessToken(SCOPES, this.serviceAccountKey);
  }

  async batchGetStates(itemIds: number[]): Promise<Map<number, ItemState>> {
    if (itemIds.length === 0) return new Map();

    const token = await this.token();
    const docNames = itemIds.map(
      (id) => `${this.dbPath}/${COLLECTION}/${id}`,
    );

    const resp = await fetch(
      `${FIRESTORE_API}/projects/${this.projectId}/databases/(default)/documents:batchGet`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ documents: docNames }),
      },
    );

    if (!resp.ok) {
      throw new Error(
        `Firestore batchGet failed: ${resp.status} ${await resp.text()}`,
      );
    }

    const results = await resp.json() as BatchGetResponse[];
    const states = new Map<number, ItemState>();

    for (const result of results) {
      if (result.found?.name) {
        const idStr = result.found.name.split("/").pop();
        const state = result.found.fields?.state?.stringValue as
          | ItemState
          | undefined;
        if (idStr && state) {
          states.set(parseInt(idStr, 10), state);
        }
      }
    }

    return states;
  }

  async setEnqueued(itemId: number): Promise<void> {
    const now = new Date().toISOString();
    await this.patch(itemId, {
      state: { stringValue: "enqueued" },
      enqueuedAt: { timestampValue: now },
      updatedAt: { timestampValue: now },
    });
  }

  async setCompleted(itemId: number): Promise<void> {
    const now = new Date().toISOString();
    await this.patch(
      itemId,
      {
        state: { stringValue: "completed" },
        completedAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
      ["state", "completedAt", "updatedAt"],
    );
  }

  async setError(itemId: number, message: string): Promise<void> {
    const now = new Date().toISOString();
    await this.patch(
      itemId,
      {
        state: { stringValue: "error" },
        errorMessage: { stringValue: message },
        updatedAt: { timestampValue: now },
      },
      ["state", "errorMessage", "updatedAt"],
    );
  }

  async setSkipped(itemId: number, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.patch(
      itemId,
      {
        state: { stringValue: "skipped" },
        skipReason: { stringValue: reason },
        updatedAt: { timestampValue: now },
      },
      ["state", "skipReason", "updatedAt"],
    );
  }

  private async patch(
    itemId: number,
    fields: Record<string, { stringValue?: string; timestampValue?: string }>,
    updateMaskFields?: string[],
  ): Promise<void> {
    const token = await this.token();

    const url = new URL(`${this.baseUrl}/${COLLECTION}/${itemId}`);
    if (updateMaskFields) {
      for (const f of updateMaskFields) {
        url.searchParams.append("updateMask.fieldPaths", f);
      }
    }

    const resp = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });

    if (!resp.ok) {
      throw new Error(
        `Firestore write failed: ${resp.status} ${await resp.text()}`,
      );
    }
  }
}
