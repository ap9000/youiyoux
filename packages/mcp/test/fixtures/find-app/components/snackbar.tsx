import type { ReactNode } from "react";

type SnackbarProps = {
  message: ReactNode;
  action?: ReactNode;
  duration?: number;
};

export default function Snackbar({ message, action, duration = 4000 }: SnackbarProps) {
  return (
    <div role="status" data-duration={duration} className="fixed bottom-4 left-4 rounded bg-neutral-900 px-4 py-2 text-white">
      {message}
      {action}
    </div>
  );
}
