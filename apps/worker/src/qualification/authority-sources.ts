/** Product-owned authorities that must contribute immutable material before qualification can pass. */
export const qualificationAuthoritySources = [
  "allowance_and_billing_ledger",
  "gmail_provider_receipts",
  "memory_commit_receipts",
  "model_access_receipts",
  "osfo_agent_activation_log",
  "osfo_committed_turns",
  "provider_delivery_receipts",
  "qualification_fault_controller_receipts",
  "r2_object_metadata",
  "task_compute_receipts",
  "think_submission_receipts",
  "whatsapp_delivery_receipts",
  "worker_admission_receipts",
  "workflow_instance_receipts",
] as const;

export type QualificationAuthoritySource = (typeof qualificationAuthoritySources)[number];

export const isQualificationAuthoritySource = (
  value: string,
): value is QualificationAuthoritySource =>
  qualificationAuthoritySources.some((source) => source === value);
