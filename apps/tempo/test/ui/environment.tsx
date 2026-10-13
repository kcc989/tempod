import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HubStoreContext } from "../../src/ui/hooks/useHub";
import { HubStore } from "../../src/ui/stores/hub-store";
import { TooltipProvider } from "../../src/ui/components/ui/tooltip";
import { Toaster } from "sonner";
import { API } from "@tempo/protocol";
import { Schema } from "effect";
import { createContext, useContext, useState, type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { vi } from "vitest";
import type { FnName, FnInput, FnOutput, WorkspaceDetail } from "@tempo/protocol";
import { createApiClient } from "../../src/ui/lib/api-client";
import { ApiCallContext } from "../../src/ui/hooks/useCall";
import { WorkspaceStoresContext } from "../../src/ui/hooks/useWorkspace";
import { WorkspaceStore } from "../../src/ui/stores/workspace-store";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/ui/stores/workspace-state";
import type { SocketLike } from "../../src/ui/lib/socket";
import { detail } from "./fixtures";

const Children = createContext<ReactNode>(null);

const Content = () => useContext(Children);

class ReplaySocket implements SocketLike {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

/** Test requests use the real API decoder; workspace snapshots come from real channel frames. */
export const createUiEnvironment = () => {
  const request = vi.fn<(name: FnName, input: FnInput<FnName>) => Promise<FnOutput<FnName>>>(
    async () => ({}),
  );

  const api = createApiClient(async (name, input) =>
    JSON.stringify({ ok: true, value: await request(name, input) }),
  );

  const hub = new HubStore(() => new ReplaySocket());
  const stores = new Map<string, WorkspaceStore>();
  let state: WorkspaceState = { ...emptyWorkspaceState, workspace: detail() };

  const seed = (store: WorkspaceStore, workspace: WorkspaceDetail) => {
    store.receive(
      JSON.stringify({
        type: "hello",
        v: 1,
        workspace,
        sessions: Object.values(state.sessions),
        turns: Object.values(state.turns),
        itemsRev: state.itemsRev,
      }),
    );
    store.receive(
      JSON.stringify({
        type: "items",
        items: Object.values(state.items),
        itemsRev: state.itemsRev,
        done: state.backlogDone,
      }),
    );
  };

  const storeFor = (id: string) => {
    let store = stores.get(id);

    if (!store) {
      store = new WorkspaceStore(id, () => new ReplaySocket());
      stores.set(id, store);

      if (state.workspace) seed(store, state.workspace);
    }

    return store;
  };

  const setState = (next: Partial<WorkspaceState>) => {
    state = { ...emptyWorkspaceState, ...next };

    for (const store of stores.values()) if (state.workspace) seed(store, state.workspace);
  };

  function Provider({ children }: { children: ReactNode }) {
    const [client] = useState(
      () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
    );

    const [router] = useState(() =>
      createRouter({
        routeTree: createRootRoute({ component: Content }),
        history: createMemoryHistory({ initialEntries: ["/"] }),
      }),
    );

    return (
      <QueryClientProvider client={client}>
        <ApiCallContext.Provider value={api}>
          <HubStoreContext.Provider value={hub}>
            <WorkspaceStoresContext.Provider value={storeFor}>
              <Children.Provider value={children}>
                <RouterContextProvider router={router}>
                  <TooltipProvider>{children}</TooltipProvider>
                  <Toaster />
                </RouterContextProvider>
              </Children.Provider>
            </WorkspaceStoresContext.Provider>
          </HubStoreContext.Provider>
        </ApiCallContext.Provider>
      </QueryClientProvider>
    );
  }

  return { request, Provider, setState, storeFor };
};

export const requestInput = <K extends FnName>(name: K, input: FnInput<FnName>): FnInput<K> =>
  Schema.decodeUnknownSync(API[name].input)(input);
