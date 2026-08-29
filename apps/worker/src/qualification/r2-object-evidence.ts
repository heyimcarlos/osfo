import type { R2ObjectEvidence } from "./semantic-evidence";

/** R2 object fields that prove one atomically committed object and its metadata. */
export interface QualificationR2Object {
  readonly checksums: {
    readonly toJSON: () => {
      readonly md5?: string;
      readonly sha1?: string;
      readonly sha256?: string;
      readonly sha384?: string;
      readonly sha512?: string;
    };
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
  const checksums = object.checksums.toJSON();
  const checksum =
    checksums.sha256 ?? checksums.sha1 ?? checksums.md5 ?? checksums.sha384 ?? checksums.sha512;
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
