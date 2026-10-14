import type { FnInput, Project, ProjectVisibility } from "@tempo/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation } from "~/ui/hooks/useCall";
import { errorText } from "~/ui/lib/toast";
import { organizationsQueryOptions } from "~/ui/organizations";
import { importUrlError, isSubmitShortcut } from "./model";

export function RepositoryForm({ onSuccess }: { onSuccess?: (project: Project) => void }) {
  const [mode, setMode] = useState("create");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [branch, setBranch] = useState("main");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const [visibility, setVisibility] = useState<ProjectVisibility>("private");
  const organizations = useQuery(organizationsQueryOptions);
  const options = { invalidates: ["listProjects"] as const, onSuccess };
  const create = useCallMutation("createRepository", options);
  const importRepo = useCallMutation("importRepository", options);

  const link = useCallMutation("linkArtifactRepository", {
    ...options,
    toast: false,
    onError: (cause) => setError(errorText(cause)),
  });

  const pending = create.isPending || importRepo.isPending || link.isPending;

  const submit = () => {
    if (pending) return;

    if (!name.trim()) {
      setError("Enter a repository name.");

      return;
    }

    if (mode === "import") {
      const invalid = importUrlError(url.trim());

      if (invalid) {
        setError(invalid);

        return;
      }
    }

    setError(null);

    let common: Pick<
      FnInput<"createRepository">,
      "name" | "description" | "organizationId" | "visibility"
    > = {
      name: name.trim(),
      visibility,
    };

    if (description.trim()) common = { ...common, description: description.trim() };

    if (owner) common = { ...common, organizationId: owner };

    if (mode === "import") importRepo.mutate({ ...common, url: url.trim() });
    else if (mode === "link") link.mutate({ name: name.trim() });
    else create.mutate({ ...common, defaultBranch: branch.trim() || "main" });
  };

  return (
    <form
      className="grid gap-4"
      onKeyDown={(event) => {
        if (isSubmitShortcut(event)) {
          event.preventDefault();
          submit();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Tabs
        value={mode}
        onValueChange={(next) => {
          setMode(next);
          setError(null);
        }}
      >
        <TabsList className="w-full" aria-label="Repository source">
          <TabsTrigger value="create">Create</TabsTrigger>
          <TabsTrigger value="import">Import</TabsTrigger>
          <TabsTrigger value="link">Existing Artifacts repo</TabsTrigger>
        </TabsList>
      </Tabs>
      {mode !== "link" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="repo-owner">Owner</Label>
            <Select value={owner || "me"} onValueChange={(next) => setOwner(next === "me" ? "" : next)}>
              <SelectTrigger id="repo-owner">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">You</SelectItem>
                {organizations.data?.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="repo-visibility">Visibility</Label>
            <Select
              value={visibility}
              onValueChange={(next) => (next === "public" || next === "private") && setVisibility(next)}
            >
              <SelectTrigger id="repo-visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private</SelectItem>
                <SelectItem value="public">Public</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="repo-name">Repository name</Label>
        <Input
          id="repo-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          autoFocus
          required
        />
      </div>
      {mode === "import" && (
        <div className="grid gap-1.5">
          <Label htmlFor="repo-url">Git URL</Label>
          <Input
            id="repo-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repository.git"
            required
          />
          <p className="text-xs text-muted-foreground">
            Import a public HTTPS Git repository into your Artifacts namespace.
          </p>
        </div>
      )}
      {mode !== "link" && (
        <div className="grid gap-1.5">
          <Label htmlFor="repo-description">Description</Label>
          <Textarea
            id="repo-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you building?"
          />
        </div>
      )}
      {mode === "create" && (
        <div className="grid gap-1.5">
          <Label htmlFor="repo-branch">Default branch</Label>
          <Input id="repo-branch" value={branch} onChange={(e) => setBranch(e.target.value)} required />
        </div>
      )}
      {mode === "link" && (
        <p className="text-sm text-muted-foreground">
          Add a repository already hosted in your Cloudflare Artifacts namespace.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending
          ? "Working…"
          : mode === "create"
            ? "Create repository"
            : mode === "import"
              ? "Import repository"
              : "Add repository"}
      </Button>
    </form>
  );
}
