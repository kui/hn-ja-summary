export interface ServiceAccountKey {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

function b64urlEncode(data: string | Uint8Array): string {
  const str = typeof data === "string" ? data : String.fromCharCode(...data);
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function rsaSign(
  input: string,
  privateKeyPem: string,
): Promise<Uint8Array> {
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----\n?/, "")
    .replace(/\n?-----END PRIVATE KEY-----\n?/, "")
    .replace(/\n/g, "");

  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );

  return new Uint8Array(sig);
}

async function mintJWT(
  key: ServiceAccountKey,
  scopes: string[],
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlEncode(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes.join(" "),
      aud: key.token_uri,
      exp: now + 3600,
      iat: now,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = await rsaSign(signingInput, key.private_key);
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export async function getGCPAccessToken(
  scopes: string[],
  serviceAccountKeyJson?: string,
): Promise<string> {
  // Try GCP metadata server first (works on Cloud Run, GCE, etc.)
  try {
    const scopeParam = encodeURIComponent(scopes.join(","));
    const resp = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=${scopeParam}`,
      {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (resp.ok) {
      const { access_token } = await resp.json() as { access_token: string };
      return access_token;
    }
  } catch {
    // not on GCP
  }

  if (!serviceAccountKeyJson) {
    throw new Error(
      "No Google credentials: set GOOGLE_SERVICE_ACCOUNT_KEY or run on GCP.",
    );
  }

  const key: ServiceAccountKey = JSON.parse(serviceAccountKeyJson);
  const jwt = await mintJWT(key, scopes);

  const resp = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    throw new Error(
      `Token exchange failed: ${resp.status} ${await resp.text()}`,
    );
  }

  const { access_token } = await resp.json() as { access_token: string };
  return access_token;
}
