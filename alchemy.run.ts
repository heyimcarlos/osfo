import { Stack } from "alchemy";
import { providers, state } from "alchemy/Cloudflare";
// oxlint-disable-next-line osfo/no-star-import -- Alchemy's Cloudflare and Neon modules both expose `providers`; the named namespace keeps both canonical APIs.
import * as Neon from "alchemy/Neon";
import { Effect, Layer } from "effect";

import { DatabaseHyperdrive, Db } from "./infra/cloudflare/Db";
import { Artifacts } from "./infra/cloudflare/Artifacts";
import Worker from "./infra/cloudflare/Worker";
import Web, { productionWebOrigin } from "./infra/cloudflare/Web";

/** Stage-separated Osfo Cloudflare stack. */
export default Stack(
  "Osfo",
  {
    providers: providers().pipe(Layer.provideMerge(Neon.providers())),
    state: state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const { branchId } = yield* Db;
    const artifacts = yield* Artifacts;
    const db = yield* DatabaseHyperdrive;
    const worker = yield* Worker;
    const web = yield* Web(worker.url.as<string>());

    return {
      branchId,
      artifactsBucketName: artifacts.bucketName,
      hyperdriveId: db.hyperdriveId,
      stage,
      url: worker.url.as<string>(),
      webUrl: stage === "production" ? productionWebOrigin : web.url.as<string>(),
      webWorkerName: web.workerName,
      workerName: worker.workerName,
    };
  }),
);
