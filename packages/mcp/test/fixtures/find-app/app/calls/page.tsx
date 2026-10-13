import * as notices from "@/components/notice";
import * as messages from "@/components/ui/sonner";
import { toast as notify, toast } from "@/components/ui/sonner";
export default function Calls() {
  const show = notices.useNotice();
  const save = (): void => {
    notify("Saved via alias");
    messages.toast.success("Saved via namespace");
    toast.success("Saved");
  };
  return <button type="button" onClick={() => { show("Hi"); notices.showNotice(); save(); }}>Notify</button>;
}
