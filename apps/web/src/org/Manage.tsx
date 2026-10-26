/**
 * A workspace's admin pages, for its admins: who can read it (members, invited or in by its GitHub
 * organisation), whose CI sends it records (GitHub owners), and the CI tokens other CI sends them
 * with. Every addition and removal happens in a modal: a login typed, a token shown once, a removal
 * confirmed. Adding a workspace, or linking its GitHub organisation, stays the hub operator's
 * (`youiyoux hub workspace`).
 */
import { Building2, KeyRound, Trash2, TriangleAlert, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { OrgRequestError, orgApi, type GithubAccount, type Member, type Role, type WorkspaceAdmin } from "../data/org.ts";
import { plural } from "../lib/plural.ts";
import { when } from "../lib/when.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { CopyButton } from "../ui/CopyButton.tsx";
import { Field, Select, TextInput } from "../ui/Field.tsx";
import { Modal } from "../ui/Modal.tsx";
import { PaneSkeleton } from "../ui/Pane.tsx";
import { Section } from "../ui/Section.tsx";
import { Segmented } from "../ui/Segmented.tsx";

const mono = "font-mono text-mono-sm";
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Open =
  | { kind: "invite" }
  | { kind: "owner" }
  | { kind: "token" }
  | { kind: "remove-member"; member: Member }
  | { kind: "remove-owner"; owner: GithubAccount }
  | { kind: "remove-token"; name: string };

/** A person's or an organisation's initial, in a quiet circle: GitHub's avatars are another site's, and the hub loads nothing from one. */
function Initial({ login }: { login: string }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line bg-raised text-caption font-medium text-ink-2 uppercase" aria-hidden>
      {login.slice(0, 1)}
    </span>
  );
}

function Rows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-line overflow-hidden rounded-lg border border-line">
      {children}
    </ul>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-4 py-5 text-small text-muted">{children}</p>;
}

/** The removal button at the end of a row. */
function Remove({ label, onClick, disabled, title }: { label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" aria-label={label} title={title ?? label} onClick={onClick} disabled={disabled} className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors duration-100 hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40 max-md:size-11">
      <Trash2 className="size-3.5" />
    </button>
  );
}

/** The one form every adding modal is: a field, its error, a submit that waits for the hub. */
function useSubmit<T>(run: () => Promise<T>, done: (result: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    run().then(
      (result) => {
        setBusy(false);
        done(result);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(message(failure));
      },
    );
  };
  return { busy, error, submit };
}

function InviteModal({ data, onClose, onDone }: { data: WorkspaceAdmin; onClose: () => void; onDone: (note: string) => void }) {
  const [account, setAccount] = useState("");
  const [role, setRole] = useState<Role>("member");
  const { busy, error, submit } = useSubmit(
    () => orgApi.invite(data.workspace.id, account.trim(), role),
    ({ member }) => onDone(`Invited ${member.login} as ${member.role === "admin" ? "an admin" : "a member"}. The hub sends nothing: tell them its address, and they sign in with GitHub.`),
  );
  return (
    <Modal
      title={`Invite to ${data.workspace.name}`}
      description="Someone with a GitHub account. They read the workspace once they sign in with it."
      icon={UserPlus}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || account.trim() === ""}>
            {busy ? "Inviting…" : "Invite"}
          </Button>
        </>
      }
    >
      <Field label="GitHub login" error={error}>
        {(id, describedBy) => <TextInput id={id} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="octocat" aria-describedby={describedBy} aria-invalid={error ? true : undefined} autoFocus className="max-md:h-11" />}
      </Field>
      <div className="space-y-1.5">
        <span className="block text-small font-medium text-ink-2">Role</span>
        <Segmented
          label="Role"
          value={role}
          onChange={setRole}
          touch
          options={[
            { value: "member", label: "Member" },
            { value: "admin", label: "Admin" },
          ]}
        />
        <p className="text-small text-muted">{role === "admin" ? "Reads the workspace, and manages its members, owners and CI tokens." : "Reads the workspace: every repository's latest record."}</p>
      </div>
    </Modal>
  );
}

function OwnerModal({ data, onClose, onDone }: { data: WorkspaceAdmin; onClose: () => void; onDone: (note: string) => void }) {
  const [account, setAccount] = useState("");
  const { busy, error, submit } = useSubmit(
    () => orgApi.addOwner(data.workspace.id, account.trim()),
    ({ owner }) => onDone(`${owner.login}'s repositories now send their records here from GitHub Actions.`),
  );
  return (
    <Modal
      title="Add a GitHub owner"
      description="An organisation or account. GitHub Actions in its repositories then send their records here, each proving which repository it comes from: no secret to share."
      icon={Building2}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || account.trim() === ""}>
            {busy ? "Adding…" : "Add owner"}
          </Button>
        </>
      }
    >
      <Field label="GitHub owner" error={error} hint="Its login, as in github.com/acme.">
        {(id, describedBy) => <TextInput id={id} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="acme" aria-describedby={describedBy} aria-invalid={error ? true : undefined} autoFocus className="max-md:h-11" />}
      </Field>
    </Modal>
  );
}

/** Name a CI token, then see it once, in the same modal: the hub keeps only its hash. */
function TokenModal({ data, onClose, onMade }: { data: WorkspaceAdmin; onClose: () => void; onMade: () => void }) {
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const { busy, error, submit } = useSubmit(
    () => orgApi.addToken(data.workspace.id, name.trim()),
    (result) => {
      setMade(result);
      onMade();
    },
  );
  if (made) {
    return (
      <Modal
        title={`Copy the ${made.name} token now`}
        description="It is shown this once. The hub keeps only its hash, so a lost token is removed and made again."
        icon={KeyRound}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose} autoFocus>
            Done
          </Button>
        }
      >
        <div className="flex items-center gap-2 rounded-md border border-line bg-sunken py-2 pr-2 pl-3">
          <code className={`${mono} min-w-0 flex-1 break-all text-ink`} aria-label={`The ${made.name} token`}>
            {made.token}
          </code>
          <CopyButton value={made.token} label="Copy the token" className="max-md:size-11" />
        </div>
        <p className="text-small text-ink-2">
          In that CI, set <span className={`${mono} text-ink`}>YOUIYOUX_HUB_TOKEN</span> to it, and <span className={`${mono} text-ink`}>YOUIYOUX_HUB_URL</span> to this hub's address. Its records come to {data.workspace.name}.
        </p>
      </Modal>
    );
  }
  return (
    <Modal
      title="New CI token"
      description="For CI other than GitHub Actions, which proves its repository without one. Whoever holds the token can send records for any repository."
      icon={KeyRound}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || name.trim() === ""}>
            {busy ? "Making…" : "Make token"}
          </Button>
        </>
      }
    >
      <Field label="Name" error={error} hint="Which CI holds it, e.g. jenkins or buildkite.">
        {(id, describedBy) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="jenkins" aria-describedby={describedBy} aria-invalid={error ? true : undefined} autoFocus className={`${mono} max-md:h-11`} />}
      </Field>
    </Modal>
  );
}

/** Confirm a removal: what goes, and what follows from it. */
function RemoveModal({ title, children, verb, onClose, run, onDone }: { title: string; children: ReactNode; verb: string; onClose: () => void; run: () => Promise<string>; onDone: (note: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const confirm = (): void => {
    setBusy(true);
    setError(undefined);
    run().then(onDone, (failure: unknown) => {
      setBusy(false);
      setError(message(failure));
    });
  };
  return (
    <Modal
      title={title}
      description={children}
      icon={TriangleAlert}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} disabled={busy}>
            <Trash2 /> {busy ? "Removing…" : verb}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

export function Manage({ id, onYouChanged }: { id: string; onYouChanged: () => void }) {
  const [data, setData] = useState<WorkspaceAdmin | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const read = useCallback(() => {
    orgApi.admin(id).then(
      (next) => {
        setData(next);
        setFailure(null);
      },
      (error: unknown) => (error instanceof OrgRequestError && (error.status === 401 || error.status === 403 || error.status === 404) ? onYouChanged() : setFailure(message(error))),
    );
  }, [id, onYouChanged]);
  useEffect(read, [read]);

  if (failure) {
    return (
      <p role="alert" className="px-8 py-8 text-small text-danger">
        {failure}
      </p>
    );
  }
  if (!data) return <PaneSkeleton />;
  const { workspace, members, owners, tokens } = data;
  const admins = members.filter((m) => m.role === "admin").length;
  const close = (): void => setOpen(null);
  const done = (text: string): void => {
    setOpen(null);
    setNote(text);
    read();
  };
  const changeRole = (member: Member, role: Role): void => {
    setNote(null);
    orgApi.setRole(workspace.id, member.githubId, role).then(
      () => (member.githubId === data.you ? onYouChanged() : done(`${member.login} is ${role === "admin" ? "an admin" : "a member"} now.`)),
      (error: unknown) => setNote(message(error)),
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 space-y-10 px-8 py-10 animate-enter max-md:px-4 max-md:py-6">
      <div className="space-y-2">
        <p className="text-title text-ink-2">
          <span className="tabular text-ink">{plural(members.length, "member")}</span> {members.length === 1 ? "reads" : "read"} {workspace.name}; CI from <span className="tabular text-ink">{plural(owners.length, "GitHub owner")}</span> and <span className="tabular text-ink">{plural(tokens.length, "token")}</span> send it records.
        </p>
        <p className="text-small text-muted">
          {workspace.githubOrg ? (
            <>
              Active members of the <span className={`${mono} text-ink`}>{workspace.githubOrg.login}</span> GitHub organisation come in when they sign in, and leave when they leave it.
            </>
          ) : (
            "Only the people invited here can read it."
          )}
        </p>
        {note && (
          <p role="status" className="text-small text-ink-2">
            {note}
          </p>
        )}
      </div>

      <Section
        title="Members"
        count={members.length}
        aside={
          <Button size="sm" onClick={() => setOpen({ kind: "invite" })} className="max-md:h-11">
            <UserPlus /> Invite
          </Button>
        }
      >
        {members.length === 0 ? (
          <Empty>Nobody yet.</Empty>
        ) : (
          <Rows label="Members">
            {members.map((m) => {
              const lastAdmin = m.role === "admin" && admins === 1;
              const why = lastAdmin ? `${m.login} is the only admin: make someone else an admin first` : undefined;
              return (
                <li key={m.githubId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <Initial login={m.login} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`${mono} text-ink`}>{m.login}</span>
                      {m.githubId === data.you && <Badge>You</Badge>}
                    </div>
                    <p className="text-caption text-muted">{m.via === "org" ? `From the ${workspace.githubOrg?.login ?? "GitHub"} organisation · since ${when(m.addedAt)}` : `Invited · ${when(m.addedAt)}`}</p>
                  </div>
                  <div className="flex items-center gap-1 max-sm:w-full max-sm:pl-10">
                    <div className="w-28 max-sm:flex-1">
                      <Select aria-label={`${m.login}'s role`} value={m.role} disabled={lastAdmin} title={why} onChange={(e) => changeRole(m, e.target.value as Role)} className="h-7 max-md:h-11">
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </Select>
                    </div>
                    <Remove label={`Remove ${m.login}`} disabled={lastAdmin} {...(why ? { title: why } : {})} onClick={() => setOpen({ kind: "remove-member", member: m })} />
                  </div>
                </li>
              );
            })}
          </Rows>
        )}
        {admins === 1 && <p className="text-caption text-muted">A workspace keeps at least one admin: to step down, make someone else one first.</p>}
      </Section>

      <Section
        title="GitHub owners"
        count={owners.length}
        aside={
          <Button size="sm" onClick={() => setOpen({ kind: "owner" })} className="max-md:h-11">
            <Building2 /> Add owner
          </Button>
        }
      >
        <p className="text-small text-muted">GitHub Actions in these owners' repositories send their records here, each proving which repository it comes from.</p>
        {owners.length === 0 ? (
          <Empty>None yet: records from GitHub Actions are refused until an owner is added.</Empty>
        ) : (
          <Rows label="GitHub owners">
            {owners.map((o) => (
              <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                <Initial login={o.login} />
                <span className={`${mono} min-w-0 flex-1 truncate text-ink`}>{o.login}</span>
                <span className={`${mono} text-muted max-sm:hidden`}>id {o.id}</span>
                <Remove label={`Remove ${o.login}`} onClick={() => setOpen({ kind: "remove-owner", owner: o })} />
              </li>
            ))}
          </Rows>
        )}
      </Section>

      <Section
        title="CI tokens"
        count={tokens.length}
        aside={
          <Button size="sm" onClick={() => setOpen({ kind: "token" })} className="max-md:h-11">
            <KeyRound /> New token
          </Button>
        }
      >
        <p className="text-small text-muted">For CI other than GitHub Actions. Each is shown once, when it is made; the hub keeps only its hash.</p>
        {tokens.length === 0 ? (
          <Empty>None. GitHub Actions needs none.</Empty>
        ) : (
          <Rows label="CI tokens">
            {tokens.map((name) => (
              <li key={name} className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line bg-raised text-muted" aria-hidden>
                  <KeyRound className="size-3.5" />
                </span>
                <span className={`${mono} min-w-0 flex-1 truncate text-ink`}>{name}</span>
                <Remove label={`Remove the ${name} token`} onClick={() => setOpen({ kind: "remove-token", name })} />
              </li>
            ))}
          </Rows>
        )}
      </Section>

      <p className="border-t border-line pt-6 text-small text-muted">
        Adding or removing a workspace, and linking its GitHub organisation, is for whoever runs the hub: <span className={`${mono} text-ink`}>youiyoux hub workspace</span>.
      </p>

      {open?.kind === "invite" && <InviteModal data={data} onClose={close} onDone={done} />}
      {open?.kind === "owner" && <OwnerModal data={data} onClose={close} onDone={done} />}
      {open?.kind === "token" && <TokenModal data={data} onClose={close} onMade={read} />}
      {open?.kind === "remove-member" &&
        (() => {
          const { member } = open;
          const self = member.githubId === data.you;
          return (
            <RemoveModal
              title={self ? `Leave ${workspace.name}?` : `Remove ${member.login} from ${workspace.name}?`}
              verb={self ? "Leave" : "Remove"}
              onClose={close}
              run={() => orgApi.removeMember(workspace.id, member.githubId).then((r) => `Removed ${r.removed}.${r.returns ? ` ${r.returns[0]!.toUpperCase()}${r.returns.slice(1)}.` : ""}`)}
              onDone={(text) => (self ? onYouChanged() : done(text))}
            >
              {self ? "You stop reading it at once; an admin can invite you again." : member.via === "org" ? `They stop reading it at once, and come back at their next sign-in while they are in ${workspace.githubOrg?.login ?? "its organisation"}.` : "They stop reading it at once."}
            </RemoveModal>
          );
        })()}
      {open?.kind === "remove-owner" && (
        <RemoveModal title={`Remove ${open.owner.login}?`} verb="Remove" onClose={close} run={() => orgApi.removeOwner(workspace.id, open.owner.id).then(() => `Removed ${open.owner.login}: its CI's records are refused from now on.`)} onDone={done}>
          Records from its repositories' GitHub Actions are refused from now on. The records already here stay.
        </RemoveModal>
      )}
      {open?.kind === "remove-token" && (
        <RemoveModal title={`Remove the ${open.name} token?`} verb="Remove" onClose={close} run={() => orgApi.removeToken(workspace.id, open.name).then(() => `Removed the ${open.name} token: records sent with it are refused from now on.`)} onDone={done}>
          Records sent with it are refused from now on. The records already here stay.
        </RemoveModal>
      )}
    </div>
  );
}
