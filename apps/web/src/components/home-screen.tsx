import { buttonVariants } from "@osfo/ui/components/button";
import { ArrowRight, LockKeyhole, MessageCircle, Sparkles } from "lucide-react";

const features = [
  {
    description: "Talk to Osfo in a simple conversation, without learning a new tool.",
    icon: MessageCircle,
    title: "Start with a message",
  },
  {
    description: "Keep one private agent that remembers the context you choose to share.",
    icon: LockKeyhole,
    title: "Your own private agent",
  },
  {
    description: "Connect more tools and automate repeat work when you are ready.",
    icon: Sparkles,
    title: "Grow at your pace",
  },
] as const;

/** Public Osfo home page for signed-out visitors. */
export function HomeScreen() {
  return (
    <div className="min-h-dvh overflow-x-hidden bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] text-foreground">
      <header className="border-b-2 border-border bg-background">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <a className="flex items-center gap-3" href="/" aria-label="Osfo home">
            <span className="grid size-10 place-items-center rounded-full bg-primary text-lg font-black text-primary-foreground shadow-sm">
              O
            </span>
            <span className="text-xl font-black tracking-tight">Osfo</span>
          </a>
          <nav className="flex items-center gap-4" aria-label="Primary navigation">
            <a className="font-black text-sm uppercase hover:underline" href="/login">
              Sign in
            </a>
            <a className={buttonVariants({ size: "sm" })} href="/login">
              Get started
              <ArrowRight data-icon="inline-end" />
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-6xl content-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div>
            <p className="font-black text-xs uppercase tracking-[0.22em]">Your personal AI agent</p>
            <h1 className="mt-5 max-w-3xl text-balance text-5xl font-black uppercase leading-[0.92] sm:text-7xl">
              Get the busy work out of your way.
            </h1>
            <p className="mt-6 max-w-2xl text-balance text-xl font-medium leading-snug text-foreground/75 sm:text-2xl">
              Osfo helps you plan, write, organize, and act, through one simple conversation.
            </p>
            <a
              className={buttonVariants({
                className: "mt-8 min-w-56 justify-between",
                size: "lg",
              })}
              href="/login"
            >
              Get started
              <ArrowRight data-icon="inline-end" />
            </a>
          </div>

          <div className="grid gap-4" aria-label="What Osfo offers">
            {features.map(({ description, icon: Icon, title }) => (
              <article
                className="grid grid-cols-[auto_1fr] items-center gap-5 border-2 border-border bg-background p-5 shadow-[6px_6px_0_var(--foreground)]"
                key={title}
              >
                <Icon className="size-10 stroke-[1.8]" aria-hidden="true" />
                <div>
                  <h2 className="font-black text-lg uppercase">{title}</h2>
                  <p className="mt-1 font-medium leading-snug text-foreground/70">{description}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
