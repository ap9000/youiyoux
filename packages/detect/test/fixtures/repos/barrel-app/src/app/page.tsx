// No components.json: the kit is found by its files and reached through a relative barrel.
import { Button, Dialog, DialogContent, Tabs, TabsList, TabsTrigger } from "../components/ui/index.js";
import { Toolbar } from "./toolbar.js";

export default function Page() {
  return (
    <Tabs defaultValue="runs">
      <TabsList>
        <TabsTrigger value="runs">Runs</TabsTrigger>
      </TabsList>
      <Toolbar />
      <Dialog>
        <DialogContent>
          <Button>Retry</Button>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
