import { Link } from "react-router";
import { Button } from "~/ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { Card, CardTitle } from "@lib/ui/card";
import { cn } from "~/lib/utils";

// @chakra-ui/react is declared in package.json and never imported.
export default function Settings() {
  return (
    <Card className={cn("w-80")}>
      <CardTitle>Settings</CardTitle>
      <Button>Save</Button>
      <Dialog>
        <DialogContent>Saved</DialogContent>
      </Dialog>
      <Link to="/">Home</Link>
    </Card>
  );
}
