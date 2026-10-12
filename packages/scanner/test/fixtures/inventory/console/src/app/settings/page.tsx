import { Badge } from "@/components/legacy/badge";
import { LegacyButton, LegacyIconButton } from "@/components/legacy/legacy-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Half migrated: this screen still mixes the legacy kit's button with the CVA kit's. */
export default function SettingsPage() {
  return (
    <form className="space-y-4 p-8">
      <Input name="name" />
      <Badge>Beta</Badge>
      <Button type="submit">Save</Button>
      <LegacyButton type="reset">Reset</LegacyButton>
      <LegacyIconButton aria-label="Undo">↺</LegacyIconButton>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost">Delete…</Button>
        </DialogTrigger>
        <DialogContent>Are you sure?</DialogContent>
      </Dialog>
    </form>
  );
}
