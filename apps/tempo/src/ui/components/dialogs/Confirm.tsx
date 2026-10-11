import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/components/ui/alert-dialog";
import { Input } from "~/ui/components/ui/input";
import { useConfirmRequest } from "~/ui/hooks/useWorkspaceUi";
import { resolveConfirm, type ConfirmRequest } from "~/ui/state/workspace-ui";

/** Renders confirm() requests (04, Confirmations). With typeToConfirm, the text must match first. */
export function Confirm() {
  const req = useConfirmRequest();
  return (
    <AlertDialog open={req !== null} onOpenChange={(open) => !open && req && resolveConfirm(req.id, false)}>
      {req && <ConfirmBody key={req.id} req={req} />}
    </AlertDialog>
  );
}

function ConfirmBody({ req }: { req: ConfirmRequest }) {
  const [typed, setTyped] = useState("");
  const blocked = req.typeToConfirm !== undefined && typed !== req.typeToConfirm;
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{req.title}</AlertDialogTitle>
        {req.description && <AlertDialogDescription>{req.description}</AlertDialogDescription>}
      </AlertDialogHeader>
      {req.typeToConfirm !== undefined && (
        <Input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label={`Type ${req.typeToConfirm} to confirm`}
          placeholder={req.typeToConfirm}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !blocked) {
              e.preventDefault();
              resolveConfirm(req.id, true);
            }
          }}
        />
      )}
      <AlertDialogFooter>
        <AlertDialogCancel onClick={() => resolveConfirm(req.id, false)}>
          {req.cancelLabel ?? "Cancel"}
        </AlertDialogCancel>
        <AlertDialogAction
          variant={req.destructive ? "destructive" : "default"}
          disabled={blocked}
          onClick={() => resolveConfirm(req.id, true)}
        >
          {req.confirmLabel ?? "Confirm"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
