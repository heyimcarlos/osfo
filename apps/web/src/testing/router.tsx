import { createMemoryHistory, RouterContextProvider } from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";

import { createAppRouter } from "../router";

/** Wrap presentation content in a memory router for static-render tests. */
export const withTestRouter = (children: ReactNode) => (
  <RouterContextProvider
    router={createAppRouter({ history: createMemoryHistory({ initialEntries: ["/"] }) })}
  >
    {children}
  </RouterContextProvider>
);

/** Render interactive presentation content in a memory router. */
export const renderWithTestRouter = (ui: ReactNode): RenderResult => render(withTestRouter(ui));
