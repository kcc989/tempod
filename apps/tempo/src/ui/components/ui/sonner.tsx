import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "~/ui/hooks/useTheme";

interface ToastStyle extends React.CSSProperties {
  [variable: `--${string}`]: string;
}

const toastStyle: ToastStyle = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--error-bg": "var(--popover)",
  "--error-text": "var(--destructive)",
  "--error-border": "var(--border)",
  "--border-radius": "var(--radius)",
};

function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      position="bottom-right"
      closeButton
      toastOptions={{ classNames: { toast: "text-sm", description: "text-muted-foreground" } }}
      style={toastStyle}
      {...props}
    />
  );
}

export { Toaster };
