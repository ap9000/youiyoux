import { Button as Action } from "@/components/ui/button";
import * as ui from "@/components/ui";
import { Button as LegacyButton } from "@/components/legacy/button";
import { buttonVariants } from "@/components/ui/button";
export default function Settings({ Comp }: { Comp: () => null }) {
  return <section>
    <Action variant="ghost">Reset</Action>
    <ui.Button variant="outline">Export</ui.Button>
    <LegacyButton kind="primary">Old</LegacyButton>
    <Comp />
    <a className={buttonVariants({ variant: "link" })} href="/help">Help</a>
  </section>;
}
