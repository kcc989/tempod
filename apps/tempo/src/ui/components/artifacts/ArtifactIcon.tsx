import type { ArtifactKind } from "@tempo/protocol";
import {
  AppWindowIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  type LucideIcon,
} from "lucide-react";

export const ARTIFACT_ICONS: Readonly<Record<ArtifactKind, LucideIcon>> = {
  image: ImageIcon,
  markdown: FileTextIcon,
  pdf: FileIcon,
  html: AppWindowIcon,
  text: FileCodeIcon,
};

export function ArtifactIcon({ kind, className }: { kind: ArtifactKind; className?: string }) {
  const Icon = ARTIFACT_ICONS[kind];
  return <Icon aria-hidden className={className} />;
}
