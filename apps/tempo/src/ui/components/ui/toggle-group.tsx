import type { VariantProps } from "class-variance-authority";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { createContext, useContext } from "react";
import type * as React from "react";
import { toggleVariants } from "~/ui/components/ui/toggle";
import { cn } from "~/ui/lib/utils";

const ToggleGroupContext = createContext<VariantProps<typeof toggleVariants>>({ size: "default", variant: "default" });

/** A segmented control, for example Branch / Uncommitted or Unified / Split. */
function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn("group/toggle-group flex w-fit items-center rounded-md border p-px", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>) {
  const context = useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        toggleVariants({ variant: context.variant ?? variant, size: context.size ?? size }),
        "min-w-0 flex-1 shrink-0 rounded-sm shadow-none focus:z-10 focus-visible:z-10",
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
