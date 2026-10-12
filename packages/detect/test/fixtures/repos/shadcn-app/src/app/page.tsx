// We moved off "@mui/material" and styled-components; this comment must not count as an import.
import type { Theme } from "@mui/material";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Icon } from "../components/icon";

export const legacyTheme: Theme | null = null;
const note = "import styled from 'styled-components'";

export default function Page() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" title={note}>
          <Icon /> Open
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}
