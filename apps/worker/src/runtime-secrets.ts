/** Secrets supplied by the deployed Worker environment outside Wrangler variables. */
export interface RuntimeSecrets {
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_BOT_USERNAME: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN: string;
  readonly WHATSAPP_ACCESS_TOKEN: string;
  readonly WHATSAPP_APP_SECRET: string;
  readonly WHATSAPP_BOT_USERNAME: string;
  readonly WHATSAPP_PHONE_NUMBER_ID: string;
  readonly WHATSAPP_VERIFY_TOKEN: string;
}
