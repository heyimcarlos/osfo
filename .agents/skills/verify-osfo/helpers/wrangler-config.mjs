/* oxlint-disable effecttsgo/node-builtin-import -- This CLI resolves Wrangler from the Worker package that owns it. */
import { createRequire } from "node:module";

const [canonicalPath, outputPath, runId, postgresUrl, providerOrigin, workerOrigin, webOrigin] =
  process.argv.slice(2);
if (
  canonicalPath === undefined ||
  outputPath === undefined ||
  runId === undefined ||
  postgresUrl === undefined ||
  providerOrigin === undefined ||
  workerOrigin === undefined ||
  webOrigin === undefined
) {
  throw new Error(
    "Usage: wrangler-config.mjs <canonical> <output> <run-id> <postgres-url> <provider-origin> <worker-origin> <web-origin>",
  );
}

const workerRoot = new URL("../../../../apps/worker/", import.meta.url);
const requireFromWorker = createRequire(new URL("package.json", workerRoot));
const requireFromWrangler = createRequire(requireFromWorker.resolve("wrangler"));
const { parse } = requireFromWrangler("jsonc-parser");
const parseErrors = [];
const config = parse(await Bun.file(canonicalPath).text(), parseErrors, {
  allowTrailingComma: true,
  disallowComments: false,
});
if (parseErrors.length > 0) {
  throw new Error(`Cannot parse canonical Wrangler config: ${JSON.stringify(parseErrors)}`);
}

delete config.$schema;
config.name = `osfo-verification-${runId}`;
config.main = new URL("src/worker.ts", workerRoot).pathname;
// Verified account journeys use local provider boundaries. Remote provider bindings make
// Wrangler open proxy sessions and require Cloudflare credentials in local and CI runs.
delete config.ai;
delete config.websearch;
delete config.secrets;
config.vars = {
  ...config.vars,
  BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
  BETTER_AUTH_API_URL: providerOrigin,
  BETTER_AUTH_BASE_URL: workerOrigin,
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
  BETTER_AUTH_TRUSTED_ORIGINS: JSON.stringify([webOrigin]),
  OSFO_STAGE: "test",
  STRIPE_ADVENTURER_PRICE_ID: "price_adventurer",
  STRIPE_ADVENTURER_PRODUCT_ID: "prod_adventurer",
  STRIPE_API_BASE_URL: providerOrigin,
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_approved",
  STRIPE_SECRET_KEY: "sk_test_osfo",
  STRIPE_WEBHOOK_SECRET: "whsec_test_osfo",
  SUPERMEMORY_API_BASE_URL: providerOrigin,
  SUPERMEMORY_API_KEY: "test-only-supermemory-api-key",
  TELEGRAM_API_BASE_URL: providerOrigin,
  TELEGRAM_BOT_TOKEN: "telegram-test-bot-token",
  TELEGRAM_BOT_USERNAME: "osfo_verify_bot",
  TELEGRAM_WEBHOOK_SECRET_TOKEN: "osfo-verification-telegram-secret",
  TWILIO_ACCOUNT_SID: "AC11111111111111111111111111111111",
  TWILIO_AUTH_TOKEN: "test-only-twilio-token",
  TWILIO_VERIFY_API_BASE_URL: providerOrigin,
  TWILIO_VERIFY_SERVICE_SID: "VA22222222222222222222222222222222",
  WHATSAPP_ACCESS_TOKEN: "test-only-whatsapp-access-token",
  WHATSAPP_API_BASE_URL: providerOrigin,
  WHATSAPP_APP_SECRET: "test-only-whatsapp-app-secret",
  WHATSAPP_BOT_USERNAME: "osfo_verify_whatsapp",
  WHATSAPP_PHONE_NUMBER_ID: "123456789",
  WHATSAPP_VERIFY_TOKEN: "test-only-whatsapp-verify-token",
  WHATSAPP_WAKEUP_TEMPLATE_APPROVAL:
    "approved:whatsapp-wakeup-v1:osfo_update:en,es",
  WHATSAPP_WAKEUP_TEMPLATE_NAME: "osfo_update",
  WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION: "whatsapp-wakeup-v1",
};

config.hyperdrive = replaceBinding(config.hyperdrive, "DB", (binding) => ({
  ...binding,
  localConnectionString: postgresUrl,
}));
config.r2_buckets = config.r2_buckets.map((binding) => ({
  ...binding,
  bucket_name: `${binding.bucket_name}-${runId}`,
}));
config.workflows = config.workflows.map((binding) => ({
  ...binding,
  name: `${binding.name}-${runId}`,
}));
config.containers = config.containers.map((container) => ({
  ...container,
  image: new URL(container.image, workerRoot).pathname,
}));

await Bun.write(outputPath, `${JSON.stringify(config, null, 2)}\n`);

function replaceBinding(bindings, name, replace) {
  let found = false;
  const replaced = bindings.map((binding) => {
    if (binding.binding !== name) return binding;
    found = true;
    return replace(binding);
  });
  if (!found) throw new Error(`Canonical Wrangler config has no ${name} binding`);
  return replaced;
}
