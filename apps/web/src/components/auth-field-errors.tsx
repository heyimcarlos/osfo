/** Render validation errors beneath one authentication field. */
export function AuthFieldErrors({
  errors,
}: {
  readonly errors: ReadonlyArray<{ readonly message?: string } | undefined>;
}) {
  return errors.map((error) =>
    error?.message ? (
      <p key={error.message} className="font-medium text-xs text-destructive" role="alert">
        {error.message}
      </p>
    ) : null,
  );
}
