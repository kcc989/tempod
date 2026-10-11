import type { ErrorCode } from "@tempo/protocol";
import { useEffect } from "react";
import { showBanner } from "~/ui/lib/toast";

/** While `shown`, toasts for these codes are skipped because a banner shows them (04, Toasts). */
export function useBanner(codes: ReadonlyArray<ErrorCode>, shown: boolean): void {
  const key = codes.join(",");
  useEffect(() => {
    if (!shown || key === "") return;
    return showBanner(key.split(",") as ErrorCode[]);
  }, [key, shown]);
}
