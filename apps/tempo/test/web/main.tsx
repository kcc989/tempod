import { RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { getRouter } from "../../src/router";
import "./styles.css";

const router = getRouter();
Object.assign(router.routeTree.options, {
  shellComponent: ({ children }: { children: ReactNode }) => <>{children}</>,
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
