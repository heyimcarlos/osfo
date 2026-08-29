import { Worker } from "alchemy/Cloudflare";

/** API Worker resource tag used to close the private qualification service cycle. */
export class ApiWorker extends Worker<ApiWorker, {}>()("Api") {}

/** Qualification-owner resource tag bound back to the API Worker. */
export class QualificationOwnerWorker extends Worker<QualificationOwnerWorker, {}>()(
  "QualificationOwner",
) {}
