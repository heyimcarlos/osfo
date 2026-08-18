/** Secrets supplied by the deployed Worker environment outside Wrangler variables. */
export interface RuntimeSecrets {
  readonly TELEGRAM_ALLOWED_USER_IDS: string;
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_BOT_USERNAME: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN: string;
}
