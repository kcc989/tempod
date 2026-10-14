import type { TranscriptDetail } from "~/ui/components/chat/work-model";
import { readString, writeString } from "./storage";
import { Store, useStore } from "./store";

/** Settings → Appearance → Transcript detail (04). Kept per browser. */
export const DETAIL_KEY = "transcript-detail";

export const isTranscriptDetail = (u: unknown): u is TranscriptDetail => u === "default" || u === "detailed";

const read = (): TranscriptDetail => {
  const raw = readString(DETAIL_KEY);

  return isTranscriptDetail(raw) ? raw : "default";
};

let store: Store<TranscriptDetail> | null = null;

const detailStore = (): Store<TranscriptDetail> => (store ??= new Store<TranscriptDetail>(read()));

export const setTranscriptDetail = (detail: TranscriptDetail): void => {
  writeString(DETAIL_KEY, detail === "default" ? null : detail);
  detailStore().set(detail);
};

export const useTranscriptDetail = (): TranscriptDetail => useStore(detailStore());

/** Tests only. */
export const resetTranscriptDetail = (): void => {
  store = null;
};
