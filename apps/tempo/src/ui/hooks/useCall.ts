import { createContext, useContext } from "react";
import type { FnInput, FnName, FnOutput } from "@tempo/protocol";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { call } from "~/ui/lib/api";
import { toastError } from "~/ui/lib/toast";

/** API implementation shared by query hooks; alternative transports use the same wire decoder. */
export const ApiCallContext = createContext(call);

export const useApiCall = () => useContext(ApiCallContext);

/** Query key of one server function call: ["call", name] or ["call", name, input]. */
export const callKey = <K extends FnName>(name: K, input?: FnInput<K>): readonly unknown[] =>
  input === undefined ? ["call", name] : ["call", name, input];

export const callQueryOptions = <K extends FnName>(name: K, input: FnInput<K>) =>
  queryOptions<FnOutput<K>, Error>({
    queryKey: callKey(name, input),
    queryFn: () => call(name, input),
  });

export type CallQueryOptions<K extends FnName> = Omit<
  UseQueryOptions<FnOutput<K>, Error, FnOutput<K>, readonly unknown[]>,
  "queryKey" | "queryFn"
>;

/** A read server function through TanStack Query. Errors are TempoError; they are not toasted. */
export function useCallQuery<K extends FnName>(
  name: K,
  input: FnInput<K>,
  options?: CallQueryOptions<K>,
): UseQueryResult<FnOutput<K>, Error> {
  const invoke = useContext(ApiCallContext);

  return useQuery<FnOutput<K>, Error, FnOutput<K>, readonly unknown[]>({
    queryKey: callKey(name, input),
    queryFn: () => invoke(name, input),
    ...options,
  });
}

/** Invalidates every cached call of these functions (any input). */
export const invalidateCalls = (queryClient: QueryClient, ...names: FnName[]): Promise<void> =>
  Promise.all(names.map((n) => queryClient.invalidateQueries({ queryKey: callKey(n) }))).then(
    () => undefined,
  );

export interface CallMutationOptions<K extends FnName> {
  /** Functions whose cached results become stale on success. */
  readonly invalidates?: ReadonlyArray<FnName>;
  readonly onSuccess?: (output: FnOutput<K>, input: FnInput<K>) => void;
  readonly onError?: (error: Error, input: FnInput<K>) => void;
  /** Toast errors with the error-table message (default true). */
  readonly toast?: boolean;
}

/** A write server function. Errors toast by default (04, Toasts). */
export function useCallMutation<K extends FnName>(
  name: K,
  options: CallMutationOptions<K> = {},
): UseMutationResult<FnOutput<K>, Error, FnInput<K>> {
  const queryClient = useQueryClient();
  const invoke = useContext(ApiCallContext);

  return useMutation<FnOutput<K>, Error, FnInput<K>>({
    mutationKey: ["call", name],
    mutationFn: (input) => invoke(name, input),
    onSuccess: async (output, input) => {
      if (options.invalidates?.length) await invalidateCalls(queryClient, ...options.invalidates);
      await options.onSuccess?.(output, input);
    },
    onError: (error, input) => {
      if (options.toast !== false) toastError(error);
      options.onError?.(error, input);
    },
  });
}
