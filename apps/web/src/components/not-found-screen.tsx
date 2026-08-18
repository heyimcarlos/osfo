import { Link } from "@tanstack/react-router";

/** Safe fallback for unknown browser routes. */
export function NotFoundScreen() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-10">
      <section className="max-w-md text-center">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">404</p>
        <h1 className="mt-3 text-4xl font-black uppercase">Page not found</h1>
        <p className="mt-3 text-muted-foreground">There is nothing at this address.</p>
        <Link className="mt-6 inline-block font-black underline" to="/">
          Go home
        </Link>
      </section>
    </main>
  );
}
