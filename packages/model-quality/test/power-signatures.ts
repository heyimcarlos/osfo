import { sign } from "node:crypto";

import { pairedPowerPlanSigningDigest, type PairedPowerPlanInput } from "../src/statistics";

const privateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ1/nUquUnxA7PyVnFxa1FcLmT2D5LPsmQ4WSrJOuwNz
-----END PRIVATE KEY-----`;

/** Return the authority signature for one product-owned power declaration. */
export const powerPlanSignature = (input: Omit<PairedPowerPlanInput, "signature">): string =>
  sign(null, Buffer.from(pairedPowerPlanSigningDigest(input)), privateKey).toString("base64");
