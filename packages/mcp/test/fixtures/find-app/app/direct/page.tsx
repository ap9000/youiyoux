import { toast } from "sonner";
import { alertTone } from "@/components/alert";
import { Modal } from "@/components/modal";

export default function Direct({ ok }: { ok: boolean }) {
  return (
    <Modal open={false} onOpenChange={() => (ok ? toast.success : toast.error)(alertTone("danger"))} title="Plan" className="card">
      <p>Upgrade</p>
    </Modal>
  );
}
