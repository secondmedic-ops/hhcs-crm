// Bindings and settings of the Worker. Secrets are set by the pipeline (wrangler deploy --secrets-file), never in git.
export interface Env {
  ASSETS: Fetcher;
  /** Supabase Postgres through Cloudflare Hyperdrive (made by the pipeline from the GitHub secret SUPABASE_DB_URL). */
  HYPERDRIVE?: Hyperdrive;
  /** Live-updates hub (Durable Object, SQLite class: allowed on the Workers Free plan). */
  LIVE: DurableObjectNamespace;
  /** Local test / rehearsal only: a database on this computer, used when there is no Hyperdrive binding. */
  DATABASE_URL?: string;
  /** https://<ref>.supabase.co - login tokens are checked against its signing keys (JWKS). */
  SUPABASE_URL?: string;
  /** Secret, optional: Supabase service_role key, only for Settings > Users > "New user" (creates the login). */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  DEFAULT_WORKSPACE_CODE?: string;
  APP_URL?: string;
  BUILD_SHA?: string;
  /** Rehearsal only ("1"): serves /api/_contract and /api/_schema-check. Never set in production. */
  EXPOSE_CONTRACT?: string;
  /** Local test only ("off"): no login, pick a role. Refused unless DATABASE_URL points at this computer. */
  AUTH_MODE?: string;

  // MyOperator (secrets)
  MYOPERATOR_WEBHOOK_KEY?: string;
  MYOPERATOR_COMPANY_ID?: string;
  MYOPERATOR_SECRET_TOKEN?: string;
  MYOPERATOR_OBD_API_KEY?: string;
  MYOPERATOR_PUBLIC_IVR_ID?: string;
  MYOPERATOR_API_TOKEN?: string;
  MYOPERATOR_WABA_API_KEY?: string;
  MYOPERATOR_WABA_PHONE_ID?: string;
  MYOPERATOR_CALLER_ID?: string;
  MYOPERATOR_REGION?: string;
  /** 'app' = always dial through the MyOperator Chrome extension / app; otherwise the Calling API, falling back to the app. */
  MYOPERATOR_DIAL_MODE?: string;
  /** Overridable endpoints (tests point these at a stand-in). */
  MYOPERATOR_OBD_URL?: string;
  MYOPERATOR_RECORDING_URL?: string;
  MYOPERATOR_API_URL?: string;
  MYOPERATOR_WABA_URL?: string;

  // AI (Google AI Studio key) and MIS e-mail
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  AI_AUTO_PROCESS_CALLS?: string;
  RESEND_API_KEY?: string;
  MIS_RECIPIENTS?: string;
  MIS_FROM?: string;
  EMAIL_ARCHIVE_TO?: string;
}
