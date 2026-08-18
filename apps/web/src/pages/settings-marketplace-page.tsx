import {
  BarChart3,
  Blocks,
  CheckSquare2,
  Feather,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

type Recipe = {
  readonly accent: string;
  readonly category: "Featured" | "Finance" | "Productivity" | "Shopping" | "Social";
  readonly description: string;
  readonly icon: LucideIcon;
  readonly installs: string;
  readonly name: string;
  readonly rating: string;
  readonly status: "New" | "Popular" | "Trending";
};

const recipes: ReadonlyArray<Recipe> = [
  {
    accent: "bg-[#25c768]",
    category: "Finance",
    description: "Buy stocks, check your portfolio, and receive market updates.",
    icon: Feather,
    installs: "12.4k",
    name: "Robinhood Assistant",
    rating: "4.8",
    status: "Popular",
  },
  {
    accent: "bg-[#171a20]",
    category: "Shopping",
    description: "Track orders, manage returns, and find better deals.",
    icon: Blocks,
    installs: "9.8k",
    name: "Amazon Manager",
    rating: "4.7",
    status: "Popular",
  },
  {
    accent: "bg-[#7040ec]",
    category: "Finance",
    description: "Daily market summaries and portfolio insights.",
    icon: BarChart3,
    installs: "4.1k",
    name: "Market Insights",
    rating: "4.9",
    status: "Trending",
  },
  {
    accent: "bg-[#25b867]",
    category: "Productivity",
    description: "Read and update your sheets with Osfo.",
    icon: CheckSquare2,
    installs: "6.2k",
    name: "Google Sheets Sync",
    rating: "4.6",
    status: "New",
  },
  {
    accent: "bg-[#f09a42]",
    category: "Social",
    description: "Send alerts and updates to your Slack channels.",
    icon: Blocks,
    installs: "3.7k",
    name: "Slack Notifier",
    rating: "4.5",
    status: "New",
  },
];

const categories = ["Featured", "Finance", "Shopping", "Productivity", "Social"] as const;

/** Route-owned searchable marketplace concept. */
export function SettingsMarketplacePage() {
  const [category, setCategory] = useState<(typeof categories)[number]>("Featured");
  const [query, setQuery] = useState("");
  const visibleRecipes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return recipes.filter(
      (recipe) =>
        (category === "Featured" || recipe.category === category) &&
        (normalizedQuery.length === 0 ||
          recipe.name.toLowerCase().includes(normalizedQuery) ||
          recipe.description.toLowerCase().includes(normalizedQuery)),
    );
  }, [category, query]);

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="relative flex min-h-13 flex-1 items-center rounded-2xl border border-white/80 bg-white/70 px-4 focus-within:ring-2 focus-within:ring-[#2f7df4]">
          <Search aria-hidden="true" className="mr-3 size-5 text-[#56709a]" />
          <span className="sr-only">Search marketplace</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#70809d]"
            placeholder="Search recipes and connectors..."
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <span className="grid min-h-13 place-items-center rounded-full border border-white/80 bg-white/70 px-5 text-sm font-medium">
          All Categories
        </span>
      </div>

      <section className="mt-5" aria-labelledby="marketplace-categories-title">
        <h2 className="mb-2 text-sm font-bold" id="marketplace-categories-title">
          Categories
        </h2>
        <div className="flex flex-wrap gap-2">
          {categories.map((item) => (
            <button
              aria-pressed={category === item}
              className={`min-h-11 rounded-xl border border-white/80 px-4 text-xs font-medium focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none ${category === item ? "bg-[#dce9fc] text-[#135fdd]" : "bg-white/68 hover:bg-white/85"}`}
              key={item}
              type="button"
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6" aria-labelledby="featured-recipes-title">
        <h2 className="mb-3 text-sm font-bold" id="featured-recipes-title">
          Featured Recipes
        </h2>
        {visibleRecipes.length === 0 ? (
          <div className="rounded-2xl border border-white/80 bg-white/65 p-8 text-center text-sm text-[#687896]">
            No recipe previews match this search.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {visibleRecipes.map((recipe) => (
              <RecipeCard key={recipe.name} recipe={recipe} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-7" aria-labelledby="your-recipes-title">
        <h2 className="mb-3 text-sm font-bold" id="your-recipes-title">
          Your Recipes
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr]">
          <div className="flex min-h-16 items-center gap-3 rounded-2xl border border-[#cfc5ff] bg-[#f0ecff]/70 p-3">
            <span className="grid size-10 place-items-center rounded-full bg-[#e5ddff] text-[#7557ec]">
              <Sparkles aria-hidden="true" className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Create Your Own</span>
              <span className="block text-xs text-[#687896]">Build and share custom recipes.</span>
            </span>
            <button
              className="min-h-10 cursor-not-allowed rounded-full border border-[#c7b9ff] bg-white/65 px-5 text-xs text-[#7557ec]"
              disabled
              type="button"
            >
              Coming soon
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function RecipeCard({ recipe }: { readonly recipe: Recipe }) {
  const Icon = recipe.icon;
  return (
    <article className="flex min-h-64 flex-col rounded-[1.25rem] border border-white/85 bg-white/72 p-3 shadow-[0_14px_30px_rgba(66,88,123,0.12)]">
      <span
        className={`w-fit rounded-full px-3 py-1 text-[10px] ${recipe.status === "New" ? "bg-[#dff7e9] text-[#17955b]" : "bg-[#eee7ff] text-[#7557ec]"}`}
      >
        {recipe.status}
      </span>
      <span
        aria-hidden="true"
        className={`mt-2 grid size-11 place-items-center self-center rounded-xl text-white ${recipe.accent}`}
      >
        <Icon className="size-6" />
      </span>
      <h3 className="mt-3 text-sm font-bold">{recipe.name}</h3>
      <p className="mt-1 flex-1 text-xs leading-relaxed text-[#687896]">{recipe.description}</p>
      <p className="mt-2 text-[11px] text-[#687896]">
        ★ {recipe.rating} <span className="float-right">{recipe.installs} installs</span>
      </p>
      <button
        className="mt-3 min-h-10 cursor-not-allowed rounded-full border border-[#aac8f5] text-xs font-medium text-[#135fdd] opacity-75"
        disabled
        type="button"
      >
        Install soon
      </button>
    </article>
  );
}
