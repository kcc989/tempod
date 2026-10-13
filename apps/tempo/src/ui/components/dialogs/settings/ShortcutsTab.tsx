import { formatRow, isMacPlatform, SHORTCUT_ROWS } from "~/ui/lib/shortcuts";

/** Settings → Shortcuts (04): the shortcut table, read-only. */
export function ShortcutsTab() {
  const mac = isMacPlatform();
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Keyboard shortcuts</caption>
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th scope="col" className="py-1 font-medium">
            Action
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            Tempo
          </th>
          <th scope="col" className="py-1 pl-3 text-right font-medium">
            Mac
          </th>
        </tr>
      </thead>
      <tbody>
        {SHORTCUT_ROWS.map((r) => (
          <tr key={r.action} className="border-b last:border-0">
            <td className="py-1">{r.action}</td>
            <td className="py-1 text-right font-mono text-xs text-muted-foreground">{formatRow(r, mac)}</td>
            <td className="py-1 pl-3 text-right font-mono text-xs text-muted-foreground">{r.mac}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
