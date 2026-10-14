import { useState } from "react";
import { useCallQuery } from "~/ui/hooks/useCall";
import { ProjectList } from "./ProjectList";

/** 04, `/stars`: the caller's stars, most recent first. */
export function StarsPage() {
  const [offset, setOffset] = useState(0);
  const projects = useCallQuery("listStarredProjects", { offset });

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b px-6 py-5">
        <h1 className="text-xl font-semibold">Stars</h1>
      </header>
      <div className="p-6">
        <ProjectList
          query={projects}
          label="Starred projects"
          empty="Star a project to keep it here."
          offset={offset}
          onOffset={setOffset}
        />
      </div>
    </div>
  );
}
