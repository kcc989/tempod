import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Building2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import {
  acceptInvitation,
  createOrganization,
  organizationsQueryOptions,
  rejectInvitation,
  slugFromName,
  userInvitationsQueryOptions,
  type UserInvitation,
} from "~/ui/organizations";

/** 04, `/organizations`: the caller's organizations, New organization and invitations. */
export function OrganizationsPage() {
  const organizations = useQuery(organizationsQueryOptions);
  const invitations = useQuery(userInvitationsQueryOptions);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b px-6 py-5">
        <h1 className="text-xl font-semibold">Organizations</h1>
      </header>
      <div className="flex max-w-3xl flex-col gap-8 p-6">
        <Invitations query={invitations} />
        <section aria-label="Your organizations" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Your organizations</h2>
          {organizations.isPending ? (
            <SkeletonRows rows={3} />
          ) : organizations.isError ? (
            <ErrorState error={organizations.error} onRetry={() => void organizations.refetch()} />
          ) : organizations.data.length === 0 ? (
            <EmptyState icon={Building2Icon} title="You are not in an organization yet." />
          ) : (
            <ul className="divide-y rounded-lg border">
              {organizations.data.map((o) => (
                <li key={o.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Building2Icon className="size-4 text-muted-foreground" />
                  <Link
                    to="/$namespace"
                    params={{ namespace: o.slug }}
                    className="font-medium text-primary hover:underline"
                  >
                    {o.name}
                  </Link>
                  <span className="text-muted-foreground">{o.slug}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <NewOrganization />
      </div>
    </div>
  );
}

function Invitations({ query }: { query: UseQueryResult<UserInvitation[], Error> }) {
  const queryClient = useQueryClient();

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: userInvitationsQueryOptions.queryKey }),
      queryClient.invalidateQueries({ queryKey: organizationsQueryOptions.queryKey }),
    ]);

  const decide = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      accept ? acceptInvitation(id) : rejectInvitation(id),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message),
  });

  if (!query.data || query.data.length === 0) return null;

  return (
    <section aria-label="Invitations" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Invitations</h2>
      <ul className="divide-y rounded-lg border">
        {query.data.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{i.organizationName}</span>
            <Badge variant="muted">{i.role}</Badge>
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: i.id, accept: true })}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: i.id, accept: false })}
            >
              Decline
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NewOrganization() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const shownSlug = slugEdited ? slug : slugFromName(name);

  const create = useMutation({
    mutationFn: () => createOrganization(name.trim(), shownSlug),
    onSuccess: async (organization) => {
      await queryClient.invalidateQueries({ queryKey: organizationsQueryOptions.queryKey });
      void navigate({ to: "/$namespace", params: { namespace: organization.slug } });
    },
  });

  const error = create.error?.message;

  return (
    <section aria-label="New organization" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">New organization</h2>
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();

          if (name.trim() && shownSlug && !create.isPending) create.mutate();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="organization-name">Name</Label>
          <Input
            id="organization-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="organization-slug">Slug</Label>
          <Input
            id="organization-slug"
            value={shownSlug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value.toLowerCase());
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "organization-error" : undefined}
            required
          />
          {error && (
            <p id="organization-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button
          type="submit"
          className="justify-self-start"
          disabled={!name.trim() || !shownSlug || create.isPending}
        >
          {create.isPending ? "Creating…" : "New organization"}
        </Button>
      </form>
    </section>
  );
}
