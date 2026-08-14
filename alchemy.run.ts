import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import { Config, ConfigProvider, Effect, Layer, Schema } from "effect";

import { OsfoStage } from "@osfo/worker/env";
import { dataResources } from "./infra/cloudflare/data";
import { workerObservability } from "./infra/cloudflare/observability";
import { workerResources } from "./infra/cloudflare/worker";
import { webResources } from "./infra/cloudflare/web";
import { workflowResources } from "./infra/cloudflare/workflows";

/** Stage-separated Osfo Cloudflare stack. */
export default Alchemy.Stack(
  "Osfo",
  {
    providers: Cloudflare.providers().pipe(Layer.provideMerge(Neon.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const rawStage = yield* Alchemy.Stage;
    const stage = yield* Schema.decodeUnknownEffect(OsfoStage)(rawStage).pipe(
      Effect.mapError((error) => new Config.ConfigError(error)),
    );
    const data = yield* dataResources(stage).pipe(
      Effect.mapError(
        (error) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              cause: error,
              message: "Postgres migration integrity verification failed",
            }),
          ),
      ),
    );
    const workflows = workflowResources(stage);
    const web = webResources(stage);
    const worker = yield* workerResources(
      stage,
      data,
      workflows.executionUnit,
      workerObservability,
    );

    return {
      groups: {
        data: data.stage,
        observability: workerObservability,
        worker: {
          url: worker.worker.url.as<string>(),
          worker: worker.worker.workerName,
        },
        web: web.stage,
        workflows: workflows.stage,
      },
      stage,
    };
  }),
);
