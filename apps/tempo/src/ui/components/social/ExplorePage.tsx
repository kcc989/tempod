import { useState } from "react";
import { useCallQuery } from "~/ui/hooks/useCall";
import { ProjectList } from "./ProjectList";

/** 04, `/explore`: public projects, most stars first. */
export function ExplorePage() {
  const [offset, setOffset] = useState(0);
  const projects = useCallQuery("exploreProjects", { offset });

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b px-6 py-5">
        <h1 className="text-xl font-semibold">Explore</h1>
        <p className="mt-1 text-sm text-muted-foreground">Public projects, most starred first.</p>
      </header>
      <div className="p-6">
        <ProjectList
          query={projects}
          label="Public projects"
          empty="No public projects yet."
          offset={offset}
          onOffset={setOffset}
        />
      </div>
    </div>
  );
}
