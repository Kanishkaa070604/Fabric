/**
 * Universal Access API client — maps locked R1/R2 response shapes.
 *
 * Never log credential.password or secret values.
 */

export type AccessHeaders = {
  tenantId: string;
  environmentId: string;
};

export type DatabaseCredentials = {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  /** Sequelize / node-pg dialectOptions for TLS */
  ssl: false | { rejectUnauthorized: boolean };
  resourceId?: string;
  resourceFlavor?: string;
  tlsMode?: string;
};

export type AccessEnvelope<T> = {
  status: string;
  statusCode: number;
  message: string;
  data: T;
};

export type DatabaseAccessData = {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  resourceFlavor: string;
  credential: {
    type: string;
    username: string;
    password: string;
  };
  connection: {
    host: string;
    port: number;
    database: string;
  };
  tls: {
    mode: string;
  };
  properties?: {
    refreshable?: boolean;
    expiresAt?: string | null;
    resourceVersion?: string;
  };
};

export type SecretGetData = {
  action: "get";
  secretName: string;
  status: string;
  value: string;
};

export type SecretMutateData = {
  action: "create" | "update";
  secretName: string;
  status: string;
  message?: string;
};

export interface AccessClient {
  getDatabaseCredentials(headers: AccessHeaders): Promise<DatabaseCredentials>;
  getSecret(headers: AccessHeaders, secretName: string): Promise<string>;
  createSecret(
    headers: AccessHeaders,
    secretName: string,
    secretValue: string,
    scope: string
  ): Promise<void>;
  updateSecret(
    headers: AccessHeaders,
    secretName: string,
    secretValue: string
  ): Promise<void>;
}

export class AccessApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "AccessApiError";
  }
}

/** Map Access database envelope (e.g. control#database) → connection fields. */
export function mapDatabaseResponse(raw: unknown): DatabaseCredentials {
  const env = raw as AccessEnvelope<DatabaseAccessData>;
  if (!env || typeof env !== "object") {
    throw new AccessApiError("access database: response is not an object");
  }
  if (env.status !== "success" || env.statusCode !== 200) {
    throw new AccessApiError(
      `access database: status=${env.status} statusCode=${env.statusCode} message=${env.message}`,
      env.statusCode,
      { status: env.status, message: env.message }
    );
  }
  const d = env.data;
  if (!d?.connection?.host || !d?.credential?.username) {
    throw new AccessApiError("access database: missing connection or credential");
  }
  const tlsMode = (d.tls?.mode || "").toUpperCase();
  // OCI Postgres advertises VERIFY_FULL but serves a private/self-signed chain.
  // Encrypt the session; do not fail bootstrap on CA verification (no CA mounted).
  const ssl =
    tlsMode === "" || tlsMode === "DISABLE" || tlsMode === "DISABLE_TLS"
      ? false
      : { rejectUnauthorized: false };

  return {
    host: d.connection.host,
    port: Number(d.connection.port),
    database: d.connection.database,
    username: d.credential.username,
    password: d.credential.password,
    ssl,
    resourceId: d.resourceId,
    resourceFlavor: d.resourceFlavor,
    tlsMode: d.tls?.mode,
  };
}

/** Map R2 secrets get envelope → plaintext value. */
export function mapSecretGetResponse(raw: unknown): string {
  const env = raw as AccessEnvelope<SecretGetData>;
  if (!env || typeof env !== "object") {
    throw new AccessApiError("secrets get: response is not an object");
  }
  if (env.status !== "success" || env.statusCode !== 200) {
    throw new AccessApiError(
      `secrets get: status=${env.status} statusCode=${env.statusCode} message=${env.message}`,
      env.statusCode,
      { status: env.status, message: env.message }
    );
  }
  if (env.data?.status !== "success" || typeof env.data.value !== "string") {
    throw new AccessApiError("secrets get: missing data.value");
  }
  return env.data.value;
}

function assertSecretMutateOk(raw: unknown, action: string): void {
  const env = raw as AccessEnvelope<SecretMutateData>;
  if (!env || typeof env !== "object") {
    throw new AccessApiError(`secrets ${action}: response is not an object`);
  }
  if (env.status !== "success" || env.statusCode !== 200) {
    throw new AccessApiError(
      `secrets ${action}: status=${env.status} statusCode=${env.statusCode} message=${env.message}`,
      env.statusCode,
      { status: env.status, message: env.message }
    );
  }
  if (env.data?.status !== "success") {
    throw new AccessApiError(`secrets ${action}: data.status=${env.data?.status}`);
  }
}

export class HttpAccessClient implements AccessClient {
  /**
   * @param dbResourceType Access X-ABLV-ResourceType for store credentials.
   *   Abluva Unified Access maps the control-plane DB as `control#database`
   *   (schema `control`). `keys#database` is the data-privacy key store and
   *   404s when requested for CP bootstrap.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly dbResourceType: string = "control#database"
  ) {}

  private async post(
    headers: AccessHeaders,
    resourceType: string,
    body?: unknown
  ): Promise<unknown> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ABLV-Tenant-ID": headers.tenantId,
        "X-ABLV-Environment-ID": headers.environmentId,
        "X-ABLV-ResourceType": resourceType,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      throw new AccessApiError(
        `access_api_http_${res.status}`,
        res.status,
        typeof parsed === "object" ? parsed : { body: text }
      );
    }
    return parsed;
  }

  async getDatabaseCredentials(
    headers: AccessHeaders
  ): Promise<DatabaseCredentials> {
    const raw = await this.post(headers, this.dbResourceType);
    return mapDatabaseResponse(raw);
  }

  async getSecret(headers: AccessHeaders, secretName: string): Promise<string> {
    const raw = await this.post(headers, "data-privacy#secrets-manager", {
      action: "get",
      secretName,
    });
    return mapSecretGetResponse(raw);
  }

  async createSecret(
    headers: AccessHeaders,
    secretName: string,
    secretValue: string,
    scope: string
  ): Promise<void> {
    const raw = await this.post(headers, "data-privacy#secrets-manager", {
      action: "create",
      secretName,
      secretValue,
      scope,
    });
    assertSecretMutateOk(raw, "create");
  }

  async updateSecret(
    headers: AccessHeaders,
    secretName: string,
    secretValue: string
  ): Promise<void> {
    const raw = await this.post(headers, "data-privacy#secrets-manager", {
      action: "update",
      secretName,
      secretValue,
    });
    assertSecretMutateOk(raw, "update");
  }
}
