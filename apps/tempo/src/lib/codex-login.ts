import { Schema } from "effect";
import { TempoError, type JsonDataFields } from "@tempo/protocol";

// Matches codex-rs/login's device_code_auth and auth::CLIENT_ID.
const ISSUER = "https://auth.openai.com";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CODEX_VERIFICATION_URL = `${ISSUER}/codex/device`;

export const CODEX_LOGIN_TTL_MS = 15 * 60_000;

const failed = () =>
  new TempoError(
    "CREDENTIAL_INVALID",
    "Could not connect Codex. Enable device-code login in your ChatGPT security settings or ask your workspace admin, then try again. You can also upload auth.json.",
  );

const post = async (path: string, body: JsonDataFields | URLSearchParams): Promise<Response> => {
  try {
    return await fetch(`${ISSUER}${path}`, {
      method: "POST",
      headers: {
        "Content-Type":
          body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json",
      },
      body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw failed();
  }
};

const ResponseFields = Schema.Record(Schema.String, Schema.Json);

const json = async (response: Response): Promise<typeof ResponseFields.Type> => {
  try {
    return Schema.decodeUnknownSync(ResponseFields)(await response.json());
  } catch {
    /* Never expose an upstream response or token in an error. */
  }

  throw failed();
};

const nonempty = (value: unknown): value is string => Schema.is(Schema.String)(value) && value.length > 0;

export const requestCodexDeviceCode = async () => {
  const response = await post("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID });

  if (!response.ok) throw failed();
  const data = await json(response);
  const userCode = data.user_code ?? data.usercode;
  const seconds = data.interval === undefined ? 5 : Number(data.interval);

  if (!nonempty(data.device_auth_id) || !nonempty(userCode) || !Number.isFinite(seconds) || seconds < 0)
    throw failed();

  return { deviceAuthId: data.device_auth_id, userCode, intervalMs: Math.max(1, seconds) * 1000 };
};

export const pollCodexDeviceCode = async (deviceAuthId: string, userCode: string) => {
  const response = await post("/api/accounts/deviceauth/token", {
    device_auth_id: deviceAuthId,
    user_code: userCode,
  });

  // These are the pending statuses used by Codex, rather than RFC 8628 error bodies.
  if (response.status === 403 || response.status === 404) return null;

  if (!response.ok) throw failed();
  const data = await json(response);

  if (!nonempty(data.authorization_code) || !nonempty(data.code_verifier)) throw failed();

  return { authorizationCode: data.authorization_code, codeVerifier: data.code_verifier };
};

export const exchangeCodexDeviceCode = async (authorizationCode: string, codeVerifier: string) => {
  const response = await post(
    "/oauth/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
    }),
  );

  if (!response.ok) throw failed();
  const data = await json(response);

  if (!nonempty(data.id_token) || !nonempty(data.access_token) || !nonempty(data.refresh_token))
    throw failed();

  const accountId = (() => {
    try {
      const payload = data.id_token.split(".")[1];

      if (!payload) throw failed();
      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");

      const claims = Schema.decodeUnknownSync(
        Schema.Struct({
          "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.String }),
        }),
      )(JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))));

      const id = claims["https://api.openai.com/auth"].chatgpt_account_id;

      if (!nonempty(id)) throw failed();

      return id;
    } catch {
      throw failed();
    }
  })();

  const lastRefresh = Date.now();

  return {
    lastRefresh,
    content: JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: data.id_token,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        account_id: accountId,
      },
      last_refresh: new Date(lastRefresh).toISOString(),
    }),
  };
};
