import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api";
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
  },
});
export function useApi(path: string, enabled = true) {
  return useQuery({ queryKey: [path], queryFn: () => api(path), enabled });
}
export function useWrite(path: string, onSuccess?: (data: any) => void) {
  return useMutation({
    mutationFn: (body: unknown) => api(path, body),
    onSuccess: (data) => {
      void queryClient.invalidateQueries();
      onSuccess?.(data);
    },
  });
}
