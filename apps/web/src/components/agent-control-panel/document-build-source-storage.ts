import { BrowserFileId } from "@osfo/api";
import { Data, Effect, Option, Schema } from "effect";

const storageKey = "osfo-document-build-source";
const decodeFileId = Schema.decodeUnknownOption(BrowserFileId);

/** Retain only a lookup hint; the authenticated file authority must verify it before display. */
export const loadDocumentBuildSource = () =>
  withSourceStorage((storage) => Option.getOrNull(decodeFileId(storage.getItem(storageKey))), null);

export const rememberDocumentBuildSource = (fileId: string) =>
  withSourceStorage((storage) => storage.setItem(storageKey, fileId), undefined);

export const forgetDocumentBuildSource = () =>
  withSourceStorage((storage) => storage.removeItem(storageKey), undefined);

const withSourceStorage = <A>(operation: (storage: Storage) => A, fallback: A): A =>
  Effect.runSync(
    Effect.try({
      try: () => operation(globalThis.sessionStorage),
      catch: () => new SourceStorageUnavailable(),
    }).pipe(Effect.catchTag("SourceStorageUnavailable", () => Effect.succeed(fallback))),
  );

class SourceStorageUnavailable extends Data.TaggedError("SourceStorageUnavailable") {}
