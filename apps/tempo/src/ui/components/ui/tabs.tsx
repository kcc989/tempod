import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "~/ui/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}

/** `variant="line"` is the quiet underline style used by panel tab bars. */
function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: "default" | "line" }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        "group/tabs inline-flex w-fit items-center text-muted-foreground",
        variant === "default" && "h-7 justify-center rounded-md bg-muted p-0.5",
        variant === "line" && "h-8 gap-1 border-b",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-sm border border-transparent px-2 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        "hover:text-foreground data-[state=active]:text-foreground",
        "group-data-[variant=default]/tabs:data-[state=active]:bg-background group-data-[variant=default]/tabs:data-[state=active]:shadow-xs dark:group-data-[variant=default]/tabs:data-[state=active]:bg-input/30",
        "group-data-[variant=line]/tabs:flex-none group-data-[variant=line]/tabs:rounded-none group-data-[variant=line]/tabs:border-b-2 group-data-[variant=line]/tabs:-mb-px group-data-[variant=line]/tabs:data-[state=active]:border-b-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
