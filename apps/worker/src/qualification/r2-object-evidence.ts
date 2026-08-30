import { bytesToHex } from "@noble/hashes/utils.js";

import type { R2ObjectEvidence } from "./semantic-evidence";

/** R2 object fields that prove one atomically committed object and its metadata. */
export interface QualificationR2Object {
  readonly checksums: {
    readonly sha256?: ArrayBuffer | undefined;
  };
  readonly customMetadata?: Record<string, string>;
  readonly etag: string;
  readonly key: string;
  readonly uploaded: { readonly toISOString: () => string };
  readonly version: string;
}

/** Derive root evidence from metadata committed atomically with one R2 object. */
export const r2ObjectEvidence = (object: QualificationR2Object): R2ObjectEvidence | null => {
  const rootId = object.customMetadata?.osfoRootId;
  const objectId = object.customMetadata?.osfoObjectId;
  const sha256 = object.checksums.sha256;
  const checksum = sha256 === undefined ? undefined : bytesToHex(new Uint8Array(sha256));
  return rootId === undefined || objectId === undefined || checksum === undefined
    ? null
    : {
        checksum,
        etag: object.etag,
        objectId,
        objectKey: object.key,
        rootId,
        uploadedAt: object.uploaded.toISOString(),
        version: object.version,
      };
};
