import { sign } from "node:crypto";

import {
  baselineApprovalSigningDigest,
  evaluationOutputSigningDigest,
  type EvaluationManifestInput,
} from "../src/manifest";
import {
  modelGraderQualificationSigningDigest,
  type ModelGraderQualificationInput,
} from "../src/grading";

const baselinePrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIDmiR4NILzW2YSMXSOo0aqXLcNzEgsy2C3PWClQzDrf5
-----END PRIVATE KEY-----`;

const outputPrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJDP/neObuPWSkH6y7oY5kgGsWzWlAW9LBO6CtUdZFZe
-----END PRIVATE KEY-----`;

const modelGraderPrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKHe3IxPGjbbNGGKhNags8eccdQnazlM6E2nC2HtIZTV
-----END PRIVATE KEY-----`;

/** Sign product-owned baseline fixture evidence. */
export const baselineSignature = (input: EvaluationManifestInput["approvedBaseline"]): string =>
  sign(null, Buffer.from(baselineApprovalSigningDigest(input)), baselinePrivateKey).toString(
    "base64",
  );

/** Sign product-owned evaluation-output fixture evidence. */
export const outputSignature = (input: EvaluationManifestInput): string =>
  sign(null, Buffer.from(evaluationOutputSigningDigest(input)), outputPrivateKey).toString(
    "base64",
  );

/** Sign product-owned model-grader calibration fixture evidence. */
export const modelGraderSignature = (input: ModelGraderQualificationInput): string =>
  sign(
    null,
    Buffer.from(modelGraderQualificationSigningDigest(input)),
    modelGraderPrivateKey,
  ).toString("base64");
