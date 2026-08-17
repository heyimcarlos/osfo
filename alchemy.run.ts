import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import { Effect, Layer } from "effect";

import { Db, Hyperdrive } from "./infra/cloudflare/Db";
import { Artifacts } from "./infra/cloudflare/Artifacts";
import Worker from "./infra/cloudflare/Worker";

/** Stage-separated Osfo Cloudflare stack. */
export default Alchemy.Stack(
  "Osfo",
  {
    providers: Cloudflare.providers().pipe(Layer.provideMerge(Neon.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const { branchId } = yield* Db;
    const artifacts = yield* Artifacts;
    const db = yield* Hyperdrive;
    const worker = yield* Worker;

    return {
      branchId,
      artifactsBucketName: artifacts.bucketName,
      hyperdriveId: db.hyperdriveId,
      stage,
      url: worker.url.as<string>(),
      workerName: worker.workerName,
    };
  }),
);
