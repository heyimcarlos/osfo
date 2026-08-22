/** Node-owned resources shared with one Worker journey run through Vitest injection. */
export interface JourneyContext {
  readonly databaseNamePrefix: string;
  readonly databaseObserverOrigin: string;
  readonly maintenanceUrl: string;
  readonly providerOrigin: string;
  readonly templateName: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    readonly osfoJourney: JourneyContext;
  }
}
