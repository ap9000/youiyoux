/**
 * A change on one component going into the code: shown first (the element's lines before and
 * after, from the local service), then written only while the file is still the one shown. What
 * can't be written that way (a value computed in code, props spread in, no file and line) says why
 * and is filed as an exact change request instead. The Edit tab and an agent's options both end
 * here.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { RequestDoc, RequestTarget } from "@youiyoux/core";
import { asRequestError, workflowApi, type LiveCodeEdit, type LiveCodeEditInput, type WorkflowRequestError } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";

interface Props {
  /** The edit for the code, or null when the capture found no file and line for it. */
  edit: Omit<LiveCodeEditInput, "write"> | null;
  name: string;
  target: RequestTarget;
  /** The change in words, for the request it can be filed as. */
  words: string;
  /** Nothing to write yet. */
  empty: boolean;
  onWritten: (at: string) => void;
  onFiled: (request: RequestDoc) => void;
  /** Buttons before these, such as Reset. */
  before?: ReactNode;
}

export function WriteToCode({ edit, name, target, words, empty, onWritten, onFiled, before }: Props) {
  const [shown, setShown] = useState<Extract<LiveCodeEdit, { ok: true }> | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WorkflowRequestError | null>(null);
  // A different change is shown again before it is written.
  const key = JSON.stringify(edit);
  useEffect(() => {
    setShown(null);
    setRefused(null);
  }, [key]);

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    work()
      .catch((e: unknown) => setError(asRequestError(e)))
      .finally(() => setBusy(false));
  };
  const show = (): void => run(async () => {
    const result = await workflowApi.liveEdit(edit!);
    if (result.ok) setShown(result);
    else setRefused(result.why);
  });
  const write = (): void => run(async () => {
    const result = await workflowApi.liveEdit({ ...edit!, write: { hash: shown!.hash } });
    if (!result.ok) return setRefused(result.why);
    onWritten(`${result.file}:${result.line}`);
  });
  const file = (): void => run(async () => onFiled(await workflowApi.fileRequest("change", words, target)));

  return (
    <>
      {shown && (
        <div className="space-y-2" data-live-edit="shown">
          <CodeBlock code={shown.before} title={`${shown.file}:${shown.line} now`} maxHeight="sm" />
          <CodeBlock code={shown.after} title="after" maxHeight="sm" />
        </div>
      )}
      {refused && (
        <p className="text-small text-muted" data-live-edit="refused">
          This can&rsquo;t be written for you: {refused}.
        </p>
      )}
      {!edit && !empty && <p className="text-small text-muted">The capture found no file and line for {name}, so this can&rsquo;t be written for you.</p>}
      {error && (
        <p className="text-small text-danger" role="alert">
          {error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {before}
        {(refused || !edit) && (
          <Button size="sm" variant="outline" disabled={empty || busy} onClick={file}>
            File as change request
          </Button>
        )}
        {edit && !refused && (
          <Button size="sm" variant="primary" disabled={empty || busy} onClick={shown ? write : show}>
            {shown ? `Write to ${shown.file}` : "Write to code"}
          </Button>
        )}
      </div>
    </>
  );
}
